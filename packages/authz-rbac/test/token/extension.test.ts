import { CORE_FILTER_OPS, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { AuthzService, DecisionRequest, Principal, ResourceFilter } from '@spinajs/authz';
import { agentPrincipal, fakeEvaluationContext, fakeModelInitContext, fixtureDsl, sealPrincipal, userPrincipal } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, HostSetup, World } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, OwnRolesTokenRolePolicy, RBAC_ASSIGNMENT_OP, RbacModel, RbacService, TokenRolePolicy, TokenRoleRules, isTokenRoleExtension, rbacAssignmentExtension, tokenRoleExtension } from '../../src/index.js';
import type { RbacExtension, RbacModelOptions, RoleDef } from '../../src/index.js';
import { rbacHarness } from '../model/harness.js';

const expect = chai.expect;
const { assignment, combine, ref, role } = fixtureDsl;

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const TOKEN_AUTHN = Object.freeze({ method: 'token', strategy: 'token', assurance: 'aal1' as const, mfa: [], authenticatedAt: new Date(0) });

/** alice through a personal access token; `roles` are the token's roles (ceiling.roles), as authn sets them. */
const token = (roles?: readonly string[]): Principal => sealPrincipal({ ...alice, source: 'token', authn: TOKEN_AUTHN, ...(roles ? { ceiling: { roles } } : {}) });

/**
 * alice holds viewer, editor, route.export and moderator (which extends commenter) at GLOBAL,
 * route.delete at p1 and deleter at p2. She lacks admin, reader (whose grant viewer covers) and
 * commenter (whose grants moderator holds).
 */
const world: World = {
  permissions: ['file:read', 'file:write', 'file:delete', 'file:comment', 'report:export', 'user:impersonate'],
  principals: { alice },
  adapters: [
    {
      types: ['file'],
      rows: { file: [{ id: 'f1' }, { id: 'f2' }] },
      parents: [[f1, P1] as const, [f2, P2] as const],
      compiles: [...CORE_FILTER_OPS, RBAC_ASSIGNMENT_OP],
    },
  ],
  scopes: [{ nodes: [{ ref: P1 }, { ref: P2 }] }],
  combine: combine('deny-overrides', 'rbac'),
  config: { token: { excludedRoles: ['route.*'] } },
  rbac: {
    roles: [role('viewer', ['file:read']), role('editor', ['file:write']), role('route.export', ['report:export']), role('admin', ['user:impersonate']), role('reader', ['file:read']), role('commenter', ['file:comment']), role('moderator', [], { extends: ['commenter'] }), role('deleter', ['file:delete']), role('route.delete', ['file:delete'])],
    assignments: [assignment('a1', alice, 'viewer'), assignment('a2', alice, 'editor'), assignment('a3', alice, 'route.export'), assignment('a4', alice, 'moderator'), assignment('a5', alice, 'route.delete', P1), assignment('a6', alice, 'deleter', P2)],
  },
};

class RefusingTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(_owner: Principal, roles: readonly string[]): readonly string[] {
    return roles.filter((r) => r !== 'editor' && r !== 'deleter');
  }
}

/** Answers roles alice lacks (and an excluded one) on top of what it is given. */
class GenerousTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(_owner: Principal, roles: readonly string[]): readonly string[] {
    return [...roles, 'admin', 'reader', 'commenter', 'route.export'];
  }
}

interface Opened {
  readonly session: HarnessSession;
  readonly authz: AuthzService;
  readonly model: RbacModel;
}

interface LaneOptions {
  readonly policy?: new () => TokenRolePolicy;
  readonly extensions?: (host: HostSetup, model: RbacModelOptions) => readonly RbacExtension[];
  /** The cross-request decision cache on (the `cache` facet). */
  readonly cache?: boolean;
}

function lane(opts: LaneOptions = {}) {
  let model: RbacModel | undefined;
  const harness: BehaviourHarness = rbacHarness({
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
    register(host, m) {
      model = m;
      if (opts.policy) {
        host.container.register(opts.policy).as(TokenRolePolicy);
        host.setConfig(['authz', 'token', 'rolePolicy'], { service: opts.policy.name });
      }
    },
  });
  const sessions: HarnessSession[] = [];
  return {
    before: () => harness.beforeAll?.(),
    after: () => harness.afterAll?.(),
    async dispose() {
      for (const s of sessions.splice(0)) await s.dispose();
    },
    async open(): Promise<Opened> {
      const session = await harness.setup(world, { id: 'B24', part: 'token', case: 'token', title: 'token', facets: ['engine', 'rbac', 'list', ...(opts.cache ? (['cache'] as const) : [])] });
      sessions.push(session);
      return { session, authz: session.authz as unknown as AuthzService, model: model! };
    },
  };
}

