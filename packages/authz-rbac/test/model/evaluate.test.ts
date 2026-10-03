import { AuthzConfigError, DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, PermissionRegistryImpl, TRUE, compileFieldGlobs } from '@spinajs/authz';
import type { Assignment, FieldSet, PermissionInput, Principal, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, userPrincipal, withCeiling, withCompanions } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MAX_UNDER_SCOPES, MemoryAssignmentStore, MemoryRoleStore, RBAC_STEPS, RBAC_STEP_NAMES, compileGrants, compileRoles, gatherRbacInput, rbacAssignmentExtension, runRbacPipeline } from '../../src/index.js';
import type { RbacExtension, RbacInput, RbacState, RbacSteps, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly string[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });
const assignment = (id: string, roleName: string, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope: GLOBAL, source: 'test', ...extra });

const ROLES = [role('viewer', ['file:read']), role('writer', ['file:write']), role('editor', [], { extends: ['viewer', 'writer'] })];

function input(assignments: readonly Assignment[], permission: string, opts: { roles?: readonly RoleDef[]; permissions?: readonly (string | PermissionInput)[]; onUnknownRole?: (a: Assignment) => void } = {}): RbacInput {
  const registry = new PermissionRegistryImpl();
  registry.register(
    (opts.permissions ?? ['file:read', 'file:write', 'file:delete']).map((p) => (typeof p === 'string' ? { name: p } : p)),
    'test',
  );
  registry.freeze();
  const roles = compileRoles(opts.roles ?? ROLES);
  return { request: { principal: alice, permission, resource: f1 }, now: NOW, path: [GLOBAL], assignments, roles, grants: compileGrants(roles, registry), onUnknownRole: opts.onUnknownRole };
}

async function rejects(p: Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect((err as Error).message).to.match(message);
    return;
  }
  throw new Error('expected a rejection');
}

const NO_ACCESS = { code: 'no_access', priority: DEFAULT_DENY_PRIORITY.no_access };

const withGrantsOf = (name: string, grants: RoleDef['grants']): RoleDef => ({ ...role(name), grants });

/** The default table with some steps replaced. */
const withSteps = (replace: Partial<RbacSteps>): RbacSteps => ({ ...RBAC_STEPS, ...replace });

