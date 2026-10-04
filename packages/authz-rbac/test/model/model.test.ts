import { AuthzConfigError, CORE_FILTER_OPS, DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, PermissionRegistryImpl, TRUE, UnknownPermission } from '@spinajs/authz';
import type { Assignment, ModelInitContext, NativeFilter, PermissionInput, PermissionRegistry, Principal, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, anonymousPrincipal, fakeEvaluationContext, fakeModelInitContext, servicePrincipal, userPrincipal, withCeiling, withCompanions } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { DEFAULT_RBAC_EXTENSIONS, MemoryAssignmentStore, MemoryRoleStore, RBAC_RESIDUALS, RbacContributor, RbacModel, SubjectResolver, createRbacExtensions, isTokenRoleExtension } from '../../src/index.js';
import type { AssignmentSubject, GrantIndex, RbacExtension, RoleDef, RoleGraph } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');

const role = (name: string, grants: readonly string[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });
const assignment = (id: string, who: { type: string; id: string }, roleName: string, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: who.type, id: who.id }, role: roleName, scope: GLOBAL, source: 'test', ...extra });

const ROLES = [role('viewer', ['file:read']), role('writer', ['file:write']), role('guest', ['file:read']), role('telemetry', ['file:write']), role('package', ['file:read'], { assignable: false })];

const registry = (names: readonly (string | PermissionInput)[] = ['file:read', 'file:write', 'file:delete']) => {
  const r = new PermissionRegistryImpl();
  r.register(
    names.map((n) => (typeof n === 'string' ? { name: n } : n)),
    'test',
  );
  r.freeze();
  return r;
};

interface Setup {
  roles?: readonly RoleDef[];
  assignments?: readonly Assignment[];
  config?: Record<string, unknown>;
  permissions?: readonly (string | PermissionInput)[];
  subjects?: SubjectResolver;
}

const warnings: string[] = [];
const log = { warn: (message: string) => void warnings.push(message) };

async function model(s: Setup = {}): Promise<{ model: RbacModel; store: MemoryAssignmentStore; roles: MemoryRoleStore }> {
  const roles = new MemoryRoleStore(s.roles ?? ROLES);
  const store = new MemoryAssignmentStore(s.assignments ?? []);
  const m = new RbacModel({ roles, assignments: store, subjects: s.subjects, log });
  await m.init(fakeModelInitContext({ model: 'rbac', config: s.config ?? {}, permissions: registry(s.permissions) }));
  return { model: m, store, roles };
}

const check = async (m: RbacModel, principal: Principal, permission: string, resource: ResourceRef = f1) => m.evaluate({ principal, permission, resource }, fakeEvaluationContext({ now: NOW }));

const rejects = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
};