function useLane(opts: LaneOptions = {}) {
  const l = lane(opts);
  before(l.before);
  after(l.after);
  afterEach(l.dispose);
  return l;
}

const allowed = async (authz: AuthzService, principal: Principal, permission: string, resource = GLOBAL) => {
  const d = await authz.check({ principal, permission, resource });
  return d.allowed && d.residual.op === 'true';
};

type Node = { readonly op: string; readonly args?: unknown; readonly scopes?: readonly unknown[]; readonly term?: ResourceFilter };

const children = (f: ResourceFilter): readonly ResourceFilter[] => {
  const node = f as Node;
  return [...(Array.isArray(node.args) ? (node.args as ResourceFilter[]) : []), ...(node.term ? [node.term] : [])];
};

/** The roles of every native:rbac.assignment term in `f`. */
function nativeRoles(f: ResourceFilter): string[][] {
  const node = f as Node;
  if (node.op === RBAC_ASSIGNMENT_OP) return [[...(node.args as { roles: readonly string[] }).roles]];
  return children(f).flatMap(nativeRoles);
}

/** The scopes of every `under` term in `f`. */
function underScopes(f: ResourceFilter): unknown[] {
  const node = f as Node;
  if (node.op === 'under') return [...(node.scopes ?? [])];
  return children(f).flatMap(underScopes);
}

const ownRules = (excluded: readonly string[] = []) => new TokenRoleRules(excluded, new OwnRolesTokenRolePolicy());

