import { DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, PermissionInput, ResourceRef } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { RBAC_STEPS, RBAC_STEP_NAMES, compileGrants, compileRoles, runRbacPipeline } from '../../src/index.js';
import type { RbacInput, RbacState, RbacSteps, RoleDef } from '../../src/index.js';

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

const NO_ACCESS = { code: 'no_access', priority: DEFAULT_DENY_PRIORITY.no_access };

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

    it('an assignment at a scope other than GLOBAL is not collected yet', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'viewer', { scope: { type: 'project', id: 'p1' } })], 'file:read'));
      expect(vote.reason).to.deep.equal(NO_ACCESS);
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
});