describe('authz-rbac model: RbacModel', () => {
  beforeEach(() => {
    warnings.length = 0;
  });

  it('is named rbac and declares the §6.1.4 capabilities, with the residual ops its votes emit so far', async () => {
    const { model: m } = await model();
    expect(m.name).to.equal('rbac');
    expect(m.capabilities).to.deep.equal({ effects: ['permit', 'deny'], residuals: CORE_FILTER_OPS, sync: 'after-preload', fields: true, needsSubject: false, resourceTypes: '*' });
    for (const op of m.capabilities.residuals) expect(RBAC_RESIDUALS).to.include(op);
  });

  it('version() is the role store version read at init', async () => {
    const { model: m, roles } = await model();
    expect(m.version()).to.equal(await roles.version());
  });

  it('init refuses a role graph with a cycle (B12)', async () => {
    const m = new RbacModel({ roles: new MemoryRoleStore([role('a', [], { extends: ['b'] }), role('b', [], { extends: ['a'] })]), assignments: new MemoryAssignmentStore(), log });
    const err = await rejects(Promise.resolve().then(() => m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }))));
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.contain('cycle');
  });

  it('evaluate before init throws, it never votes no', async () => {
    const m = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(), log });
    expect(await rejects(Promise.resolve().then(() => check(m, alice, 'file:read')))).to.be.instanceOf(AuthzConfigError);
  });

  it('evaluate of an unknown resource (ancestors null) rejects, it never votes no', async () => {
    const { model: m } = await model({ assignments: [assignment('g1', alice, 'viewer')] });
    const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [new FakeScopeResolver({ types: ['file'], nodes: [{ ref: f1 }] })] });
    expect((await m.evaluate({ principal: alice, permission: 'file:read', resource: f1 }, ctx)).permitWhen).to.deep.equal(TRUE);
    const err = await rejects(Promise.resolve(m.evaluate({ principal: alice, permission: 'file:read', resource: { type: 'file', id: 'ghost' } }, ctx)));
    expect(err.message).to.contain('unknown resource file:ghost');
  });

  describe('applies', () => {
    it('is true for a permission some role grants and false otherwise', async () => {
      const { model: m } = await model();
      const reg = registry();
      expect(m.applies(reg.require('file:read'), 'file')).to.equal(true);
      expect(m.applies(reg.require('file:delete'), 'file')).to.equal(false);
    });

    it('counts grants of roles that are not assignable', async () => {
      const { model: m } = await model({ roles: [role('package', ['file:delete'], { assignable: false })] });
      expect(m.applies(registry().require('file:delete'), 'file')).to.equal(true);
    });
  });

  describe('evaluate with global assignments', () => {
    it('unions the grants of every global assignment (H1)', async () => {
      const { model: m } = await model({ assignments: [assignment('a1', alice, 'viewer'), assignment('a2', alice, 'writer')] });
      expect((await check(m, alice, 'file:read')).permitWhen).to.deep.equal(TRUE);
      expect((await check(m, alice, 'file:write')).permitWhen).to.deep.equal(TRUE);
    });

    it('gives no_access (400) without a granting assignment', async () => {
      const { model: m } = await model({ assignments: [assignment('a1', alice, 'viewer')] });
      for (const [who, permission] of [
        [bob, 'file:read'],
        [alice, 'file:delete'],
      ] as const) {
        const vote = await check(m, who, permission);
        expect(vote.permitWhen).to.deep.equal(FALSE);
        expect(vote.denyWhen).to.deep.equal(FALSE);
        expect(vote.reason).to.deep.equal({ code: 'no_access', priority: DEFAULT_DENY_PRIORITY.no_access });
      }
    });

    it('reads the assignments of the principal and its companions', async () => {
      const svc = withCompanions(servicePrincipal('svc'), [{ type: 'user', id: 'alice' }]);
      const { model: m } = await model({ assignments: [assignment('a1', alice, 'viewer')] });
      expect((await check(m, svc, 'file:read')).permitWhen).to.deep.equal(TRUE);
    });

    it('asks a SubjectResolver when one is given', async () => {
      const seen: string[] = [];
      class OnlyBob extends SubjectResolver {
        subjects(p: Principal): readonly AssignmentSubject[] {
          seen.push(p.id);
          return [{ type: 'user', id: 'bob' }];
        }
      }
      const { model: m } = await model({ assignments: [assignment('b1', bob, 'viewer')], subjects: new OnlyBob() });
      expect((await check(m, alice, 'file:read')).permitWhen).to.deep.equal(TRUE);
      expect(seen).to.deep.equal(['alice']);
    });

    it('ignores a stored assignment of an unknown role, warning once per role (B12)', async () => {
      const { model: m } = await model({ assignments: [assignment('g1', alice, 'ghost'), assignment('g2', bob, 'ghost'), assignment('a1', alice, 'viewer')] });
      expect((await check(m, alice, 'file:read')).permitWhen).to.deep.equal(TRUE);
      expect((await check(m, bob, 'file:read')).reason?.code).to.equal('no_access');
      expect((await check(m, bob, 'file:read')).reason?.code).to.equal('no_access');
      expect(warnings.filter((w) => w.includes("'ghost'"))).to.have.length(1);
    });

    it('ignores a stored assignment the role definition refuses, warning once per assignment', async () => {
      const roles = [...ROLES, role('orgAdmin', ['file:read'], { scopeTypes: ['org'] })];
      const { model: m } = await model({ roles, assignments: [assignment('p1', alice, 'package'), assignment('o1', alice, 'orgAdmin'), assignment('o2', bob, 'orgAdmin')] });
      for (let i = 0; i < 2; i++) {
        expect((await check(m, alice, 'file:read')).reason?.code).to.equal('no_access');
        expect((await check(m, bob, 'file:read')).reason?.code).to.equal('no_access');
      }
      const about = (id: string) => warnings.filter((w) => w.includes(`assignment '${id}'`));
      expect(about('p1')).to.have.length(1);
      expect(about('p1')[0]).to.contain('is not assignable');
      expect(about('o1')).to.have.length(1);
      expect(about('o1')[0]).to.contain('scopeTypes');
      expect(about('o2')).to.have.length(1);
    });

    it('does not count expired assignments', async () => {
      const { model: m } = await model({ assignments: [assignment('a1', alice, 'viewer', { expiresAt: new Date(NOW.getTime() - 1) })] });
      expect((await check(m, alice, 'file:read')).reason?.code).to.equal('no_access');
    });
  });

  describe('config roles', () => {
    it('authz.rbac.anonymousRoles are global roles of the anonymous principal only', async () => {
      const { model: m } = await model({ config: { anonymousRoles: ['guest'] } });
      expect((await check(m, anonymousPrincipal(), 'file:read')).permitWhen).to.deep.equal(TRUE);
      expect((await check(m, alice, 'file:read')).reason?.code).to.equal('no_access');
    });

    it('authz.rbac.serviceRoles are global roles of the principal with that key', async () => {
      const { model: m } = await model({ config: { serviceRoles: { 'service:telemetry': ['telemetry'] } } });
      expect((await check(m, servicePrincipal('telemetry'), 'file:write')).permitWhen).to.deep.equal(TRUE);
      expect((await check(m, servicePrincipal('other'), 'file:write')).reason?.code).to.equal('no_access');
    });

    it('config roles pass the ceiling.roles filter like stored assignments (B07)', async () => {
      const { model: m } = await model({ config: { anonymousRoles: ['guest'], serviceRoles: { 'service:telemetry': ['telemetry'] } } });
      expect((await check(m, withCeiling(anonymousPrincipal(), { roles: ['viewer'] }), 'file:read')).reason?.code).to.equal('no_access');
      expect((await check(m, withCeiling(anonymousPrincipal(), { roles: ['guest'] }), 'file:read')).permitWhen).to.deep.equal(TRUE);
      expect((await check(m, withCeiling(servicePrincipal('telemetry'), { roles: [] }), 'file:write')).reason?.code).to.equal('no_access');
      expect((await check(m, withCeiling(servicePrincipal('telemetry'), { roles: ['telemetry'] }), 'file:write')).permitWhen).to.deep.equal(TRUE);
    });

    for (const [name, config, fragment] of [
      ['an unknown anonymous role', { anonymousRoles: ['ghost'] }, 'ghost'],
      ['a non-assignable anonymous role', { anonymousRoles: ['package'] }, 'package'],
      ['an unknown service role', { serviceRoles: { 'service:x': ['ghost'] } }, 'ghost'],
      ['anonymousRoles that are not an array of names', { anonymousRoles: 'guest' }, 'anonymousRoles'],
      ['serviceRoles that are not a map of role lists', { serviceRoles: { 'service:x': 'telemetry' } }, 'serviceRoles'],
    ] as const) {
      it(`refuses ${name} at init`, async () => {
        const err = await rejects(model({ config }));
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect(err.message).to.contain(fragment);
      });
    }
  });

  describe('grant compile', () => {
    it('warns about globs that match nothing and fields that reach no permission', async () => {
      const { model: m } = await model({ roles: [role('r', ['billing:*']), { ...role('s'), grants: [{ permission: 'file:*', fields: { read: ['a'] } }] }] });
      m.applies(registry().require('file:read'), 'file');
      expect(warnings.some((w) => w.includes('billing:*'))).to.equal(true);
      expect(warnings.some((w) => w.includes('file:*') && w.includes('fields'))).to.equal(true);
    });
  });
});

