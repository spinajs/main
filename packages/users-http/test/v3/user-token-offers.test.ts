import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { RoleSource, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, TokenCreateResult, TokenRecord, TokenValidation } from '@spinajs/authn/contracts';
import { RbacService, TokenRolePolicy } from '@spinajs/authz-rbac';
import type { User } from '@spinajs/users';

import { UserController } from '../../src/controllers/UserController.js';
import { rootAdmin } from '../support/authz-host.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { RoleDefs, UsersHttpApp } from '../support/http-app.js';
import { REAUTH_STRATEGIES } from '../support/reauth-strategy.js';
import { TOKEN_STRATEGY, bearerTokenOf } from '../support/token-strategy.js';

/** Narrows the token roles as an application's policy would; `authz.token.rolePolicy.service` names it in this suite. */
class UsersHttpOfferTokenRolePolicy extends TokenRolePolicy {
  public static readonly broken = new Set<string>();

  public allowedRoles(owner: Principal, roles: readonly string[], profile?: string): readonly string[] {
    if (UsersHttpOfferTokenRolePolicy.broken.has(owner.id)) throw new Error('offer test: the token role policy fails');
    return profile ? roles.filter((r) => r === profile || r === 'user') : roles.filter((r) => r !== 'policy-refused');
  }
}

/** Stands in for authn-token's TokenProfilePolicy, under the DI name authn-token registers it by. */
class UsersHttpOfferProfilePolicy {
  public static answer: unknown = ['editor'];

  public async allowedProfiles(_owner: IdentityRef): Promise<unknown> {
    return UsersHttpOfferProfilePolicy.answer;
  }
}

/** Turns the token routes on; users-http calls nothing on it but `revokeAllFor` (account lifecycle). */
class UsersHttpOfferTokenService extends TokenService {
  public async revokeAllFor(): Promise<number> {
    return 0;
  }

  public create(_owner: IdentityRef, _opts: unknown, _ctx: AuthnContext): Promise<TokenCreateResult> {
    throw new Error('not used');
  }

  public list(): Promise<readonly TokenRecord[]> {
    throw new Error('not used');
  }

  public revoke(): Promise<boolean> {
    throw new Error('not used');
  }

  public validate(): Promise<TokenValidation> {
    throw new Error('not used');
  }
}

// DI has no clean undo: an unregistered class leaves its key behind, and users' account actions would then resolve a
// bare TokenService. These stay registered for the rest of the process; none changes another suite.
let registered = { policy: false, tokens: false, profiles: false };

function registerOnce(what: keyof typeof registered, register: () => void): void {
  if (!registered[what]) {
    registered = { ...registered, [what]: true };
    register();
  }
}

const ROLES = '/user/tokens/roles';
const PROFILES = '/user/tokens/profiles';

/**
 * `GET /user/tokens/roles` and `/user/tokens/profiles` (2.x AccessTokenController, C5/N6 hand-off): what authn-http's
 * `POST /user/tokens` would accept from this caller, narrowed to what a token keeps at check time (`authz.token`).
 */