describe('authz-rbac model: the evaluation pipeline', () => {
  describe('default steps', () => {
    it('a global assignment whose role grants the permission permits it unconditionally', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'viewer')], 'file:read'));
      expect(vote.model).to.equal('rbac');
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.denyWhen).to.deep.equal(FALSE);
      expect(vote.reason).to.equal(undefined);
      expect(vote.denies).to.equal(undefined);
      expect(vote.roles).to.deep.equal({});
      expect(vote.cacheable).to.equal(true);
      expect(vote.validUntil).to.equal(undefined);
    });

    it('the permissions are the union over every global assignment (H1)', () => {
      const both = [assignment('a1', 'viewer'), assignment('a2', 'writer')];
      expect(runRbacPipeline(input(both, 'file:read')).permitWhen).to.deep.equal(TRUE);
      expect(runRbacPipeline(input(both, 'file:write')).permitWhen).to.deep.equal(TRUE);
      expect(runRbacPipeline(input(both, 'file:delete')).permitWhen).to.deep.equal(FALSE);
    });

    it('a role passes on the grants of the roles it extends', () => {
      expect(runRbacPipeline(input([assignment('a1', 'editor')], 'file:write')).permitWhen).to.deep.equal(TRUE);
    });

    it('no assignment: a permit of FALSE with reason no_access, never a deny', () => {
      const vote = runRbacPipeline(input([], 'file:read'));
      expect(vote.permitWhen).to.deep.equal(FALSE);
      expect(vote.denyWhen).to.deep.equal(FALSE);
      expect(vote.denies).to.equal(undefined);
      expect(vote.reason).to.deep.equal(NO_ACCESS);
    });

    it('a role without the permission gives no_access', () => {
      expect(runRbacPipeline(input([assignment('a1', 'viewer')], 'file:write')).reason).to.deep.equal(NO_ACCESS);
    });

    it('collect keeps only the assignments whose scope is on the path', () => {
      const scoped = [assignment('a1', 'viewer', { scope: { type: 'project', id: 'p1' } })];
      expect(runRbacPipeline(input(scoped, 'file:read')).reason).to.deep.equal(NO_ACCESS);
      const onPath = { ...input(scoped, 'file:read'), path: [f1, { type: 'project', id: 'p1' }, GLOBAL] };
      expect(runRbacPipeline(onPath).permitWhen).to.deep.equal(TRUE);
    });

    it('an expired assignment is not collected, even if a store returns it', () => {
      expect(runRbacPipeline(input([assignment('a1', 'viewer', { expiresAt: new Date(NOW.getTime() - 1) })], 'file:read')).reason).to.deep.equal(NO_ACCESS);
      expect(runRbacPipeline(input([assignment('a1', 'viewer', { expiresAt: new Date(NOW.getTime() + 1) })], 'file:read')).permitWhen).to.deep.equal(TRUE);
    });

    it('an assignment of a role the graph does not hold is ignored and reported', () => {
      const unknown: Assignment[] = [];
      const vote = runRbacPipeline(input([assignment('g1', 'ghost'), assignment('a1', 'viewer')], 'file:read', { onUnknownRole: (a) => unknown.push(a) }));
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(unknown.map((a) => a.id)).to.deep.equal(['g1']);
    });

    it('one candidate per grant, with every live assignment that reaches it', () => {
      let seen: RbacState | undefined;
      runRbacPipeline(
        input([assignment('a1', 'viewer'), assignment('a2', 'editor')], 'file:read'),
        withSteps({
          tag: (s) => {
            seen = s;
          },
        }),
      );
      expect(seen!.candidates).to.have.length(1);
      expect(seen!.candidates[0].grant.role).to.equal('viewer');
      expect(seen!.candidates[0].holders.map((h) => h.assignment.id)).to.deep.equal(['a1', 'a2']);
      expect(seen!.live.map((l) => l.role)).to.deep.equal(['viewer', 'editor']);
    });
  });

  describe('hooks', () => {
    it('runs the nine steps of design §6.1.2 in order', () => {
      const ran: string[] = [];
      const recording = { ...Object.fromEntries(RBAC_STEP_NAMES.map((name) => [name, () => void ran.push(name)])), noGrantReason: () => ({ code: 'none' }) } as unknown as RbacSteps;
      runRbacPipeline(input([assignment('a1', 'viewer')], 'file:read'), recording);
      expect(ran).to.deep.equal(['collect', 'restrict', 'cap', 'aggregate', 'grant', 'tag', 'provenance', 'threshold', 'residual']);
      expect(Object.keys(RBAC_STEPS)).to.deep.equal([...ran, 'noGrantReason']);
      expect(Object.isFrozen(RBAC_STEPS)).to.equal(true);
    });

    it('a step that refuses a candidate takes its permit away and gives its reason', () => {
      const vote = runRbacPipeline(
        input([assignment('a1', 'viewer')], 'file:read'),
        withSteps({
          tag: (s) => {
            for (const c of s.candidates) {
              c.failed = true;
              s.reasons.push({ code: 'tag_missing', tag: 'code', priority: DEFAULT_DENY_PRIORITY.tag_missing });
            }
          },
        }),
      );
      expect(vote.permitWhen).to.deep.equal(FALSE);
      expect(vote.denyWhen).to.deep.equal(FALSE);
      expect(vote.reason).to.deep.equal({ code: 'tag_missing', tag: 'code', priority: 420 });
    });

    it('a deny entry becomes denyWhen and denies; Vote.reason stays the non-permit reason', () => {
      const branch = { code: 'branch_protected', priority: 300, sortKey: 'a*' };
      const vote = runRbacPipeline(
        input([], 'file:read'),
        withSteps({
          threshold: (s) => {
            s.denies.push({ when: TRUE, reason: branch });
            s.denies.push({ when: FALSE, reason: { code: 'never', priority: 1 } });
          },
        }),
      );
      expect(vote.denyWhen).to.deep.equal(TRUE);
      expect(vote.denies).to.deep.equal([{ when: TRUE, reason: branch }]);
      expect(vote.reason).to.deep.equal(NO_ACCESS);
    });

    it('noGrantReason replaces no_access when no grant is reachable', () => {
      const tooLow = { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor', priority: 410 };
      expect(runRbacPipeline(input([], 'file:read'), withSteps({ noGrantReason: () => tooLow })).reason).to.deep.equal(tooLow);
      expect(runRbacPipeline(input([assignment('a1', 'viewer')], 'file:read'), withSteps({ noGrantReason: () => tooLow })).reason).to.equal(undefined);
    });

    it('no reason while some grant permits, even if another one failed', () => {
      const vote = runRbacPipeline(
        input([assignment('a1', 'viewer')], 'file:read', { roles: [role('viewer', ['file:read', 'file:*'])] }),
        withSteps({
          tag: (s) => {
            s.candidates[0].failed = true;
            s.reasons.push({ code: 'tag_missing', tag: 'x' });
          },
        }),
      );
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.reason).to.equal(undefined);
    });

    it('aggregate fills Vote.roles, and the state carries fields and validUntil to the vote', () => {
      const until = new Date(NOW.getTime() + 60_000);
      const vote = runRbacPipeline(
        input([assignment('a1', 'viewer')], 'file:read'),
        withSteps({
          aggregate: (s) => {
            s.roles.project = 'viewer';
            s.validUntil = until;
            s.fields = { read: ['name'] };
          },
        }),
      );
      expect(vote.roles).to.deep.equal({ project: 'viewer' });
      expect(vote.validUntil).to.deep.equal(until);
      expect(vote.fields).to.deep.equal({ read: ['name'] });
    });
  });

  describe('relation residuals (B15)', () => {
    const rel = (relation: string) => ({ op: 'relation' as const, relation });
    const withGrants = (name: string, grants: RoleDef['grants']): RoleDef => ({ ...role(name), grants });
    const RELATION_ROLES = [
      withGrants('owner-reader', [{ permission: 'file:read', relation: 'owner' }]),
      withGrants('either', [{ permission: 'file:read', relation: ['owner', 'member'] }]),
      withGrants('two-grants', [
        { permission: 'file:read', relation: 'owner' },
        { permission: 'file:read', relation: 'member' },
      ]),
      withGrants('member-reader', [{ permission: 'file:read', relation: 'member' }]),
      role('reader', ['file:read']),
    ];
    const vote = (roleNames: readonly string[]) =>
      runRbacPipeline(
        input(
          roleNames.map((r, i) => assignment(`a${i}`, r)),
          'file:read',
          { roles: RELATION_ROLES },
        ),
      );

    it('a grant with relation R permits when relation(R) holds, and gives no reason', () => {
      const v = vote(['owner-reader']);
      expect(v.permitWhen).to.deep.equal(rel('owner'));
      expect(v.denyWhen).to.deep.equal(FALSE);
      expect(v.reason).to.equal(undefined);
    });

    it('several relations in one grant are OR-ed', () => {
      expect(vote(['either']).permitWhen).to.deep.equal({ op: 'or', args: [rel('owner'), rel('member')] });
    });

    it('grants of one permission with different relations are OR-ed, within a role and across roles', () => {
      expect(vote(['two-grants']).permitWhen).to.deep.equal({ op: 'or', args: [rel('member'), rel('owner')] });
      expect(vote(['owner-reader', 'member-reader']).permitWhen).to.deep.equal({ op: 'or', args: [rel('member'), rel('owner')] });
    });

    it('a grant without relation is unconditional and absorbs the relation grants', () => {
      expect(vote(['owner-reader', 'reader']).permitWhen).to.deep.equal(TRUE);
      expect(vote(['reader', 'either']).permitWhen).to.deep.equal(TRUE);
    });

    it('one relation reached through two roles appears once', () => {
      expect(vote(['owner-reader', 'two-grants']).permitWhen).to.deep.equal({ op: 'or', args: [rel('member'), rel('owner')] });
    });

    it('a refused relation grant adds nothing to permitWhen', () => {
      const v = runRbacPipeline(
        input([assignment('a1', 'owner-reader'), assignment('a2', 'member-reader')], 'file:read', { roles: RELATION_ROLES }),
        withSteps({
          tag: (s) => {
            s.candidates.find((c) => c.grant.role === 'member-reader')!.failed = true;
          },
        }),
      );
      expect(v.permitWhen).to.deep.equal(rel('owner'));
    });

    it('a type-level request gets the same residual: every row is checked against relation(R)', () => {
      const base = input([assignment('a1', 'owner-reader')], 'file:read', { roles: RELATION_ROLES });
      expect(runRbacPipeline({ ...base, request: { ...base.request, resource: { type: 'file' } } }).permitWhen).to.deep.equal(rel('owner'));
    });

    it('a partial permit keeps the reason of the refused grant while permitWhen is conditional', () => {
      const tagMissing = { code: 'tag_missing', tag: 'beta', priority: DEFAULT_DENY_PRIORITY.tag_missing };
      const v = runRbacPipeline(
        input([assignment('a1', 'owner-reader'), assignment('a2', 'reader')], 'file:read', { roles: RELATION_ROLES }),
        withSteps({
          tag: (s) => {
            s.candidates.find((c) => c.grant.role === 'reader')!.failed = true;
            s.reasons.push(tagMissing);
          },
        }),
      );
      expect(v.permitWhen).to.deep.equal(rel('owner'));
      expect(v.reason).to.deep.equal(tagMissing);
    });
  });

  describe('resource patterns in the residual (B16)', () => {
    const patterned = withGrantsOf('patterned', [{ permission: 'file:read', relation: 'owner', on: [{ type: 'file', id: 'pub-*' }] }]);
    const exact = withGrantsOf('exact', [{ permission: 'file:read', on: [{ type: 'file', id: 'f1' }] }]);
    const run = (roleName: string, resource: ResourceRef) => {
      const base = input([assignment('a1', roleName)], 'file:read', { roles: [patterned, exact] });
      return runRbacPipeline({ ...base, request: { ...base.request, resource }, path: resource.id === undefined ? [GLOBAL] : [resource, GLOBAL] }).permitWhen;
    };

    it('the pattern part is ANDed with the relation part', () => {
      expect(run('patterned', { type: 'file' })).to.deep.equal({
        op: 'and',
        args: [
          { op: 'relation', relation: 'owner' },
          { op: 'cmp', field: 'id', cmp: 'glob', value: 'pub-*' },
        ],
      });
      expect(run('patterned', { type: 'file', id: 'pub-1' })).to.deep.equal({ op: 'relation', relation: 'owner' });
      expect(run('patterned', f1)).to.deep.equal(FALSE);
    });

    it('a grant whose patterns miss the resource permits nothing', () => {
      expect(run('exact', f1)).to.deep.equal(TRUE);
      expect(run('exact', { type: 'file', id: 'f2' })).to.deep.equal(FALSE);
      expect(run('exact', { type: 'file' })).to.deep.equal({ op: 'under', scopes: [f1] });
    });
  });

  describe('ceiling.roles (B07)', () => {
    const run = (principal: Principal, assignments: readonly Assignment[], permission: string) => {
      const base = input(assignments, permission);
      return runRbacPipeline({ ...base, request: { ...base.request, principal } });
    };
    const viewerAndWriter = [assignment('a1', 'viewer'), assignment('a2', 'writer')];

    it('absent (or null) roles filter nothing', () => {
      for (const p of [alice, withCeiling(alice, { permissions: ['file:*'] }), { ...alice, ceiling: { roles: null } } as unknown as Principal]) {
        expect(run(p, viewerAndWriter, 'file:read').permitWhen).to.deep.equal(TRUE);
        expect(run(p, viewerAndWriter, 'file:write').permitWhen).to.deep.equal(TRUE);
      }
    });

    it('keeps only the assignments whose role it lists', () => {
      const asViewer = withCeiling(alice, { roles: ['viewer', 'ghost'] });
      expect(run(asViewer, viewerAndWriter, 'file:read').permitWhen).to.deep.equal(TRUE);
      const write = run(asViewer, viewerAndWriter, 'file:write');
      expect(write.permitWhen).to.deep.equal(FALSE);
      expect(write.reason).to.deep.equal(NO_ACCESS);
    });

    it('[] keeps no assignment', () => {
      const v = run(withCeiling(alice, { roles: [] }), viewerAndWriter, 'file:read');
      expect(v.permitWhen).to.deep.equal(FALSE);
      expect(v.reason).to.deep.equal(NO_ACCESS);
    });

    it('matches the assigned role name, not the roles it extends: a role switch to an extended role keeps nothing', () => {
      const editor = [assignment('a1', 'editor')];
      expect(run(withCeiling(alice, { roles: ['viewer'] }), editor, 'file:read').permitWhen).to.deep.equal(FALSE);
      expect(run(withCeiling(alice, { roles: ['editor'] }), editor, 'file:read').permitWhen).to.deep.equal(TRUE);
      expect(run(withCeiling(alice, { roles: ['editor'] }), editor, 'file:write').permitWhen).to.deep.equal(TRUE);
    });

    it('roles are names, not globs', () => {
      for (const roles of [['*'], ['view*'], ['VIEWER']]) {
        expect(run(withCeiling(alice, { roles }), viewerAndWriter, 'file:read').permitWhen, JSON.stringify(roles)).to.deep.equal(FALSE);
      }
    });

    it("applies the principal's ceiling to its companions' assignments too", () => {
      const bot = { type: 'service', id: 'bot' };
      const p = withCeiling(withCompanions(alice, [bot]), { roles: ['viewer'] });
      const assignments = [assignment('a1', 'viewer'), assignment('b1', 'writer', { subject: bot })];
      expect(run(p, assignments, 'file:read').permitWhen).to.deep.equal(TRUE);
      expect(run(p, assignments, 'file:write').permitWhen).to.deep.equal(FALSE);
    });

    it('a filtered assignment does not bound validUntil', () => {
      const soon = new Date(NOW.getTime() + 60_000);
      const v = run(withCeiling(alice, { roles: ['viewer'] }), [assignment('a1', 'viewer'), assignment('a2', 'editor', { expiresAt: soon })], 'file:read');
      expect(v.permitWhen).to.deep.equal(TRUE);
      expect(v).not.to.have.property('validUntil');
    });

    it('an assignment the ceiling drops is never parsed: its unreadable expiresAt does not throw', () => {
      const corrupt = assignment('a2', 'writer', { expiresAt: 'soon' as unknown as Date });
      expect(run(withCeiling(alice, { roles: ['viewer'] }), [assignment('a1', 'viewer'), corrupt], 'file:read').permitWhen).to.deep.equal(TRUE);
      expect(() => run(alice, [assignment('a1', 'viewer'), corrupt], 'file:read')).to.throw(/unreadable expiresAt/);
    });

    it('a malformed ceiling.roles throws, so the vote is model_error', () => {
      for (const roles of ['viewer', [1], {}]) {
        const p = { ...alice, ceiling: { roles } } as unknown as Principal;
        expect(() => run(p, viewerAndWriter, 'file:read'), JSON.stringify(roles)).to.throw(/ceiling\.roles/);
      }
    });
  });

  describe('field sets (B17)', () => {
    const PERMISSIONS = [{ name: 'user:read', fields: true }];
    const fieldVote = (grants: Record<string, RoleDef['grants']>, opts: { steps?: RbacSteps; resource?: ResourceRef } = {}) => {
      const base = input(
        Object.keys(grants).map((r, i) => assignment(`a${i}`, r)),
        'user:read',
        { roles: Object.entries(grants).map(([name, list]) => withGrantsOf(name, list)), permissions: PERMISSIONS },
      );
      const resource = opts.resource ?? { type: 'user', id: 'u1' };
      return runRbacPipeline({ ...base, request: { ...base.request, resource }, path: resource.id === undefined ? [GLOBAL] : [resource, GLOBAL] }, opts.steps);
    };
    const expectFields = (fields: FieldSet | undefined, list: 'read' | 'write', allows: readonly string[], denies: readonly string[]) => {
      const m = compileFieldGlobs(fields?.[list] ?? ['*']);
      for (const f of allows) expect(m.allows(f), `${list} allows ${f}`).to.equal(true);
      for (const f of denies) expect(m.allows(f), `${list} denies ${f}`).to.equal(false);
    };

    it("one grant's field set becomes the vote's", () => {
      const v = fieldVote({ reader: [{ permission: 'user:read', fields: { read: ['name', 'email'], write: ['name'] } }] });
      expect(v.fields).to.have.keys('read', 'write');
      expectFields(v.fields, 'read', ['name', 'email'], ['salary']);
      expectFields(v.fields, 'write', ['name'], ['email']);
    });

    it('the field sets of passing grants are united, across roles and within one', () => {
      const v = fieldVote({
        reader: [{ permission: 'user:read', fields: { read: ['name', 'email'] } }],
        avatars: [
          { permission: 'user:read', fields: { read: ['avatar'] } },
          { permission: 'user:read', fields: { read: ['bio'] } },
        ],
      });
      expectFields(v.fields, 'read', ['name', 'email', 'avatar', 'bio'], ['salary']);
    });

    it('an unconditional grant without fields widens the union to every field', () => {
      const v = fieldVote({ reader: [{ permission: 'user:read', fields: { read: ['name'], write: ['name'] } }], all: [{ permission: 'user:read' }] });
      expect(v.fields).to.deep.equal({ read: ['*'], write: ['*'] });
    });

    it('no passing grant with fields leaves Vote.fields unset (every field, D-F5-2)', () => {
      expect(fieldVote({ all: [{ permission: 'user:read' }] })).not.to.have.property('fields');
    });

    it('a list the grant leaves out is every field, as the engine reads a vote', () => {
      const v = fieldVote({ reader: [{ permission: 'user:read', fields: { read: ['name'] } }] });
      expect(v.fields!.write).to.deep.equal(['*']);
    });

    it('fields an earlier step set cap the result: intersected with the grants, kept when no grant carries fields', () => {
      const capped = withSteps({
        aggregate: (s) => {
          s.fields = { read: ['name', 'email'] };
        },
      });
      const v = fieldVote({ reader: [{ permission: 'user:read', fields: { read: ['email', 'phone'], write: ['email'] } }] }, { steps: capped });
      expectFields(v.fields, 'read', ['email'], ['name', 'phone']);
      expectFields(v.fields, 'write', ['email'], ['name']);
      const w = fieldVote({ all: [{ permission: 'user:read' }] }, { steps: capped });
      expect(w.fields).to.deep.equal({ read: ['name', 'email'] });
    });

    it('!X negations and A.* globs work, and a union restores what one grant negates', () => {
      const v = fieldVote({ reader: [{ permission: 'user:read', fields: { read: ['*', '!Password', '!internal'], write: ['profile.*'] } }] });
      expectFields(v.fields, 'read', ['name', 'profile.age'], ['Password', 'internal']);
      expectFields(v.fields, 'write', ['profile.age', 'profile.name'], ['name', 'profile']);
      const w = fieldVote({ reader: [{ permission: 'user:read', fields: { read: ['*', '!internal'] } }], ops: [{ permission: 'user:read', fields: { read: ['internal'] } }] });
      expectFields(w.fields, 'read', ['name', 'internal'], []);
    });

    it("a grant's hide is folded into its own read and write, never into other grants", () => {
      const v = fieldVote({ hr: [{ permission: 'user:read', fields: { read: ['*'], hide: ['salary'] } }] });
      expect(v.fields).not.to.have.property('hide');
      expectFields(v.fields, 'read', ['name'], ['salary']);
      expectFields(v.fields, 'write', ['name'], ['salary']);
      const w = fieldVote({ hr: [{ permission: 'user:read', fields: { read: ['*'], hide: ['salary'] } }], payroll: [{ permission: 'user:read', fields: { read: ['salary'] } }] });
      expectFields(w.fields, 'read', ['name', 'salary'], []);
    });

    describe('unconditional and conditional grants', () => {
      const LOGIN = { permission: 'user:read', fields: { read: ['Login'] } };
      const SELF_ALL = { permission: 'user:read', relation: 'self', fields: { read: ['*', '!Password'] } };

      it('an unconditional grant decides alone: a conditional one cannot widen it to rows it may not hold on', () => {
        const v = fieldVote({ public: [LOGIN], self: [SELF_ALL] });
        expect(v.permitWhen).to.deep.equal(TRUE);
        expectFields(v.fields, 'read', ['Login'], ['email', 'phone', 'Password']);
        const w = fieldVote({ public: [LOGIN], selfAll: [{ permission: 'user:read', relation: 'self' }] });
        expectFields(w.fields, 'read', ['Login'], ['email']);
      });

      it('unconditional grants unite among themselves, conditional ones aside', () => {
        const v = fieldVote({ public: [LOGIN], avatars: [{ permission: 'user:read', fields: { read: ['avatar'] } }], self: [SELF_ALL] });
        expectFields(v.fields, 'read', ['Login', 'avatar'], ['email']);
      });

      it('with conditional grants only, the fields are their intersection', () => {
        const v = fieldVote({ self: [{ permission: 'user:read', relation: 'self', fields: { read: ['name', 'email'], write: ['email'] } }], member: [{ permission: 'user:read', relation: 'member', fields: { read: ['name', 'phone'] } }] });
        expectFields(v.fields, 'read', ['name'], ['email', 'phone']);
        expectFields(v.fields, 'write', ['email'], ['name']);
      });

      it('a conditional grant without fields does not widen the intersection', () => {
        const v = fieldVote({ self: [{ permission: 'user:read', relation: 'self', fields: { read: ['email'] } }], member: [{ permission: 'user:read', relation: 'member' }] });
        expectFields(v.fields, 'read', ['email'], ['name']);
        expect(fieldVote({ member: [{ permission: 'user:read', relation: 'member' }] })).not.to.have.property('fields');
      });

      it('a pattern that holds on the concrete resource makes its grant unconditional; on a type-level request it is conditional', () => {
        const grants = { mine: [{ permission: 'user:read', on: [{ type: 'user', id: 'u1' }], fields: { read: ['salary'] } }], self: [{ permission: 'user:read', relation: 'self', fields: { read: ['email', 'salary'] } }] };
        const concrete = fieldVote(grants);
        expectFields(concrete.fields, 'read', ['salary'], ['email']);
        const typeLevel = fieldVote(grants, { resource: { type: 'user' } });
        expectFields(typeLevel.fields, 'read', ['salary'], ['email']);
        const wider = fieldVote({ mine: [{ permission: 'user:read', on: [{ type: 'user', id: 'u1' }], fields: { read: ['salary', 'email'] } }], self: [{ permission: 'user:read', relation: 'self', fields: { read: ['email'] } }] }, { resource: { type: 'user' } });
        expectFields(wider.fields, 'read', ['email'], ['salary']);
      });
    });

    it('a refused grant, or one whose patterns miss the resource, adds no fields', () => {
      const missed = fieldVote({ other: [{ permission: 'user:read', on: [{ type: 'user', id: 'u2' }], fields: { read: ['salary'] } }], reader: [{ permission: 'user:read', fields: { read: ['name'] } }] });
      expectFields(missed.fields, 'read', ['name'], ['salary']);
      const refused = fieldVote(
        { tagged: [{ permission: 'user:read', fields: { read: ['salary'] } }], reader: [{ permission: 'user:read', fields: { read: ['name'] } }] },
        {
          steps: withSteps({
            tag: (s) => {
              s.candidates.find((c) => c.grant.role === 'tagged')!.failed = true;
            },
          }),
        },
      );
      expectFields(refused.fields, 'read', ['name'], ['salary']);
      const none = fieldVote({ other: [{ permission: 'user:read', on: [{ type: 'user', id: 'u2' }], fields: { read: ['salary'] } }] });
      expect(none.permitWhen).to.deep.equal(FALSE);
      expect(none).not.to.have.property('fields');
    });

    it('a union over the field-glob work budget throws, so the vote is model_error (fail closed)', () => {
      const negations = ['*', ...Array.from({ length: 300 }, (_, i) => `!*.a${i}`)];
      const subtrees = Array.from({ length: 300 }, (_, i) => `M${i}.*`);
      expect(() => fieldVote({ a: [{ permission: 'user:read', fields: { read: negations } }], b: [{ permission: 'user:read', fields: { read: subtrees } }] })).to.throw(AuthzConfigError, /too complex/);
    });
  });

  describe('scoped assignments along the resource path (B13)', () => {
    // o1 → p1 → f1, o1 → p2 → f2
    const O1: ResourceRef = { type: 'org', id: 'o1' };
    const P1: ResourceRef = { type: 'project', id: 'p1' };
    const P2: ResourceRef = { type: 'project', id: 'p2' };
    const f2: ResourceRef = { type: 'file', id: 'f2' };
    const scopes = () =>
      new FakeScopeResolver({
        nodes: [
          { ref: P1, parent: O1 },
          { ref: f1, parent: P1 },
          { ref: P2, parent: O1 },
          { ref: f2, parent: P2 },
        ],
      });

    async function evaluate(assignments: readonly Assignment[], resource: ResourceRef, ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes()] }), opts: { extensions?: readonly RbacExtension[]; principal?: Principal } = {}) {
      const registry = new PermissionRegistryImpl();
      registry.register(
        ['file:read', 'file:write'].map((name) => ({ name, types: ['org', 'project', 'file'] })),
        'test',
      );
      registry.freeze();
      const roles = compileRoles(ROLES);
      const store = new MemoryAssignmentStore(assignments);
      const gathered = await gatherRbacInput({ principal: opts.principal ?? alice, permission: 'file:read', resource }, ctx, { roles, grants: compileGrants(roles, registry), assignments: store, extensions: opts.extensions });
      return { input: gathered, vote: runRbacPipeline(gathered), ctx, store };
    }

    // A fresh ref, equal by value only: scopes match by resourceKey, not by identity.
    const at = (ref: ResourceRef, id = 'a1') => assignment(id, 'viewer', { scope: { ...ref } });

    it('an assignment at the resource itself applies to it', async () => {
      expect((await evaluate([at(f1)], f1)).vote.permitWhen).to.deep.equal(TRUE);
    });

    it('an assignment at S applies to S', async () => {
      expect((await evaluate([at(P1)], P1)).vote.permitWhen).to.deep.equal(TRUE);
    });

    it('an assignment at S applies to the descendants of S', async () => {
      expect((await evaluate([at(P1)], f1)).vote.permitWhen).to.deep.equal(TRUE);
      expect((await evaluate([at(O1)], f1)).vote.permitWhen).to.deep.equal(TRUE);
      expect((await evaluate([at(O1)], f2)).vote.permitWhen).to.deep.equal(TRUE);
    });

    it('an assignment at S does not apply to an ancestor of S', async () => {
      expect((await evaluate([at(P1)], O1)).vote.reason).to.deep.equal(NO_ACCESS);
      expect((await evaluate([at(f1)], P1)).vote.reason).to.deep.equal(NO_ACCESS);
    });

    it('an assignment at S does not apply to a sibling of S or its descendants', async () => {
      expect((await evaluate([at(P1)], P2)).vote.reason).to.deep.equal(NO_ACCESS);
      expect((await evaluate([at(P1)], f2)).vote.reason).to.deep.equal(NO_ACCESS);
    });

    it('a GLOBAL assignment applies to every concrete resource', async () => {
      for (const r of [f1, f2, P1, O1]) expect((await evaluate([assignment('g1', 'viewer')], r)).vote.permitWhen).to.deep.equal(TRUE);
    });

    it('the path is the ancestors list, read once per evaluation', async () => {
      const { input: gathered, ctx } = await evaluate([at(P1)], f1);
      expect(gathered.path).to.deep.equal([f1, P1, O1, GLOBAL]);
      expect(ctx.stats.ancestors.calls).to.equal(1);
    });

    it('the resource itself and GLOBAL are on the path even when the ancestors list leaves them out', async () => {
      const base = fakeEvaluationContext({ now: NOW });
      const ctx = Object.assign(Object.create(base) as typeof base, { ancestors: async () => [P1] });
      const { input: gathered, vote } = await evaluate([assignment('g1', 'viewer')], f1, ctx);
      expect(gathered.path).to.deep.equal([f1, P1, GLOBAL]);
      expect(vote.permitWhen).to.deep.equal(TRUE);
    });

    it('the path is nearest first and GLOBAL stays last even when the ancestors list holds it earlier', async () => {
      const base = fakeEvaluationContext({ now: NOW });
      const ctx = Object.assign(Object.create(base) as typeof base, { ancestors: async () => [f1, GLOBAL, P1, O1] });
      const { input: gathered } = await evaluate([], f1, ctx);
      expect(gathered.path).to.deep.equal([f1, P1, O1, GLOBAL]);
    });

    describe('type-level requests (B06)', () => {
      const FILES: ResourceRef = { type: 'file' };

      it('the path is [type, GLOBAL]; GLOBAL and bare type-ref assignments permit every row, without reading ancestors', async () => {
        const global = await evaluate([assignment('g1', 'viewer')], FILES);
        expect(global.vote.permitWhen).to.deep.equal(TRUE);
        expect(global.input.path).to.deep.equal([{ type: 'file' }, GLOBAL]);
        expect(global.ctx.stats.ancestors.calls).to.equal(0);
        expect((await evaluate([at({ type: 'file' })], FILES)).vote.permitWhen).to.deep.equal(TRUE);
        expect((await evaluate([], { type: '$global' })).input.path).to.deep.equal([GLOBAL]);
      });

      it('scoped assignments permit the rows under their scopes: under, sorted and without duplicates', async () => {
        const v = (await evaluate([at(P2), at(P1, 'a2'), at(f1, 'a3'), at(P1, 'a4')], FILES)).vote;
        expect(v.permitWhen).to.deep.equal({ op: 'under', scopes: [f1, P1, P2] });
        expect(v.reason).to.deep.equal(NO_ACCESS);
        const otherType = (await evaluate([at({ type: 'project' })], FILES)).vote;
        expect(otherType.permitWhen).to.deep.equal(FALSE);
      });

      it("a scoped term is ANDed with the grant's own residual, per grant", async () => {
        const roles = [
          withGrantsOf('owner-viewer', [
            { permission: 'file:read', relation: 'owner' },
            { permission: 'file:read', on: [{ type: 'file', id: 'f*' }] },
          ]),
        ];
        const registry = new PermissionRegistryImpl();
        registry.register([{ name: 'file:read', types: ['org', 'project', 'file'] }], 'test');
        registry.freeze();
        const graph = compileRoles(roles);
        const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes()] });
        const gathered = await gatherRbacInput({ principal: alice, permission: 'file:read', resource: FILES }, ctx, { roles: graph, grants: compileGrants(graph, registry), assignments: new MemoryAssignmentStore([assignment('a1', 'owner-viewer', { scope: P1 })]) });
        const under = { op: 'under', scopes: [P1] };
        expect(runRbacPipeline(gathered).permitWhen).to.deep.equal({
          op: 'or',
          args: [
            { op: 'and', args: [under, { op: 'cmp', field: 'id', cmp: 'glob', value: 'f*' }] },
            { op: 'and', args: [under, { op: 'relation', relation: 'owner' }] },
          ],
        });
      });

      it('the OR terms are in canonical order, whatever the order of the stored assignments', async () => {
        const roles = [withGrantsOf('owners', [{ permission: 'file:read', relation: 'owner' }]), withGrantsOf('members', [{ permission: 'file:read', relation: 'member' }]), withGrantsOf('all', [{ permission: 'file:read', on: [{ type: 'file', id: 'f*' }] }])];
        const registry = new PermissionRegistryImpl();
        registry.register([{ name: 'file:read', types: ['org', 'project', 'file'] }], 'test');
        registry.freeze();
        const graph = compileRoles(roles);
        const rows = [assignment('a1', 'owners', { scope: P2 }), assignment('a2', 'members', { scope: P1 }), assignment('a3', 'all'), assignment('a4', 'owners')];
        const permitWhen = async (list: readonly Assignment[], resource: ResourceRef) => {
          const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes()] });
          return JSON.stringify(runRbacPipeline(await gatherRbacInput({ principal: alice, permission: 'file:read', resource }, ctx, { roles: graph, grants: compileGrants(graph, registry), assignments: new MemoryAssignmentStore(list) })).permitWhen);
        };
        for (const resource of [FILES, f1]) expect(await permitWhen([...rows].reverse(), resource)).to.equal(await permitWhen(rows, resource));
      });

      it('expired, ceiling-dropped and unknown-role assignments add no term; the others bound validUntil', async () => {
        const soon = new Date(NOW.getTime() + 60_000);
        const expired = new Date(NOW.getTime() - 1);
        const v = (await evaluate([at(P1), assignment('a2', 'viewer', { scope: P2, expiresAt: soon }), assignment('a3', 'viewer', { scope: O1, expiresAt: expired }), assignment('a4', 'ghost', { scope: O1 })], FILES)).vote;
        expect(v.permitWhen).to.deep.equal({ op: 'under', scopes: [P1, P2] });
        expect(v.validUntil).to.deep.equal(soon);
        const capped = (await evaluate([at(P1), assignment('a2', 'writer', { scope: P2 })], FILES, undefined, { principal: withCeiling(alice, { roles: ['writer'] }) })).vote;
        expect(capped.permitWhen).to.deep.equal(FALSE);
      });

      it('a concrete request ignores assignments off its path; a bare type-ref assignment applies to rows of that type only', async () => {
        expect((await evaluate([at(P2)], f1)).vote.permitWhen).to.deep.equal(FALSE);
        expect((await evaluate([at({ type: 'file' })], f1)).vote.permitWhen).to.deep.equal(TRUE);
        expect((await evaluate([at({ type: 'project' })], f1)).vote.permitWhen).to.deep.equal(FALSE);
        expect((await evaluate([at({ type: 'project' })], P1)).vote.permitWhen).to.deep.equal(TRUE);
      });

      it('with rbacAssignmentExtension the term is native:rbac.assignment with canonical args', async () => {
        const bot = { type: 'service', id: 'bot' };
        const principal = withCompanions(alice, [bot]);
        const opts = { roles: new MemoryRoleStore([]), assignments: new MemoryAssignmentStore([]) };
        const v = (await evaluate([at(P1), assignment('a2', 'editor', { scope: P2, subject: bot }), at(P2, 'a3')], FILES, undefined, { principal, extensions: [rbacAssignmentExtension(opts)] })).vote;
        expect(v.permitWhen).to.deep.equal({
          op: 'native:rbac.assignment',
          args: {
            v: 1,
            subjects: [
              { type: 'service', id: 'bot' },
              { type: 'user', id: 'alice' },
            ],
            roles: ['editor', 'viewer'],
          },
        });
      });

      it('rbacAssignmentExtension with types emits the native term for those types only', async () => {
        const opts = { roles: new MemoryRoleStore([]), assignments: new MemoryAssignmentStore([]) };
        const forFiles = (await evaluate([at(P1)], FILES, undefined, { extensions: [rbacAssignmentExtension(opts, { types: ['file'] })] })).vote;
        expect(forFiles.permitWhen.op).to.equal('native:rbac.assignment');
        const forProjects = (await evaluate([at(P1)], FILES, undefined, { extensions: [rbacAssignmentExtension(opts, { types: ['project'] })] })).vote;
        expect(forProjects.permitWhen).to.deep.equal({ op: 'under', scopes: [P1] });
      });

      it('a list of scopes past MAX_UNDER_SCOPES throws (fail closed)', async () => {
        const many = Array.from({ length: MAX_UNDER_SCOPES + 1 }, (_, i) => assignment(`a${i}`, 'viewer', { scope: { type: 'project', id: `p${i}` } }));
        await rejects(evaluate(many, FILES), /MAX_UNDER_SCOPES|exceed/);
      });
    });
  });

  describe('expiry and validUntil (B14)', () => {
    const after = (ms: number) => new Date(NOW.getTime() + ms);
    const HOUR = 3_600_000;
    const expiring = (id: string, roleName: string, expiresAt: unknown) => assignment(id, roleName, { expiresAt: expiresAt as Date });

    it('an assignment expiring exactly at now is expired; one a millisecond later is live until then', () => {
      expect(runRbacPipeline(input([expiring('a1', 'viewer', after(0))], 'file:read')).reason).to.deep.equal(NO_ACCESS);
      const vote = runRbacPipeline(input([expiring('a1', 'viewer', after(1))], 'file:read'));
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.validUntil).to.deep.equal(after(1));
    });

    it('validUntil is the earliest expiry among the assignments that reach the permission', () => {
      const vote = runRbacPipeline(input([expiring('a1', 'viewer', after(2 * HOUR)), expiring('a2', 'editor', after(HOUR)), expiring('a3', 'viewer', after(3 * HOUR))], 'file:read'));
      expect(vote.validUntil).to.deep.equal(after(HOUR));
    });

    it('an expiring assignment whose roles do not reach the permission leaves validUntil alone', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'viewer'), expiring('a2', 'writer', after(60_000))], 'file:read'));
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.validUntil).to.equal(undefined);
      expect(runRbacPipeline(input([expiring('a2', 'writer', after(60_000))], 'file:read')).validUntil).to.equal(undefined);
    });

    it('a null or absent expiresAt never expires and sets no validUntil', () => {
      const vote = runRbacPipeline(input([expiring('a1', 'viewer', null), assignment('a2', 'viewer')], 'file:read'));
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.validUntil).to.equal(undefined);
      expect(vote.cacheable).to.equal(true);
    });

    it('a holder of a grant that a step refused still bounds validUntil: its expiry changes the reason', () => {
      const vote = runRbacPipeline(
        input([expiring('a1', 'viewer', after(HOUR))], 'file:read'),
        withSteps({
          tag: (s) => {
            s.candidates[0].failed = true;
            s.reasons.push({ code: 'tag_missing', tag: 'x', priority: DEFAULT_DENY_PRIORITY.tag_missing });
          },
        }),
      );
      expect(vote.permitWhen).to.deep.equal(FALSE);
      expect(vote.validUntil).to.deep.equal(after(HOUR));
    });

    it('an earlier step may set validUntil; the vote keeps the earlier of it and the holders', () => {
      const steps = (until: Date) => withSteps({ aggregate: (s) => void (s.validUntil = until) });
      expect(runRbacPipeline(input([expiring('a1', 'viewer', after(HOUR))], 'file:read'), steps(after(60_000))).validUntil).to.deep.equal(after(60_000));
      expect(runRbacPipeline(input([expiring('a1', 'viewer', after(HOUR))], 'file:read'), steps(after(2 * HOUR))).validUntil).to.deep.equal(after(HOUR));
    });

    it('an unreadable expiresAt (invalid Date, string, number) on the path throws, naming the assignment', () => {
      for (const bad of [new Date(NaN), after(HOUR).toISOString(), after(HOUR).getTime()]) {
        const corrupt = { ...expiring('a1', 'viewer', bad), source: 'db' };
        expect(() => runRbacPipeline(input([corrupt, assignment('a2', 'viewer')], 'file:read')), String(bad)).to.throw(Error, "assignment 'a1' (source: db, role 'viewer') has an unreadable expiresAt");
      }
    });

    it('an unreadable expiresAt off the path is not read', () => {
      const offPath = expiring('a1', 'viewer', 'soon');
      expect(runRbacPipeline(input([{ ...offPath, scope: { type: 'project', id: 'p1' } }, assignment('a2', 'viewer')], 'file:read')).permitWhen).to.deep.equal(TRUE);
    });

    it('validUntil ignores expiring assignments off the path and of unknown roles', () => {
      const vote = runRbacPipeline(
        input(
          [assignment('a1', 'viewer'), expiring('a2', 'viewer', after(60_000)), expiring('a3', 'ghost', after(60_000))].map((a) => (a.id === 'a2' ? { ...a, scope: { type: 'project', id: 'p1' } } : a)),
          'file:read',
          { onUnknownRole: () => undefined },
        ),
      );
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.validUntil).to.equal(undefined);
    });

    it('a corrupt row in the memory store reaches the model, which throws; holders leaves it out', async () => {
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'file:read' }], 'test');
      registry.freeze();
      const roles = compileRoles([role('viewer', ['file:read'])]);
      const store = new MemoryAssignmentStore([expiring('a1', 'viewer', 'tomorrow'), assignment('a2', 'viewer')]);
      const gathered = await gatherRbacInput({ principal: alice, permission: 'file:read', resource: f1 }, fakeEvaluationContext({ now: NOW }), { roles, grants: compileGrants(roles, registry), assignments: store });
      expect(gathered.assignments.map((a) => a.id)).to.deep.equal(['a1', 'a2']);
      expect(() => runRbacPipeline(gathered)).to.throw(Error, "assignment 'a1'");
      expect(await store.holders('viewer', GLOBAL, NOW)).to.deep.equal([{ type: 'user', id: 'alice' }]);
    });

    it('the gathering re-checks expiry against ctx.now, whatever the store returned', async () => {
      class Unfiltered extends MemoryAssignmentStore {
        override async forSubjects(): Promise<readonly Assignment[]> {
          return this.all();
        }
      }
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'file:read' }], 'test');
      registry.freeze();
      const roles = compileRoles([role('viewer', ['file:read'])]);
      const sources = { roles, grants: compileGrants(roles, registry), assignments: new Unfiltered([expiring('a1', 'viewer', after(HOUR))]) };
      const at = (now: Date) => gatherRbacInput({ principal: alice, permission: 'file:read', resource: f1 }, fakeEvaluationContext({ now }), sources).then(runRbacPipeline);
      // NOW lies before the real clock, so a model reading Date.now() would see a1 as expired here.
      expect((await at(NOW)).validUntil).to.deep.equal(after(HOUR));
      expect((await at(after(HOUR))).reason).to.deep.equal(NO_ACCESS);
    });
  });
});