describe('authz-rbac model: extensions', () => {
  const ladderRoles = [role('viewer', ['file:read']), role('editor', ['file:write'])];
  const make = (extensions: readonly RbacExtension[], assignments: readonly Assignment[] = []) => new RbacModel({ roles: new MemoryRoleStore(ladderRoles), assignments: new MemoryAssignmentStore(assignments), extensions, log });
  const initCtx = () => fakeModelInitContext({ model: 'rbac', config: { groupPrincipal: { role: 'group.member' } }, permissions: registry() });

  it('init hooks run in list order with the model init context, before the roles load and compile', async () => {
    const seen: unknown[] = [];
    class Recording extends MemoryRoleStore {
      override async load() {
        seen.push('load');
        return super.load();
      }
    }
    let m: RbacModel | undefined;
    const compiled = () => {
      try {
        m!.roleGraph();
        return true;
      } catch {
        return false;
      }
    };
    m = new RbacModel({
      roles: new Recording(ladderRoles),
      assignments: new MemoryAssignmentStore(),
      log,
      extensions: [{ init: (ctx: ModelInitContext) => void seen.push(['first', ctx.config('groupPrincipal'), compiled()]) }, { init: () => void seen.push(['second', compiled()]) }],
    });
    await m.init(initCtx());
    expect(seen).to.deep.equal([['first', { role: 'group.member' }, false], ['second', false], 'load']);
  });

  it('extraEdges join the role graph', async () => {
    const m = make([{ extraEdges: () => [{ from: 'editor', to: 'viewer', via: "ladder 'project'" }] }], [assignment('a1', alice, 'editor')]);
    await m.init(initCtx());
    expect(m.roleGraph().get('editor')?.closure).to.deep.equal(['editor', 'viewer']);
    expect((await check(m, alice, 'file:read')).permitWhen).to.deep.equal(TRUE);
  });

  it('compile hooks run once, right after the grant index is built', async () => {
    const seen: [RoleGraph, GrantIndex, PermissionRegistry][] = [];
    const m = make([{ compile: (g, i, r) => void seen.push([g, i, r]) }]);
    await m.init(initCtx());
    const index = m.grantIndex();
    m.grantIndex();
    expect(seen).to.have.length(1);
    expect(seen[0][0]).to.equal(m.roleGraph());
    expect(seen[0][1]).to.equal(index);
    expect(seen[0][2].get('file:read')?.name).to.equal('file:read');
  });

  it('a compile hook that throws fails the contributor (the boot), every time', async () => {
    const m = make([
      {
        compile: () => {
          throw new AuthzConfigError("rbac role 'editor' implies unknown role 'ghost'");
        },
      },
    ]);
    await m.init(initCtx());
    const contributor = new RbacContributor(m);
    for (let i = 0; i < 2; i++) {
      const err = await rejects(Promise.resolve().then(() => contributor.contribute('test')));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('ghost');
    }
  });

  it('gather results are merged into the input the steps see', async () => {
    const m = make([{ gather: (_req, _ctx, input) => ({ assignments: [...input.assignments, assignment('x1', alice, 'viewer')] }) }]);
    await m.init(initCtx());
    expect((await check(m, alice, 'file:read')).permitWhen).to.deep.equal(TRUE);
  });

  it('gather sees the rule and link stores of the model options', async () => {
    let seen: unknown;
    const rules = { name: 'r' } as never;
    const links = {} as never;
    const m = new RbacModel({ roles: new MemoryRoleStore(ladderRoles), assignments: new MemoryAssignmentStore(), rules, links, log, extensions: [{ gather: (_r, _c, _i, sources) => ((seen = [sources.rules, sources.links]), {}) }] });
    await m.init(initCtx());
    await check(m, alice, 'file:read');
    expect(seen).to.deep.equal([rules, links]);
  });

  it('contribute results are merged into the contributor output', async () => {
    const m = make([{ contribute: () => ({ relationRefs: [{ type: 'file', relation: 'owner', source: 'x' }], permissionRefs: [{ permission: 'file:write', source: 'ext' }] }) }]);
    await m.init(initCtx());
    const out = await new RbacContributor(m).contribute('test');
    expect(out.relationRefs).to.deep.equal([{ type: 'file', relation: 'owner', source: 'x' }]);
    expect(out.permissionRefs?.map((r) => r.source)).to.deep.equal(["rbac role 'viewer' grant 'file:read'", "rbac role 'editor' grant 'file:write'", 'ext']);
  });

  it('an extension contribution that is not an array is refused, naming the key', async () => {
    const m = make([{ contribute: () => ({ relationRefs: 'owner' } as never) }]);
    await m.init(initCtx());
    const err = await rejects(Promise.resolve().then(() => new RbacContributor(m).contribute('test')));
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.contain('relationRefs');
  });

  it('needsSubject is true when any extension needs the subject', () => {
    expect(make([]).capabilities.needsSubject).to.equal(false);
    expect(make([{ capabilities: { needsSubject: false } }]).capabilities.needsSubject).to.equal(false);
    expect(make([{}, { capabilities: { needsSubject: true } }]).capabilities.needsSubject).to.equal(true);
  });

  it('extension factories receive the model options', () => {
    const opts = { roles: new MemoryRoleStore(), assignments: new MemoryAssignmentStore(), rules: {} as never, log };
    const seen: unknown[] = [];
    const made = createRbacExtensions(opts, [(o) => (seen.push(o), {}), () => ({ residuals: ['native:x'] })]);
    expect(seen).to.deep.equal([opts]);
    expect(made).to.have.length(2);
    expect(Object.isFrozen(made)).to.equal(true);
  });

  it('residuals join the capabilities and native filters are registered at init', async () => {
    const filter = { op: 'native:rbac.test', matches: () => true } as unknown as NativeFilter;
    const m = make([{ residuals: ['native:rbac.test'], nativeFilters: () => [filter] }]);
    const ctx = initCtx();
    await m.init(ctx);
    expect(m.capabilities.residuals).to.deep.equal([...CORE_FILTER_OPS, 'native:rbac.test']);
    expect(ctx.registered.nativeFilters).to.deep.equal([filter]);
  });

  it('each model gets its own extensions from the default factories, then the token role rules', () => {
    const a = new RbacModel({ roles: new MemoryRoleStore(), assignments: new MemoryAssignmentStore(), log });
    const b = new RbacModel({ roles: new MemoryRoleStore(), assignments: new MemoryAssignmentStore(), log });
    expect(a.extensions).to.have.length(DEFAULT_RBAC_EXTENSIONS.length + 1);
    expect(isTokenRoleExtension(a.extensions[a.extensions.length - 1])).to.equal(true);
    a.extensions.forEach((e, i) => expect(e).to.not.equal(b.extensions[i]));
    expect(Object.isFrozen(a.extensions)).to.equal(true);
  });
});

