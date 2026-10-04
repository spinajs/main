import { GLOBAL } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';
import { agentPrincipal, fakeEvaluationContext, fixtureDsl, sealPrincipal, userPrincipal } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, World } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { RbacService, TokenRolePolicy } from '../../src/index.js';
import type { RbacModel } from '../../src/index.js';
import { rbacHarness } from '../model/harness.js';

const expect = chai.expect;
const { assignment, combine, ref, role } = fixtureDsl;

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');
const TOKEN_AUTHN = Object.freeze({ method: 'token', strategy: 'token', assurance: 'aal1' as const, mfa: [], authenticatedAt: new Date(0) });

/** alice through a personal access token; `roles` are the token's roles (ceiling.roles), as authn sets them. */
const token = (roles?: readonly string[]): Principal => sealPrincipal({ ...alice, source: 'token', authn: TOKEN_AUTHN, ...(roles ? { ceiling: { roles } } : {}) });

/** alice holds viewer, editor and route.export at GLOBAL; admin exists but alice lacks it. */
const world: World = {
  permissions: ['file:read', 'file:write', 'report:export', 'user:impersonate'],
  principals: { alice },
  adapters: [{ types: ['file'], rows: { file: [{ id: 'f1' }, { id: 'f2' }] } }],
  combine: combine('deny-overrides', 'rbac'),
  config: { token: { excludedRoles: ['route.*'] } },
  rbac: {
    roles: [role('viewer', ['file:read']), role('editor', ['file:write']), role('route.export', ['report:export']), role('admin', ['user:impersonate'])],
    assignments: [assignment('a1', alice, 'viewer'), assignment('a2', alice, 'editor'), assignment('a3', alice, 'route.export')],
  },
};

class RefuseEditorTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(_owner: Principal, roles: readonly string[]): readonly string[] {
    return roles.filter((r) => r !== 'editor');
  }
}

/** Answers roles alice lacks (and an excluded one) on top of what it is given. */
class GenerousTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(_owner: Principal, roles: readonly string[]): readonly string[] {
    return [...roles, 'admin', 'route.export'];
  }
}

interface Opened {
  readonly session: HarnessSession;
  readonly authz: AuthzService;
  readonly model: RbacModel;
}

function lane(opts: { readonly policy?: new () => TokenRolePolicy; readonly noExtensions?: boolean } = {}) {
  let model: RbacModel | undefined;
  const harness: BehaviourHarness = rbacHarness({
    ...(opts.noExtensions ? { extensions: () => [] } : {}),
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
      const session = await harness.setup(world, { id: 'B24', part: 'token', case: 'token', title: 'token', facets: ['engine', 'rbac', 'list'] });
      sessions.push(session);
      return { session, authz: session.authz as unknown as AuthzService, model: model! };
    },
  };
}

const allowed = async (authz: AuthzService, principal: Principal, permission: string, resource = GLOBAL) => {
  const d = await authz.check({ principal, permission, resource });
  return d.allowed && d.residual.op === 'true';
};

describe('authz-rbac token: role rules on token principals', function () {
  this.timeout(30_000);

  describe('default policy, authz.token.excludedRoles: [route.*]', () => {
    const l = lane();
    before(l.before);
    after(l.after);
    afterEach(l.dispose);

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

  describe('a session principal is untouched', () => {
    const withExt = lane();
    const without = lane({ noExtensions: true });
    before(withExt.before);
    after(withExt.after);
    afterEach(async () => {
      await withExt.dispose();
      await without.dispose();
    });

    it('decides as a model without the extension', async () => {
      const sessionAlice = sealPrincipal({ ...alice, authn: { ...TOKEN_AUTHN, method: 'password', strategy: 'local' } });
      const decide = async (l: ReturnType<typeof lane>) => {
        const { authz } = await l.open();
        const out: unknown[] = [];
        for (const p of [alice, sessionAlice]) {
          for (const permission of ['file:read', 'file:write', 'report:export', 'user:impersonate']) {
            const d = await authz.check({ principal: p, permission, resource: GLOBAL });
            out.push([permission, d.allowed, d.residual, d.roles, d.reason?.code]);
          }
          out.push(await authz.filter(p, 'file:write', 'file'));
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
    const l = lane({ policy: RefuseEditorTokenRolePolicy });
    before(l.before);
    after(l.after);
    afterEach(l.dispose);

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
      expect(await names(token(), true)).to.deep.equal(['viewer']);
      expect(await names(token(), false)).to.deep.equal(['viewer']);
      expect(await names(token(['editor', 'viewer']), false)).to.deep.equal(['viewer']);
      expect(await names(alice, true)).to.deep.equal(['editor', 'route.export', 'viewer']);
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
      expect((summary.roles ?? []).map((r) => r.role)).to.deep.equal(['viewer']);
      expect(summary.permissions.map((p) => p.name)).to.deep.equal(['file:read']);
      expect((await authz.summary(token())).permissions.map((p) => p.name)).to.deep.equal(['file:read']);
      expect((await authz.summary(alice)).permissions.map((p) => p.name)).to.deep.equal(['file:read', 'file:write', 'report:export']);
    });

    it('removes it in a type-level filter (list)', async () => {
      const { session } = await l.open();
      expect(await session.list!(token(), 'file:write', 'file')).to.deep.equal([]);
      expect(await session.list!(token(), 'file:read', 'file')).to.deep.equal(['f1', 'f2']);
      expect(await session.list!(alice, 'file:write', 'file')).to.deep.equal(['f1', 'f2']);
    });
  });

  describe('a policy that answers roles the owner lacks', () => {
    const l = lane({ policy: GenerousTokenRolePolicy });
    before(l.before);
    after(l.after);
    afterEach(l.dispose);

    it('adds none of them: never above the owner, no grant-subset path', async () => {
      const { authz, model } = await l.open();
      expect(await allowed(authz, token(['editor', 'admin']), 'user:impersonate')).to.equal(false);
      expect(await allowed(authz, token(), 'user:impersonate')).to.equal(false);
      expect(await allowed(authz, token(['viewer']), 'file:write', f1)).to.equal(false);
      expect(await allowed(authz, token(), 'report:export')).to.equal(false);
      const roles = (await new RbacService(model).rolesOf(token(['viewer', 'admin']), GLOBAL, { ceiling: false })).map((h) => h.role);
      expect(roles).to.deep.equal(['viewer']);
    });
  });
});
