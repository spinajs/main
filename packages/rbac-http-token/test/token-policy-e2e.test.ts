import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { Controllers, HttpServer } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, create, activate, User } from '@spinajs/rbac';
import '@spinajs/rbac-http';
import { DateTime } from 'luxon';

import { req, restoreHttpErrorMap, useTestConfiguration } from './common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken } from '../src/actions.js';
import '../src/generator.js';
import '../src/middlewares.js';

/**
 * End to end proof of the advertised consumer wiring: a route carrying
 * `@Resource` + `@Permission` and a route scope `@Policy(TokenPolicy)` is
 * reachable by an access token holder whose effective roles carry the grant.
 * It stays reachable by a session holding the grant too - the two route scope
 * groups are ORed - so "unauthorized" here means neither group holds.
 *
 * Every request here is token only - no session cookie is ever sent - so
 * `RbacMiddleware` leaves the request a guest and `TokenAuthMiddleware` is the
 * only thing that can authenticate it. See `support/TestTokenController.ts` for
 * why the policy has to sit on the method.
 */
describe('TokenPolicy e2e', function () {
  this.timeout(25000);

  let server: HttpServer;

  before(async () => {
    DI.setESMModuleSupport();

    // Sibling suites clear the container cache in their `after()`, taking the
    // exception -> response map with it; without this the 401 / 403 assertions
    // below would see a 500. See `restoreHttpErrorMap` in `common.ts`.
    restoreHttpErrorMap();

    // Not a plain `DI.register(...).as(Configuration)` - see the helper for why
    // that silently loses to a db-only suite's configuration.
    useTestConfiguration();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    // rbac wires its AccessControl instance and user factories from a
    // bootstrapper; nothing runs bootstrappers for us outside a real app.
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);
    await DI.resolve(Controllers);

    server = await DI.resolve(HttpServer);

    // AWAITED, both here and in after(): `start()` binds the port inside a
    // promise ( `http/src/server.ts` ) and `stop()` is a promise too, so an
    // un-awaited pair lets a request go out before the listener exists and lets
    // the next suite start while this one still holds 8889.
    //
    // The port this actually binds comes from the configuration registered in
    // `useTestConfiguration()` above - NOT from a plain `DI.register(...)`. See
    // that helper's docblock: registration de-duplicates by type name, so a
    // db-only suite's configuration stays the winner and this server would
    // silently bind the framework default 1337 while every request here goes to
    // 8889.
    await server.start();
  });

  after(async () => {
    await server.stop();
    DI.clearCache();
  });

  async function makeUserToken(mail: string, login: string, roles: string[], tokenRoles: string[], expires: DateTime<true> | null = null) {
    const { User: u } = await create(mail, login, roles, { password: 'password123' });
    await activate(u.Id);
    const owner = await User.where('Id', u.Id).populate('Metadata').firstOrFail();
    return { owner, ...(await createToken(owner, 'e2e', tokenRoles, expires)) };
  }

  it('valid bearer token reaches the route', async () => {
    const { Plaintext } = await makeUserToken('e1@spinajs.com', 'e1', ['user'], ['user']);
    const res = await req().get('token-protected/data').set('Authorization', `Bearer ${Plaintext}`);
    expect(res.status).to.equal(200);
    expect(res.body.ok).to.be.true;

    // Positive control on the credential path: `TokenAuthMiddleware` sets this
    // header ONLY after a token actually validated, so the 200 above cannot be
    // an unguarded route answering an anonymous request.
    expect(res.headers['cache-control'], 'the route answered without the token ever authenticating').to.equal('no-store');
  });

  it('valid fallback-header token reaches the route', async () => {
    const { Plaintext } = await makeUserToken('e2@spinajs.com', 'e2', ['user'], ['user']);
    const res = await req().get('token-protected/data').set('x-api-key', Plaintext);
    expect(res.status).to.equal(200);

    // Same positive control as the Bearer twin - the fallback header has to go
    // through `TokenAuthMiddleware` too, not merely reach an open route.
    expect(res.headers['cache-control'], 'the route answered without the token ever authenticating').to.equal('no-store');
  });

  it('anonymous request is rejected', async () => {
    const res = await req().get('token-protected/data');
    expect(res.status).to.be.oneOf([401, 403]);
  });

  it('expired token is rejected', async () => {
    const { Token, Plaintext } = await makeUserToken('e3@spinajs.com', 'e3', ['user'], ['user'], DateTime.now().plus({ minutes: 5 }));

    // Control FIRST: while still valid the very same request is served, so the
    // rejection below can only be the expiry - not a typo in the header, a
    // missing grant or a fixture that never worked.
    const before = await req().get('token-protected/data').set('Authorization', `Bearer ${Plaintext}`);
    expect(before.status, 'the fixture token was not usable even before expiring').to.equal(200);

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 5 });
    await row.update();

    const res = await req().get('token-protected/data').set('Authorization', `Bearer ${Plaintext}`);
    expect(res.status).to.be.oneOf([401, 403]);

    // And the rejection happened during AUTHENTICATION, not later: `no-store` is
    // set only once `validateToken` succeeds ( `middlewares.ts:79` ), so its
    // absence pins that the expired credential never authenticated at all.
    expect(res.headers['cache-control'], 'an expired token still authenticated').to.be.undefined;
  });

  it('token without required grant is rejected', async () => {
    // `guest` holds no grant on `test.resource`, and the token is scoped to
    // `guest` ALONE while its owner also holds `user` - so the rejection can
    // only come from the token's narrowed roles, not from the account's.
    const { Plaintext } = await makeUserToken('e4@spinajs.com', 'e4', ['user', 'guest'], ['guest']);
    const res = await req().get('token-protected/data').set('Authorization', `Bearer ${Plaintext}`);
    expect(res.status).to.equal(403);

    // and the token itself really did authenticate - this is a grant refusal,
    // not a rejected credential
    expect(res.headers['cache-control']).to.equal('no-store');
  });

  /**
   * A multi-role token must be authorized with its WHOLE effective role set.
   *
   * `checkRoutePermission` resolves the roles to check as
   * `ActiveRole ? [ActiveRole] : User.Role`, so a middleware that pins
   * `ActiveRole` to the first effective role silently authorizes every token
   * request as that single role - and a token, unlike a session, can never
   * switch it. `token-protected/any-data` demands `readAny`, which only `admin`
   * holds on `test.resource`, while the token's role list starts with `user`:
   * the collapsed variant answers 403 here, the correct one 200.
   */
  it('authorizes a multi-role token with the full effective set, not just its first role', async () => {
    const { Plaintext } = await makeUserToken('e5@spinajs.com', 'e5', ['user', 'admin'], ['user', 'admin']);

    // control: the same token on the readOwn route, satisfied by the FIRST role
    // alone - so a 403 below cannot be a broken credential or a missing route
    const own = await req().get('token-protected/data').set('Authorization', `Bearer ${Plaintext}`);
    expect(own.status, 'the fixture token was not usable at all').to.equal(200);

    const res = await req().get('token-protected/any-data').set('Authorization', `Bearer ${Plaintext}`);
    expect(res.status, 'the grant held by the second effective role was not honored').to.equal(200);
    expect(res.body.ok).to.be.true;
    expect(res.headers['cache-control']).to.equal('no-store');
  });

  /**
   * Negative twin of the test above: the widened authorization scope is the
   * token's effective set and nothing more. A token scoped to `user` alone must
   * still be refused the admin-only grant even though its OWNER holds `admin`.
   */
  it('does not widen authorization beyond the token effective set', async () => {
    const { Plaintext } = await makeUserToken('e6@spinajs.com', 'e6', ['user', 'admin'], ['user']);

    const res = await req().get('token-protected/any-data').set('Authorization', `Bearer ${Plaintext}`);
    expect(res.status, "the owner's roles leaked into the token's authorization scope").to.equal(403);
    expect(res.headers['cache-control']).to.equal('no-store');
  });
});