describe('users-http v3: GET /user/tokens/roles and /user/tokens/profiles', function () {
  this.timeout(120000);

  let app: UsersHttpApp;
  let me: User;
  let plain: User;
  let bystander: User;
  let broken: User;
  let support: User;
  let impersonated: User;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    registerOnce('policy', () => DI.register(UsersHttpOfferTokenRolePolicy).as(TokenRolePolicy));
    app = await startUsersHttpApp({
      controllers: [UserController],
      roles: (shipped: RoleDefs): RoleDefs => ({
        ...shipped,
        editor: {},
        reviewer: {},
        'route.home': {},
        'policy-refused': {},
        'scoped-role': {},
        unheld: {},
        bystander: {},
        // Unconditional, so the impersonating support account covers the target it impersonates.
        reader: { grants: ['user:read'] },
      }),
      config: {
        'authz.token.excludedRoles': ['route.*'],
        'authz.token.rolePolicy.service': 'UsersHttpOfferTokenRolePolicy',
        'authn.strategies': [...REAUTH_STRATEGIES, TOKEN_STRATEGY],
      },
    });

    me = await app.seedUser({ login: 'me', roles: ['user', 'editor', 'reviewer', 'route.home', 'policy-refused'] });
    plain = await app.seedUser({ login: 'plain', roles: ['user'] });
    bystander = await app.seedUser({ login: 'bystander', roles: ['bystander'] });
    broken = await app.seedUser({ login: 'broken', roles: ['user', 'editor'] });
    support = await app.seedUser({ login: 'support', roles: ['admin', 'reader'] });
    impersonated = await app.seedUser({ login: 'impersonated', roles: ['reader'] });
    const scoped = await (await rootAdmin()).execute(SYSTEM, [{ kind: 'assignment.grant', subject: { type: 'user', id: me.Uuid }, role: 'scoped-role', scope: { type: 'authz', id: 'offer-test' } }], { reason: 'test seed' });
    expect(
      scoped.every((r) => r.ok),
      JSON.stringify(scoped),
    ).to.eq(true);
  });

  after(async () => {
    UsersHttpOfferTokenRolePolicy.broken.clear();
    await stopUsersHttpApp();
    sinon.restore();
  });

  // As authn-http's token routes: no TokenService, no token to create, nothing to offer.
  it('answers 404 to both routes while no TokenService is registered', async () => {
    expect(
      (DI.getRegisteredTypes(TokenService) ?? []).filter((t) => t !== TokenService),
      'no TokenService yet in this process',
    ).to.deep.eq([]);
    const client = await app.signIn(me.Uuid);

    for (const path of [ROLES, PROFILES]) {
      const res = await client.get(path);
      expect(res.status, `${path} ${res.text}`).to.eq(404);
      expect(res.text).to.not.contain('editor');
    }
  });

  describe('with a TokenService', () => {
    before(() => {
      registerOnce('tokens', () => DI.register(UsersHttpOfferTokenService).as(TokenService));
    });

    it('answers 401 to an anonymous request', async () => {
      for (const path of [ROLES, PROFILES]) {
        const res = await app.anonymous().get(path);
        expect(res.status, `${path} ${res.text}`).to.eq(401);
      }
    });

    it('offers the roles the caller holds, without the excluded roles and those the token role policy refuses', async () => {
      const res = await (await app.signIn(me.Uuid)).get(ROLES);

      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.deep.eq({ Roles: ['editor', 'reviewer', 'scoped-role', 'user'] });
      expect(res.headers['cache-control']).to.eq('no-store');
    });

    it('never offers a role the caller does not hold', async () => {
      const res = await (await app.signIn(plain.Uuid)).get(ROLES);

      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.deep.eq({ Roles: ['user'] });
    });

    // authn-token's create accepts `roles` only when the RoleSource gives the bare owner each of them (ownerHolds).
    it('offers only roles the create path accepts: each one is held by the owner as authn-token asks', async () => {
      const offered: string[] = (await (await app.signIn(me.Uuid)).get(ROLES)).body.Roles;
      const source = (await DI.resolve(RoleSource)) as RoleSource;
      const owner = { type: 'user', id: me.Uuid, authenticated: true, source: 'token', attributes: {} } as Parameters<RoleSource['rolesOf']>[0];
      const held = (await source.rolesOf(owner)).map((r) => r.role);

      expect(offered.filter((r) => !held.includes(r))).to.deep.eq([]);
      // Held, and accepted by create, but withheld: a token would get nothing from them.
      expect(held).to.include.members(['route.home', 'policy-refused']);
    });

    it('offers roles a token keeps at check time, unlike the withheld ones', async () => {
      const offered: string[] = (await (await app.signIn(me.Uuid)).get(ROLES)).body.Roles;
      expect(offered).to.include.members(['editor', 'reviewer', 'user']);
      const rbac = (await DI.resolve(RbacService)) as RbacService;
      const tokenOf = (roles: readonly string[]): Principal => ({ type: 'user', id: me.Uuid, authenticated: true, source: 'token', authn: { method: 'token' }, ceiling: { roles }, attributes: {} } as Principal);

      const kept = (await rbac.rolesOf(tokenOf(offered), GLOBAL)).map((r) => r.role);
      expect([...new Set(kept)].sort()).to.deep.eq(['editor', 'reviewer', 'user']);
      expect(await rbac.rolesOf(tokenOf(['route.home', 'policy-refused']), GLOBAL)).to.deep.eq([]);
    });

    it('answers 403 to a user whose roles do not grant user:read on its own record', async () => {
      const res = await (await app.signIn(bystander.Uuid)).get(ROLES);

      expect(res.status, res.text).to.eq(403);
      expect(res.body).to.not.have.property('Roles');
    });

    // POST /user/tokens refuses them, so neither route offers them anything.
    it('answers 403 session_required to a token caller', async () => {
      for (const path of [ROLES, PROFILES]) {
        const res = await app.anonymous().get(path, { Authorization: `Bearer ${bearerTokenOf(me.Uuid)}` });
        expect(res.status, `${path} ${res.text}`).to.eq(403);
        expect(res.body.error, res.text).to.eq('session_required');
      }
    });

    it('answers 403 impersonating to an impersonation session', async () => {
      const client = await app.signIn(impersonated.Uuid, { impersonator: { type: 'user', id: support.Uuid } });
      expect((await client.get('/user')).status, 'the impersonation session is live').to.eq(200);

      for (const path of [ROLES, PROFILES]) {
        const res = await client.get(path);
        expect(res.status, `${path} ${res.text}`).to.eq(403);
        expect(res.body.error, res.text).to.eq('impersonating');
      }
    });

    it('fails closed (500) when the token role policy fails, offering nothing', async () => {
      UsersHttpOfferTokenRolePolicy.broken.add(broken.Uuid);
      try {
        const res = await (await app.signIn(broken.Uuid)).get(ROLES);

        expect(res.status, res.text).to.eq(500);
        expect(res.body).to.not.have.property('Roles');
        expect(res.text).to.not.contain('editor');
      } finally {
        UsersHttpOfferTokenRolePolicy.broken.delete(broken.Uuid);
      }
    });

    it('offers no profile while no TokenProfilePolicy is registered, and no role for a profile', async () => {
      const client = await app.signIn(me.Uuid);

      const profiles = await client.get(PROFILES);
      expect(profiles.status, profiles.text).to.eq(200);
      expect(profiles.body).to.deep.eq({ Profiles: [] });
      expect(profiles.headers['cache-control']).to.eq('no-store');

      const roles = await client.get(`${ROLES}?profile=editor`);
      expect(roles.status, roles.text).to.eq(200);
      expect(roles.body).to.deep.eq({ Roles: [] });
    });

    describe("with authn-token's TokenProfilePolicy", () => {
      before(() => {
        registerOnce('profiles', () => DI.register(UsersHttpOfferProfilePolicy).as('TokenProfilePolicy'));
      });

      afterEach(() => {
        UsersHttpOfferProfilePolicy.answer = ['editor'];
      });

      it('offers the profiles the create path accepts', async () => {
        const res = await (await app.signIn(me.Uuid)).get(PROFILES);

        expect(res.status, res.text).to.eq(200);
        expect(res.body).to.deep.eq({ Profiles: ['editor'] });
      });

      it('offers the roles of a token pinned to an offered profile, as the token role policy narrows them', async () => {
        const res = await (await app.signIn(me.Uuid)).get(`${ROLES}?profile=editor`);

        expect(res.status, res.text).to.eq(200);
        expect(res.body).to.deep.eq({ Roles: ['editor', 'user'] });
      });

      it('offers no role for a profile the create path refuses', async () => {
        const res = await (await app.signIn(me.Uuid)).get(`${ROLES}?profile=reviewer`);

        expect(res.status, res.text).to.eq(200);
        expect(res.body).to.deep.eq({ Roles: [] });
      });

      it('answers 400 to a profile that is not one role name', async () => {
        const client = await app.signIn(me.Uuid);

        for (const query of ['profile=', 'profile=editor&profile=user', `profile=${'x'.repeat(200)}`]) {
          const res = await client.get(`${ROLES}?${query}`);
          expect(res.status, `${query} ${res.text}`).to.eq(400);
          expect(res.body).to.not.have.property('Roles');
        }
      });

      it('fails closed (500) when the profile policy answers anything but a list of names', async () => {
        const client = await app.signIn(me.Uuid);

        for (const answer of ['editor', [''], [7], null]) {
          UsersHttpOfferProfilePolicy.answer = answer;
          const res = await client.get(PROFILES);
          expect(res.status, `${JSON.stringify(answer)} ${res.text}`).to.eq(500);
          expect(res.body).to.not.have.property('Profiles');
        }
      });
    });
  });
});