describe('authz-rbac model: RbacContributor', () => {
  it('compiles the grants at boot and refers to every literal grant permission', async () => {
    const roles = [role('viewer', ['file:read', 'file:*']), role('writer', ['file:write'], { extends: ['viewer'] })];
    const m = new RbacModel({ roles: new MemoryRoleStore(roles), assignments: new MemoryAssignmentStore(), log });
    await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
    const out = await new RbacContributor(m).contribute('test');
    expect(out.permissionRefs).to.deep.equal([
      { permission: 'file:read', source: "rbac role 'viewer' grant 'file:read'" },
      { permission: 'file:write', source: "rbac role 'writer' grant 'file:write'" },
    ]);
  });

  it('refers to each grant relation once per type of the granted permission (B05 rule 8), naming role and permission', async () => {
    const grants = (name: string, list: RoleDef['grants'], extra: Partial<RoleDef> = {}): RoleDef => ({ ...role(name, [], extra), grants: list });
    const roles = [
      grants('owner', [{ permission: 'file:read', relation: 'owner' }]),
      grants('lead', [{ permission: 'file:*', relation: 'member' }], { extends: ['owner'] }),
      grants('dup', [
        { permission: 'file:write', relation: 'owner' },
        { permission: 'file:write', relation: 'owner' },
      ]),
      role('plain', ['file:read']),
    ];
    const m = new RbacModel({ roles: new MemoryRoleStore(roles), assignments: new MemoryAssignmentStore(), log });
    await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry([{ name: 'file:read', types: ['file', 'folder'] }, 'file:write']) }));
    const out = await new RbacContributor(m).contribute('test');
    expect(out.relationRefs).to.deep.equal([
      { type: 'file', relation: 'owner', source: "rbac role 'owner' grant 'file:read'" },
      { type: 'folder', relation: 'owner', source: "rbac role 'owner' grant 'file:read'" },
      { type: 'file', relation: 'member', source: "rbac role 'lead' grant 'file:read' (from 'file:*')" },
      { type: 'folder', relation: 'member', source: "rbac role 'lead' grant 'file:read' (from 'file:*')" },
      { type: 'file', relation: 'member', source: "rbac role 'lead' grant 'file:write' (from 'file:*')" },
      { type: 'file', relation: 'owner', source: "rbac role 'dup' grant 'file:write'" },
    ]);
  });

  const contributed = async (roles: readonly RoleDef[], permissions: Parameters<typeof registry>[0]) => {
    const m = new RbacModel({ roles: new MemoryRoleStore(roles), assignments: new MemoryAssignmentStore(), log });
    await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry(permissions) }));
    return new RbacContributor(m).contribute('test');
  };
  const withGrants = (name: string, list: RoleDef['grants']): RoleDef => ({ ...role(name), grants: list });

  it('an implied permission gets refs for its own types, with the grant as written in the source', async () => {
    const out = await contributed(
      [withGrants('w', [{ permission: 'file:write', relation: 'owner' }])],
      [
        { name: 'file:read', types: ['file', 'folder'] },
        { name: 'file:write', types: ['file'], implies: ['file:read'] },
      ],
    );
    expect(out.relationRefs).to.deep.equal([
      { type: 'file', relation: 'owner', source: "rbac role 'w' grant 'file:read' (from 'file:write')" },
      { type: 'folder', relation: 'owner', source: "rbac role 'w' grant 'file:read' (from 'file:write')" },
      { type: 'file', relation: 'owner', source: "rbac role 'w' grant 'file:write'" },
    ]);
  });

  it('on patterns narrow the ref types: a type-only or glob pattern to its type, an exact id keeps every type below the node', async () => {
    const roles = [withGrants('typed', [{ permission: 'file:read', relation: 'owner', on: [{ type: 'folder' }] }]), withGrants('globbed', [{ permission: 'file:read', relation: 'owner', on: [{ type: 'doc', id: 'pub-*' }] }]), withGrants('exact', [{ permission: 'file:read', relation: 'member', on: [{ type: 'dir', id: 'home' }] }]), withGrants('outside', [{ permission: 'file:read', relation: 'owner', on: [{ type: 'note' }] }])];
    const out = await contributed(roles, [{ name: 'file:read', types: ['file', 'folder', 'doc'] }]);
    expect(out.relationRefs).to.deep.equal([
      { type: 'folder', relation: 'owner', source: "rbac role 'typed' grant 'file:read'" },
      { type: 'doc', relation: 'owner', source: "rbac role 'globbed' grant 'file:read'" },
      { type: 'file', relation: 'member', source: "rbac role 'exact' grant 'file:read'" },
      { type: 'folder', relation: 'member', source: "rbac role 'exact' grant 'file:read'" },
      { type: 'doc', relation: 'member', source: "rbac role 'exact' grant 'file:read'" },
    ]);
  });

  it('a malformed pattern fails the boot, naming the role and the grant', async () => {
    const err = await rejects(contributed([withGrants('bad', [{ permission: 'file:read', on: [{ type: 'file', id: '{env.now}' }] }])], ['file:read']));
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.contain("rbac role 'bad' grant 'file:read'");
  });

  it('throws UnknownPermission naming a grant of an unregistered permission (B02)', async () => {
    const m = new RbacModel({ roles: new MemoryRoleStore([role('editor', ['file:read', 'ghost:read'])]), assignments: new MemoryAssignmentStore(), log });
    await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
    const err = await rejects(Promise.resolve().then(() => new RbacContributor(m).contribute('test')));
    expect(err).to.be.instanceOf(UnknownPermission);
    expect(err.message).to.contain('ghost:read');
  });

  it('refuses to contribute for a model that has not run init', async () => {
    const m = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(), log });
    expect(await rejects(Promise.resolve().then(() => new RbacContributor(m).contribute('test')))).to.be.instanceOf(AuthzConfigError);
  });
});