describe('authz-rbac token: role rules on token principals', function () {
  this.timeout(30_000);

  describe('default policy, authz.token.excludedRoles: [route.*]', () => {
    const l = useLane();

    it('a token principal cannot use an excluded role; the same alice via session can (B24)', async () => {
      const { authz } = await l.open();
      expect(await allowed(authz, alice, 'report:export')).to.equal(true);
      expect(await allowed(authz, token(['editor', 'route.export']), 'report:export')).to.equal(false);
      expect(await allowed(authz, token(['editor', 'route.export']), 'file:write', f1)).to.equal(true);
    });

    it('a token principal without roles cannot use excluded roles either', async () => {
      const { authz } = await l.open();
      expect(await allowed(authz, token(), 'report:export')).to.equal(false);
      expect(await allowed(authz, token(), 'file:read', f1)).to.equal(true);
      expect(await allowed(authz, token(), 'file:write', f1)).to.equal(true);
    });

    it('a token role the owner lacks grants nothing (B07)', async () => {
      const { authz } = await l.open();
      expect(await allowed(authz, token(['editor', 'admin']), 'user:impersonate')).to.equal(false);
      expect(await allowed(authz, token(['editor', 'admin']), 'file:write', f1)).to.equal(true);
    });

    it("a token role the owner lacks grants nothing even when the owner's grants cover it (design 18.3(g))", async () => {
      const { authz } = await l.open();
      expect(await allowed(authz, alice, 'file:read', f1)).to.equal(true);
      expect(await allowed(authz, token(['reader']), 'file:read', f1)).to.equal(false);
      expect(await allowed(authz, alice, 'file:comment')).to.equal(true);
      expect(await allowed(authz, token(['commenter']), 'file:comment')).to.equal(false);
      expect(await allowed(authz, token(['moderator']), 'file:comment')).to.equal(true);
    });

    it('a scoped excluded role leaves the type-level filter and the list', async () => {
      const { authz, session } = await l.open();
      expect(underScopes(await authz.filter(alice, 'file:delete', 'file'))).to.deep.equal([P1, P2]);
      expect(underScopes(await authz.filter(token(), 'file:delete', 'file'))).to.deep.equal([P2]);
      expect(await session.list!(alice, 'file:delete', 'file')).to.deep.equal(['f1', 'f2']);
      expect(await session.list!(token(), 'file:delete', 'file')).to.deep.equal(['f2']);
      expect(await allowed(authz, token(), 'file:delete', f1)).to.equal(false);
      expect(await allowed(authz, token(), 'file:delete', f2)).to.equal(true);
    });

    it("an inherit agent for alice's token cannot use excluded roles through its delegate", async () => {
      const { authz } = await l.open();
      const agent = agentPrincipal('bot', token(), { permissions: ['file:read', 'report:export'] });
      expect(agent.ceiling?.reason).to.equal('out_of_scope');
      expect(await allowed(authz, agent, 'file:read', f1)).to.equal(true);
      expect(await allowed(authz, agent, 'report:export')).to.equal(false);
    });

    it('an agent that authenticated by token narrows its session delegate too', async () => {
      const { authz } = await l.open();
      const agent = agentPrincipal('bot', alice, { permissions: ['file:read', 'report:export'], authn: TOKEN_AUTHN });
      expect(await allowed(authz, agent, 'file:read', f1)).to.equal(true);
      expect(await allowed(authz, agent, 'report:export')).to.equal(false);
    });

    it('covers works for a token principal (the synchronous heldNow path)', async () => {
      const { authz, model } = await l.open();
      const service = new RbacService(model);
      await authz.preload(token());
      expect(service.covers(token(), ['viewer', 'editor'])).to.equal(true);
      expect(service.covers(token(), ['route.export'])).to.equal(false);
      expect(service.covers(alice, ['route.export'])).to.equal(true);
    });

    it('a type-level filter after preload answers without IO (B22)', async () => {
      const { authz } = await l.open();
      expect(authz.filterNow(token(), 'file:read', 'file')).to.equal(undefined);
      await authz.preload(token());
      expect(authz.filterNow(token(), 'file:read', 'file')?.op).to.equal('true');
    });
  });

  describe('with the decision cache on', () => {
    const l = useLane({ cache: true });

    it('session and token decisions of the same owner never share a cache entry', async () => {
      const { authz, model } = await l.open();
      let votes = 0;
      const evaluate = model.evaluate.bind(model);
      model.evaluate = (req, ctx) => {
        votes++;
        return evaluate(req, ctx);
      };
      expect(await allowed(authz, alice, 'report:export')).to.equal(true);
      expect(await allowed(authz, token(['editor', 'route.export']), 'report:export')).to.equal(false);
      const counted = votes;
      expect(await allowed(authz, alice, 'report:export')).to.equal(true);
      expect(votes).to.equal(counted, 'the repeated session check is a cache hit');
      expect(await allowed(authz, token(['editor', 'route.export']), 'report:export')).to.equal(false);
      expect(await allowed(authz, token(['viewer']), 'file:write', f1)).to.equal(false);
      expect(await allowed(authz, token(['editor']), 'file:write', f1)).to.equal(true);
      expect(await allowed(authz, token(['viewer']), 'file:write', f1)).to.equal(false);
      expect(await allowed(authz, token(), 'report:export')).to.equal(false);
      expect(await allowed(authz, alice, 'report:export')).to.equal(true);
      expect(await allowed(authz, alice, 'file:write', f1)).to.equal(true);
    });
  });

  describe('a session principal is untouched', () => {
    const withExt = lane();
    // The token rules always run; trivial rules make them a no-op, which is the baseline.
    const without = lane({ extensions: (_host, o) => [tokenRoleExtension(o, { rules: ownRules() })] });
    before(withExt.before);
    before(without.before);
    after(without.after);
    after(withExt.after);
    afterEach(async () => {
      await withExt.dispose();
      await without.dispose();
    });

    it('decides as a model without token rules', async () => {
      const sessionAlice = sealPrincipal({ ...alice, authn: { ...TOKEN_AUTHN, method: 'password', strategy: 'local' } });
      const decide = async (l: ReturnType<typeof lane>) => {
        const { authz } = await l.open();
        const out: unknown[] = [];
        for (const p of [alice, sessionAlice]) {
          for (const permission of ['file:read', 'file:write', 'file:delete', 'report:export', 'user:impersonate']) {
            const d = await authz.check({ principal: p, permission, resource: GLOBAL });
            out.push([permission, d.allowed, d.residual, d.roles, d.reason?.code]);
          }
          out.push(await authz.filter(p, 'file:delete', 'file'));
        }
        await l.dispose();
        return out;
      };
      const mine = await decide(withExt);
      expect(mine).to.deep.equal(await decide(without));
      expect(mine).to.deep.include(['report:export', true, { op: 'true' }, {}, undefined]);
    });
  });

  describe('a custom policy registered by name', () => {
    const l = useLane({ policy: RefusingTokenRolePolicy });

    it('removes a role at check time', async () => {
      const { authz } = await l.open();
      expect(await allowed(authz, token(), 'file:write', f1)).to.equal(false);
      expect(await allowed(authz, token(), 'file:read', f1)).to.equal(true);
      expect(await allowed(authz, alice, 'file:write', f1)).to.equal(true);
    });

    it('removes it in rolesOf, with and without ceiling: false', async () => {
      const { model } = await l.open();
      const service = new RbacService(model);
      const names = async (p: Principal, ceiling: boolean) => (await service.rolesOf(p, GLOBAL, { ceiling })).map((h) => h.role).sort();
      expect(await names(token(), true)).to.deep.equal(['moderator', 'viewer']);
      expect(await names(token(), false)).to.deep.equal(['moderator', 'viewer']);
      expect(await names(token(['editor', 'viewer']), false)).to.deep.equal(['viewer']);
      expect(await names(alice, true)).to.deep.equal(['editor', 'moderator', 'route.export', 'viewer']);
    });

    it('removes it in covers and coversAt', async () => {
      const { authz, model, session } = await l.open();
      const service = new RbacService(model);
      await authz.preload(token());
      expect(service.covers(token(), ['viewer'])).to.equal(true);
      expect(service.covers(token(), ['editor'])).to.equal(false);
      const ctx = fakeEvaluationContext({ now: session.clock!.now() });
      expect(await service.coversAt(token(), ['viewer'], GLOBAL, ctx)).to.equal(true);
      expect(await service.coversAt(token(), ['editor'], GLOBAL, ctx)).to.equal(false);
    });

    it('removes it in summarize and summary', async () => {
      const { authz, model, session } = await l.open();
      const summary = await model.summarize(token(), GLOBAL, fakeEvaluationContext({ now: session.clock!.now() }));
      expect((summary.roles ?? []).map((r) => r.role).sort()).to.deep.equal(['moderator', 'viewer']);
      expect(summary.permissions.map((p) => p.name)).to.deep.equal(['file:comment', 'file:read']);
      expect((await authz.summary(token())).permissions.map((p) => p.name)).to.deep.equal(['file:comment', 'file:read']);
      expect((await authz.summary(alice)).permissions.map((p) => p.name)).to.deep.equal(['file:comment', 'file:delete', 'file:read', 'file:write', 'report:export']);
    });

    it('removes it in a type-level filter (list), scoped assignments included', async () => {
      const { authz, session } = await l.open();
      expect(await session.list!(token(), 'file:write', 'file')).to.deep.equal([]);
      expect(await session.list!(token(), 'file:read', 'file')).to.deep.equal(['f1', 'f2']);
      expect(await session.list!(alice, 'file:write', 'file')).to.deep.equal(['f1', 'f2']);
      expect(await authz.filter(token(), 'file:delete', 'file')).to.deep.equal({ op: 'false' });
      expect(await session.list!(token(), 'file:delete', 'file')).to.deep.equal([]);
      expect(await session.list!(alice, 'file:delete', 'file')).to.deep.equal(['f1', 'f2']);
    });
  });

  describe('a policy that answers roles the owner lacks', () => {
    const l = useLane({ policy: GenerousTokenRolePolicy });

    it('adds none of them: never above the owner, no grant-subset path', async () => {
      const { authz, model } = await l.open();
      expect(await allowed(authz, token(['editor', 'admin']), 'user:impersonate')).to.equal(false);
      expect(await allowed(authz, token(), 'user:impersonate')).to.equal(false);
      expect(await allowed(authz, token(['viewer']), 'file:write', f1)).to.equal(false);
      expect(await allowed(authz, token(), 'report:export')).to.equal(false);
      expect(await allowed(authz, token(['reader']), 'file:read', f1)).to.equal(false);
      expect(await allowed(authz, token(['commenter']), 'file:comment')).to.equal(false);
      const roles = (await new RbacService(model).rolesOf(token(['viewer', 'admin', 'reader']), GLOBAL, { ceiling: false })).map((h) => h.role);
      expect(roles).to.deep.equal(['viewer']);
    });
  });

  describe('an app that passes its own extensions (rbacAssignmentExtension)', () => {
    const l = useLane({ extensions: (_host, o) => [rbacAssignmentExtension(o)] });

    it('still narrows token principals, in checks and in native:rbac.assignment args', async () => {
      const { authz, model, session } = await l.open();
      expect(model.extensions).to.have.length(2);
      expect(isTokenRoleExtension(model.extensions[1])).to.equal(true);
      expect(await allowed(authz, alice, 'report:export')).to.equal(true);
      expect(await allowed(authz, token(['editor', 'route.export']), 'report:export')).to.equal(false);
      expect(nativeRoles(await authz.filter(alice, 'file:delete', 'file'))).to.deep.equal([['deleter'], ['route.delete']]);
      expect(nativeRoles(await authz.filter(token(), 'file:delete', 'file'))).to.deep.equal([['deleter']]);
      expect(await session.list!(token(), 'file:delete', 'file')).to.deep.equal(['f2']);
    });
  });

  describe('a refusing policy with rbacAssignmentExtension', () => {
    const l = useLane({ policy: RefusingTokenRolePolicy, extensions: (_host, o) => [rbacAssignmentExtension(o)] });

    it('leaves no native:rbac.assignment term for refused or excluded roles', async () => {
      const { authz, session } = await l.open();
      expect(await authz.filter(token(), 'file:delete', 'file')).to.deep.equal({ op: 'false' });
      expect(await session.list!(token(), 'file:delete', 'file')).to.deep.equal([]);
      expect(nativeRoles(await authz.filter(alice, 'file:delete', 'file'))).to.deep.equal([['deleter'], ['route.delete']]);
    });
  });

  describe('RbacModel always runs the token role rules, last', () => {
    const NOW = new Date('2026-10-01T12:00:00.000Z');
    const roles = (world.rbac!.roles as RoleDef[]).filter((r) => ['viewer', 'route.export'].includes(r.name));
    const rows = world.rbac!.assignments!.filter((a) => ['viewer', 'route.export'].includes(a.role));
    const log = { warn: () => undefined };
    const opts = (): RbacModelOptions => ({ roles: new MemoryRoleStore(roles), assignments: new MemoryAssignmentStore(rows), log });

    /** Hands back every stored row and the request it was given, as a gather built from the store would. */
    const freshGather = (): RbacExtension => ({
      gather: (request: DecisionRequest) => ({ assignments: [...rows], request: { ...request } }),
    });

    async function model(extensions: readonly RbacExtension[]): Promise<RbacModel> {
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'file:read' }, { name: 'report:export' }], 'test');
      registry.freeze();
      const m = new RbacModel({ ...opts(), extensions });
      await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
      return m;
    }

    const permits = async (m: RbacModel, p: Principal, permission: string) => (await m.evaluate({ principal: p, permission, resource: GLOBAL }, fakeEvaluationContext({ now: NOW }))).permitWhen.op === 'true';

    it('builds a frozen, branded extension', () => {
      const ext = tokenRoleExtension(opts());
      expect(Object.isFrozen(ext)).to.equal(true);
      expect(isTokenRoleExtension(ext)).to.equal(true);
    });

    it('adds one when the extensions passed have none', async () => {
      const fresh = freshGather();
      const m = await model([fresh]);
      expect(m.extensions).to.have.length(2);
      expect(m.extensions[0]).to.equal(fresh);
      expect(isTokenRoleExtension(m.extensions[1])).to.equal(true);
      expect(isTokenRoleExtension(fresh)).to.equal(false);
      expect(Object.isFrozen(m.extensions)).to.equal(true);
    });

    it('moves an explicitly passed token extension last, keeping that instance', async () => {
      const tokenExt = tokenRoleExtension(opts(), { rules: ownRules(['route.*']) });
      const fresh = freshGather();
      const m = await model([tokenExt, fresh]);
      expect(m.extensions).to.have.length(2);
      expect(m.extensions[0]).to.equal(fresh);
      expect(m.extensions[1]).to.equal(tokenExt);
    });

    it('a later gather that returns fresh assignments and request does not undo the narrowing', async () => {
      const m = await model([tokenRoleExtension(opts(), { rules: ownRules(['route.*']) }), freshGather()]);
      expect(await permits(m, alice, 'report:export')).to.equal(true);
      expect(await permits(m, token(), 'report:export')).to.equal(false);
      expect(await permits(m, token(['viewer', 'route.export']), 'report:export')).to.equal(false);
      expect(await permits(m, token(), 'file:read')).to.equal(true);
      const held = await new RbacService(m).rolesOf(token(), GLOBAL, { ceiling: false });
      expect(held.map((h) => h.role)).to.deep.equal(['viewer']);
    });
  });
});
