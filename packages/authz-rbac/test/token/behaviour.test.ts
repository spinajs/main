import type { AuthzService, Principal } from '@spinajs/authz';
import { fixtureDsl, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, HostSetup, World } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { TokenRolePolicy } from '../../src/index.js';
import type { RbacModel } from '../../src/index.js';
import { rbacHarness } from '../model/harness.js';
import { tokenHandle, tokenPrincipal } from './token-handle.js';
import type { TokenPrincipalRequest } from './token-handle.js';

const expect = chai.expect;
const { assignment, combine, ref, role } = fixtureDsl;

const PARTS = ['B07.token', 'B24.token', 'B37.token'] as const;

interface TokenHarnessOptions {
  /** The cross-request decision cache at the host defaults; the kit turns it off without the `cache` facet. */
  readonly cache?: boolean;
  readonly policy?: new () => TokenRolePolicy;
  readonly onModel?: (model: RbacModel) => void;
}

/** rbacHarness with the token lane handle; the world's `config.token` reaches `authz.token` through hostHarness. */
const tokenHarness = (opts: TokenHarnessOptions = {}): BehaviourHarness =>
  rbacHarness({
    facets: ['token'],
    register(host: HostSetup, model: RbacModel) {
      opts.onModel?.(model);
      if (opts.cache) host.setConfig(['authz', 'domains', host.domain, 'cache'], { maxEntries: 10_000, ttlSeconds: 60 });
      if (opts.policy) {
        host.container.register(opts.policy).as(TokenRolePolicy);
        host.setConfig(['authz', 'token', 'rolePolicy'], { service: opts.policy.name });
      }
    },
    extend: (_host, session) => ({ lane: { token: tokenHandle(session.clock!) } }),
  });

runBehaviour(PARTS, () => tokenHarness(), { strict: true, timeoutMs: 30_000 });

describe('token parts with the decision cache on', () => {
  runBehaviour(PARTS, () => tokenHarness({ cache: true }), { strict: true, timeoutMs: 30_000 });
});

const alice = userPrincipal('alice', { attributes: { team: 'red' } });
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');

/**
 * alice holds viewer and route.export at GLOBAL, editor at p1 and route.write (file:write) at p2.
 * f1 lies under p1, f2 under p2.
 */
const world: World = {
  permissions: ['file:read', 'file:write', 'report:export'],
  principals: { alice },
  adapters: [{ types: ['file'], rows: { file: [{ id: 'f1' }, { id: 'f2' }] }, parents: [[f1, P1] as const, [f2, P2] as const] }],
  scopes: [{ nodes: [{ ref: P1 }, { ref: P2 }] }],
  combine: combine('deny-overrides', 'rbac'),
  config: { token: { excludedRoles: ['route.*'] } },
  rbac: {
    roles: [role('viewer', ['file:read']), role('editor', ['file:write']), role('route.write', ['file:write']), role('route.export', ['report:export'])],
    assignments: [assignment('a1', alice, 'viewer'), assignment('a2', alice, 'route.export'), assignment('a3', alice, 'editor', P1), assignment('a4', alice, 'route.write', P2)],
  },
};

/** Lets a token pinned to a profile use only the role of that name (2.x profiles, design §18.3(e)). */
class ProfileTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(_owner: Principal, roles: readonly string[], profile?: string): readonly string[] {
    return profile === undefined ? roles : roles.filter((r) => r === profile);
  }
}

interface Opened {
  readonly session: HarnessSession;
  readonly authz: AuthzService;
  readonly model: RbacModel;
  token(req: Omit<TokenPrincipalRequest, 'owner'>): Promise<Principal>;
}

function useHarness(opts: Omit<TokenHarnessOptions, 'onModel'> = {}) {
  let model: RbacModel | undefined;
  const harness = tokenHarness({ ...opts, onModel: (m) => (model = m) });
  const sessions: HarnessSession[] = [];
  before(() => harness.beforeAll?.());
  after(() => harness.afterAll?.());
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.dispose();
  });
  return async (): Promise<Opened> => {
    const session = await harness.setup(world, { id: 'B24', part: 'token-local', case: 'token-local', title: 'token-local', facets: ['engine', 'rbac', 'list', 'token'] });
    sessions.push(session);
    const handle = session.lane!.token as ReturnType<typeof tokenHandle>;
    return { session, authz: session.authz as unknown as AuthzService, model: model!, token: (req) => handle.principal({ owner: alice, ...req }) };
  };
}

const allowed = async (authz: AuthzService, principal: Principal, permission: string, resource?: { type: string; id?: string }) => {
  const d = await authz.check({ principal, permission, ...(resource ? { resource } : {}) });
  return d.allowed && d.residual.op === 'true';
};