describe('authz-rbac model: memory stores', () => {
  const set: AssignmentSubject = { set: { role: 'org.member', scope: { type: 'org', id: 'o1' } } };

  it('MemoryAssignmentStore.forSubjects returns live rows of the given subjects', async () => {
    const store = new MemoryAssignmentStore([assignment('a1', alice, 'viewer'), assignment('a2', alice, 'writer', { expiresAt: NOW }), assignment('a3', alice, 'writer', { expiresAt: new Date(NOW.getTime() + 1) }), assignment('b1', bob, 'viewer'), { id: 's1', subject: set, role: 'viewer', scope: GLOBAL, source: 'test' }]);
    expect((await store.forSubjects([{ type: 'user', id: 'alice' }], NOW)).map((a) => a.id)).to.deep.equal(['a1', 'a3']);
    expect((await store.forSubjects([{ set: { role: 'org.member', scope: { type: 'org', id: 'o1' } } }], NOW)).map((a) => a.id)).to.deep.equal(['s1']);
    expect((await store.forSubjects([{ set: { role: 'org.member', scope: { type: 'org', id: 'o2' } } }], NOW)).map((a) => a.id)).to.deep.equal([]);
    expect(await store.forSubjects([], NOW)).to.deep.equal([]);
  });

  it('MemoryAssignmentStore.holders, byId (expired rows too), add and remove', async () => {
    const store = new MemoryAssignmentStore([assignment('a1', alice, 'viewer', { expiresAt: new Date(NOW.getTime() - 1) }), assignment('b1', bob, 'viewer')]);
    expect(await store.holders('viewer', GLOBAL, NOW)).to.deep.equal([{ type: 'user', id: 'bob' }]);
    expect((await store.byId('a1'))?.id).to.equal('a1');
    expect(await store.byId('nope')).to.equal(null);
    store.add(assignment('c1', alice, 'writer'));
    expect((await store.forSubjects([{ type: 'user', id: 'alice' }], NOW)).map((a) => a.id)).to.deep.equal(['c1']);
    store.remove('c1');
    expect(await store.byId('c1')).to.equal(null);
    expect(() => store.add(assignment('b1', bob, 'writer'))).to.throw();
  });

  it('MemoryRoleStore serves its roles and ladders and changes version on set', async () => {
    const store = new MemoryRoleStore([role('a')], [{ name: 'l', roles: ['a'] }]);
    const v1 = await store.version();
    expect((await store.load()).roles.map((r) => r.name)).to.deep.equal(['a']);
    expect((await store.load()).ladders).to.deep.equal([{ name: 'l', roles: ['a'] }]);
    store.set([role('b')]);
    expect(await store.version()).not.to.equal(v1);
    expect((await store.load()).roles.map((r) => r.name)).to.deep.equal(['b']);
    expect((await store.load()).ladders).to.deep.equal([]);
  });
});
