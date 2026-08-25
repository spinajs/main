import 'mocha';
import { expect } from 'chai';
import { AccessControl } from 'accesscontrol';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { Controllers, HttpServer } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, activate, create } from '@spinajs/rbac';

import { req, restoreHttpErrorMap, sessionCookieFor, useTestConfiguration } from './common.js';
import { createToken } from '../src/actions.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { AccessTokenRolePolicy } from '../src/interfaces.js';
import '../src/generator.js';
import '../src/middlewares.js';
import '../src/role-policy.js';

/**
 * Answers with whatever the test told it to, regardless of the caller's own
 * `Role`. Used below to prove `GET user/tokens/roles` reports the POLICY's
 * answer - the previous suite only ever asserted `['user']`, which is also
 * exactly `user.Role`, so a route body hard-coded to `user.Role` would have
 * passed every test in this file.
 */
@Injectable(AccessTokenRolePolicy)
class StubScopePolicy extends AccessTokenRolePolicy {
  public static Allowed: string[] = [];

  public async allowedRoles(_owner: User): Promise<string[]> {
    return [...StubScopePolicy.Allowed];
  }
}

/**
 * Answers per profile: the `''` key holds the profile-less answer, so a test
 * can make the owner-wide union and the profile-relative set differ - the only
 * way to prove `?profile=` actually reaches the policy rather than being
 * dropped somewhere between express and the route.
 *
 * Selected by name through `rbac.token.rolePolicy.service`, so only the nested
 * `profiles` block below runs against it. Mirrors `CrudProfileStubPolicy` in
 * `actions-crud.test.ts`.
 */
@Injectable(AccessTokenRolePolicy)
class ProfileScopePolicy extends AccessTokenRolePolicy {
  public static Profiles: string[] = [];
  public static RolesPerProfile: Record<string, string[]> = {};

  public async allowedRoles(_owner: User, profile?: string): Promise<string[]> {
    return [...(ProfileScopePolicy.RolesPerProfile[profile ?? ''] ?? [])];
  }

  public async allowedProfiles(_owner: User): Promise<string[]> {
    return [...ProfileScopePolicy.Profiles];
  }
}

/**
 * `GET user/tokens/roles` - the set the picker offers.
 *
 * It has to come from the same policy `POST user/tokens` validates against:
 * a route that computed its own answer could offer a role the create call
 * then refuses, which is a bug the UI cannot work around.
 */
