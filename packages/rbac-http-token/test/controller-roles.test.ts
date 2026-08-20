import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { Controllers, HttpServer } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, activate, create } from '@spinajs/rbac';

import { req, restoreHttpErrorMap, sessionCookieFor, useTestConfiguration } from './common.js';
import { createToken } from '../src/actions.js';
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
});