describe('authz-rbac token principals end to end (C5)', function () {
  this.timeout(30_000);

  describe('the token handle', () => {
    const now = new Date('2026-10-04T12:00:00.000Z');

    it('builds a pat principal as principalOf does: the owner, token facts, only the ceiling parts the token sets', () => {
      const plain = tokenPrincipal({ owner: alice }, 't1', now);
      expect(plain).to.deep.equal({ type: 'user', id: 'alice', authenticated: true, source: 'token', attributes: { team: 'red' }, authn: { method: 'token', strategy: 'token', assurance: 'aal1', mfa: [], authenticatedAt: now } });
      const scoped = tokenPrincipal({ owner: alice, roles: ['viewer'], scope: { permissions: ['file:read'], resources: [P1] }, profile: 'viewer' }, 't2', now);
      expect(scoped.ceiling).to.deep.equal({ roles: ['viewer'], permissions: ['file:read'], resources: [P1] });
      expect(scoped.attributes).to.deep.equal({ profile: 'viewer', team: 'red' });
    });

    it('refuses the creates the contract refuses (invalid_scope)', () => {
      expect(() => tokenPrincipal({ owner: alice, kind: 'agent' }, 't', now)).to.throw('invalid_scope');
      expect(() => tokenPrincipal({ owner: alice, kind: 'pat', scope: { agent: true } }, 't', now)).to.throw('invalid_scope');
      expect(() => tokenPrincipal({ owner: alice, roles: ['viewer'], scope: { agent: true } }, 't', now)).to.throw('invalid_scope');
      expect(() => tokenPrincipal({ owner: alice, profile: 'viewer', scope: { agent: true } }, 't', now)).to.throw('invalid_scope');
    });
  });

  describe('a lane-local world: alice on a project tree, authz.token.excludedRoles [route.*]', () => {
    const open = useHarness();

    it('B08: a pat token principal acts for nobody; an agent token principal acts for its owner with inherit', async () => {
      const { authz, token } = await open();
      const pat = await token({ roles: ['viewer'] });
      expect(pat.onBehalfOf).to.equal(undefined);
      expect(pat.delegation).to.equal(undefined);
      const agent = await token({ scope: { agent: true, permissions: ['file:read'] } });
      expect([agent.type, agent.delegation, agent.onBehalfOf?.type, agent.onBehalfOf?.id, agent.onBehalfOf?.authn?.method, agent.ceiling?.reason]).to.deep.equal(['agent', 'inherit', 'user', 'alice', 'token', 'out_of_scope']);
      const d = await authz.check({ principal: agent, permission: 'file:read', resource: f1 });
      expect([d.allowed, d.principal, d.actor]).to.deep.equal([true, { type: 'user', id: 'alice' }, { type: 'agent', id: agent.id }]);
    });

    it("an agent token whose Scope lists report:export cannot use it: route.* is excluded from the delegate's roles", async () => {
      const { authz, token } = await open();
      const agent = await token({ scope: { agent: true, permissions: ['file:read', 'report:export'] } });
      expect(await allowed(authz, alice, 'report:export')).to.equal(true);
      expect(await allowed(authz, agent, 'file:read', f1)).to.equal(true);
      expect(await allowed(authz, agent, 'report:export')).to.equal(false);
    });

    it('Scope.resources, token roles and excluded roles together, by check and by list', async () => {
      const { authz, session, token } = await open();
      const onP1 = await token({ roles: ['viewer', 'editor', 'route.write'], scope: { resources: [P1] } });
      const onP2 = await token({ roles: ['viewer', 'editor', 'route.write'], scope: { resources: [P2] } });
      expect(await allowed(authz, onP1, 'file:write', f1)).to.equal(true);
      expect(await allowed(authz, onP1, 'file:read', f2)).to.equal(false);
      expect(await allowed(authz, onP2, 'file:read', f2)).to.equal(true);
      expect(await allowed(authz, onP2, 'file:write', f2)).to.equal(false);
      expect(await allowed(authz, alice, 'file:write', f2)).to.equal(true);
      expect(await session.list!(alice, 'file:write', 'file')).to.deep.equal(['f1', 'f2']);
      expect(await session.list!(onP1, 'file:write', 'file')).to.deep.equal(['f1']);
      expect(await session.list!(onP1, 'file:read', 'file')).to.deep.equal(['f1']);
      expect(await session.list!(onP2, 'file:write', 'file')).to.deep.equal([]);
      expect(await session.list!(onP2, 'file:read', 'file')).to.deep.equal(['f2']);
    });

    it("summary lists neither an excluded role's permission nor one outside Scope.permissions", async () => {
      const { authz, token } = await open();
      const names = async (p: Principal) => (await authz.summary(p)).permissions.map((e) => e.name);
      expect(await names(alice)).to.deep.equal(['file:read', 'file:write', 'report:export']);
      expect(await names(await token({ scope: { permissions: ['file:read', 'report:export'] } }))).to.deep.equal(['file:read']);
    });
  });

  describe('a profile reaches the TokenRolePolicy as attributes.profile', () => {
    const open = useHarness({ policy: ProfileTokenRolePolicy });

    it('a token pinned to viewer cannot use editor; the same token without a profile can', async () => {
      const { authz, token } = await open();
      const pinned = await token({ profile: 'viewer' });
      const free = await token({});
      expect(pinned.attributes.profile).to.equal('viewer');
      expect(await allowed(authz, pinned, 'file:read', f1)).to.equal(true);
      expect(await allowed(authz, pinned, 'file:write', f1)).to.equal(false);
      expect(await allowed(authz, free, 'file:write', f1)).to.equal(true);
    });
  });

  describe('the decision cache is really on in the cached run', () => {
    const open = useHarness({ cache: true });

    it('a second identical check of a token principal is served without a model vote', async () => {
      const { authz, model, token } = await open();
      let votes = 0;
      const evaluate = model.evaluate.bind(model);
      model.evaluate = (req, ctx) => {
        votes++;
        return evaluate(req, ctx);
      };
      const t = await token({ roles: ['viewer', 'route.export'] });
      expect(await allowed(authz, t, 'report:export')).to.equal(false);
      const counted = votes;
      expect(await allowed(authz, t, 'report:export')).to.equal(false);
      expect(votes).to.equal(counted);
      expect(await allowed(authz, alice, 'report:export')).to.equal(true);
      expect(votes).to.be.above(counted);
    });
  });
});