describe('AccessTokenController - scopes route', function () {
  this.timeout(25000);

  let server: HttpServer;

  before(async () => {
    DI.setESMModuleSupport();

    // Sibling suites clear the container cache in their `after()`, taking the
    // exception -> response map with it; without this every rejection asserted
    // below would arrive as a 500.
    restoreHttpErrorMap();

    useTestConfiguration();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);
    await DI.resolve(Controllers);

    server = await DI.resolve(HttpServer);
    await server.start();
  });

  after(async () => {
    await server.stop();
    DI.clearCache();
  });

  // `create` is `create(email, login, password, roles)` and resolves to
  // `{ User, Password }`, not a bare user - and the account it makes is
  // inactive, so it must be activated before it can authenticate as anyone.
  const activeUser = async (login: string, roles: string[]) => {
    const { User: user } = await create(`${login}@spinajs.pl`, login, 'Bb1234567!', roles);
    await activate(user.Id);
    return user;
  };

  it('answers with the roles the policy allows the caller', async () => {
    const user = await activeUser('scopes.user', ['user']);
    const cookie = await sessionCookieFor(user);

    const response = await req().get('user/tokens/roles').set('Cookie', cookie);

    expect(response.status).to.equal(200);
    // The shipped default policy allows exactly the caller's own roles.
    expect(response.body.Roles).to.deep.equal(['user']);
  });

  it('refuses a token-authenticated caller', async () => {
    const user = await activeUser('scopes.token', ['user']);
    const { Plaintext } = await createToken(user, 'scopes probe', ['user'], null);

    const response = await req().get('user/tokens/roles').set('Authorization', `Bearer ${Plaintext}`);

    // NoTokenAuthPolicy - a token must not learn, or manage, what it could become.
    expect(response.status).to.equal(403);
  });

  it('refuses an impersonated session', async () => {
    const target = await activeUser('scopes.target', ['user']);
    const admin = await activeUser('scopes.admin', ['admin']);
    const cookie = await sessionCookieFor(target, admin);

    const response = await req().get('user/tokens/roles').set('Cookie', cookie);

    // NoImpersonationPolicy - same reasoning as the create route.
    expect(response.status).to.equal(403);
  });

  it('answers the profiles route with the policy answer - none for the shipped default', async () => {
    const user = await activeUser('profiles.default', ['user']);
    const cookie = await sessionCookieFor(user);

    const response = await req().get('user/tokens/profiles').set('Cookie', cookie);

    expect(response.status).to.equal(200);
    // `OwnRolesTokenRolePolicy` does not override `allowedProfiles`, so an
    // application that never opted into profile tokens is offered none - and
    // the route still answers a well formed body rather than 404 / undefined.
    expect(response.body.Profiles).to.deep.equal([]);
  });

  it('refuses an anonymous caller on the profiles route', async () => {
    const response = await req().get('user/tokens/profiles');

    // The route sits behind `@Permission(['readOwn'])` like its siblings; what
    // profiles exist is not public information.
    expect(response.status).to.equal(401);
  });

  it('refuses a token-authenticated caller on the profiles route', async () => {
    const user = await activeUser('profiles.token', ['user']);
    const { Plaintext } = await createToken(user, 'profiles probe', ['user'], null);

    const response = await req().get('user/tokens/profiles').set('Authorization', `Bearer ${Plaintext}`);

    // NoTokenAuthPolicy - a token must not learn what it could have been
    // pinned to any more than what roles it could have carried.
    expect(response.status).to.equal(403);
  });

  it('refuses an impersonated session on the profiles route', async () => {
    const target = await activeUser('profiles.target', ['user']);
    const admin = await activeUser('profiles.admin', ['admin']);
    const cookie = await sessionCookieFor(target, admin);

    const response = await req().get('user/tokens/profiles').set('Cookie', cookie);

    // NoImpersonationPolicy - the controller scope guard covers every route,
    // including one added later.
    expect(response.status).to.equal(403);
  });

  describe('with a policy that diverges from the caller own roles', () => {
    before(async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('rbac.token.rolePolicy.service', 'StubScopePolicy');
    });

    after(async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('rbac.token.rolePolicy.service', 'OwnRolesTokenRolePolicy');
    });

    it('reports the policy answer, not the callers own roles', async () => {
      const user = await activeUser('scopes.policy-answer', ['user']);
      const cookie = await sessionCookieFor(user);
      StubScopePolicy.Allowed = ['admin'];

      const response = await req().get('user/tokens/roles').set('Cookie', cookie);

      expect(response.status).to.equal(200);
      // Not ['user'] ( the caller's own role ) - proves the route defers to the
      // policy instead of echoing `user.Role`.
      expect(response.body.Roles).to.deep.equal(['admin']);
    });

    /**
     * The whole point of exposing this route: a client must never be offered a
     * role that `POST user/tokens` would then refuse. Feeds the route's own
     * answer straight into the create call and asserts it is accepted.
     */
    it('accepts POST user/tokens with a role this route just reported, even though the caller does not hold it', async () => {
      const user = await activeUser('scopes.policy-roundtrip', ['user']);
      const cookie = await sessionCookieFor(user);
      StubScopePolicy.Allowed = ['admin'];

      const rolesResponse = await req().get('user/tokens/roles').set('Cookie', cookie);
      expect(rolesResponse.body.Roles).to.deep.equal(['admin']);

      const createResponse = await req()
        .post('user/tokens')
        .set('Cookie', cookie)
        .send({ Name: 'from roles route', Roles: rolesResponse.body.Roles });

      expect(createResponse.status).to.equal(200);
      expect(createResponse.body.Token.Roles).to.deep.equal(['admin']);
    });
  });

  /**
   * The profile ( root role ) a token is pinned to: what the picker may offer,
   * how it narrows the role list, and that the pin survives the round trip
   * through `POST user/tokens` onto the row and back onto the wire.
   */
  describe('profiles', () => {
    let previousPolicy: string;

    before(async () => {
      const cfg = await DI.resolve(Configuration);
      previousPolicy = cfg.get<string>('rbac.token.rolePolicy.service');
      cfg.set('rbac.token.rolePolicy.service', 'ProfileScopePolicy');

      // `_allowed_roles` drops every role AccessControl does not know about, so
      // the role used to prove profile narrowing has to be in the grants map -
      // otherwise the assertions below would pass for the wrong reason. What it
      // grants is irrelevant here; only its presence in the map is.
      const ac = DI.get<AccessControl>('AccessControl')!;
      ac.grant('extra').readOwn('extra');
    });

    after(async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('rbac.token.rolePolicy.service', previousPolicy);
    });

    beforeEach(() => {
      ProfileScopePolicy.Profiles = ['admin'];
      ProfileScopePolicy.RolesPerProfile = { '': ['user', 'extra'], admin: ['user'] };
    });

    it('GET user/tokens/profiles answers what the policy offers the caller', async () => {
      const user = await activeUser('profiles.list', ['user']);
      const cookie = await sessionCookieFor(user);

      const response = await req().get('user/tokens/profiles').set('Cookie', cookie);

      expect(response.status).to.equal(200);
      expect(response.body.Profiles).to.deep.equal(['admin']);
    });

    it('narrows GET user/tokens/roles to the profile named in the query', async () => {
      const user = await activeUser('profiles.roles', ['user']);
      const cookie = await sessionCookieFor(user);

      // control: without the param the answer is still the owner-wide union, so
      // the narrower answer below can only come from the query param reaching
      // the policy - and legacy clients keep exactly today's behaviour
      const wide = await req().get('user/tokens/roles').set('Cookie', cookie);
      expect(wide.status).to.equal(200);
      expect(wide.body.Roles).to.deep.equal(['user', 'extra']);

      const narrow = await req().get('user/tokens/roles?profile=admin').set('Cookie', cookie);
      expect(narrow.status).to.equal(200);
      expect(narrow.body.Roles).to.deep.equal(['user']);
    });

    it('POST user/tokens pins the token to the requested profile, on the wire and in the row', async () => {
      const user = await activeUser('profiles.create', ['user']);
      const cookie = await sessionCookieFor(user);

      const response = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'profiled', Roles: ['user'], Profile: 'admin' });

      expect(response.status).to.equal(200);
      // the wire shape the frontend reads - `toWire` must carry `Profile`
      expect(response.body.Token.Profile).to.equal('admin');

      // the pin is what later requests are scoped by, so it has to reach the row
      const row = await AccessToken.where('Uuid', response.body.Token.Uuid).firstOrFail();
      expect(row.Profile).to.equal('admin');

      // and it is readable again afterwards - the listing is where the UI shows
      // an existing token's profile
      const list = await req().get('user/tokens').set('Cookie', cookie);
      expect(list.status).to.equal(200);
      expect(list.body.map((t: any) => t.Profile)).to.deep.equal(['admin']);
    });

    it('POST user/tokens refuses a profile the policy does not offer', async () => {
      const user = await activeUser('profiles.bad', ['user']);
      const cookie = await sessionCookieFor(user);

      const response = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'bad', Roles: ['user'], Profile: 'nope' });

      // the caller's mistake, not the server's - and the code is what the UI
      // switches on
      expect(response.status).to.equal(400);
      expect(response.body.error.code).to.equal('E_TOKEN_ROLE_NOT_ALLOWED');

      // nothing may be persisted by a refused create
      expect(await AccessToken.where('Name', 'bad').all()).to.have.length(0);
    });

    it('POST user/tokens validates roles against the profile, not the owner union', async () => {
      const user = await activeUser('profiles.narrowed', ['user']);
      const cookie = await sessionCookieFor(user);

      // control: unpinned, 'extra' is allowed - so the refusal below can only
      // come from `Profile` reaching the roles check
      const wide = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'wide', Roles: ['extra'] });
      expect(wide.status).to.equal(200);

      const narrowed = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'narrowed', Roles: ['extra'], Profile: 'admin' });
      expect(narrowed.status).to.equal(400);
      expect(narrowed.body.error.code).to.equal('E_TOKEN_ROLE_NOT_ALLOWED');
    });

    /**
     * Same guarantee the roles route already owes a client, now per profile: a
     * profile this route offers, with the roles the roles route reports for it,
     * must be accepted by the create call.
     */
    it('accepts a create built from what the two routes just reported', async () => {
      const user = await activeUser('profiles.roundtrip', ['user']);
      const cookie = await sessionCookieFor(user);

      const profiles = await req().get('user/tokens/profiles').set('Cookie', cookie);
      const [profile] = profiles.body.Profiles;

      const roles = await req().get(`user/tokens/roles?profile=${profile}`).set('Cookie', cookie);

      const created = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'from routes', Roles: roles.body.Roles, Profile: profile });

      expect(created.status).to.equal(200);
      expect(created.body.Token.Profile).to.equal(profile);
      expect(created.body.Token.Roles).to.deep.equal(roles.body.Roles);
    });

    it('refuses an empty Profile at the DTO, rather than silently minting an unpinned token', async () => {
      const user = await activeUser('profiles.empty', ['user']);
      const cookie = await sessionCookieFor(user);

      const response = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'empty profile', Roles: ['user'], Profile: '' });

      // `''` is falsy all the way down the actions layer, so a token asking for
      // it would come out UNPINNED - a silent privilege widening. `minLength: 1`
      // on the DTO is what turns that into a validation error.
      expect(response.status).to.equal(400);
      expect(await AccessToken.where('Name', 'empty profile').all()).to.have.length(0);
    });
  });
});
