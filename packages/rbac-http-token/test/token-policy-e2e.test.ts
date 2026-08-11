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

import { TestConfiguration, req, restoreHttpErrorMap } from './common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken } from '../src/actions.js';
import '../src/generator.js';
import '../src/middlewares.js';

/**
 * End to end proof of the advertised consumer wiring: a route carrying
 * `@Resource` + `@Permission` and a route scope `@Policy(TokenPolicy)` is
 * reachable by an access token holder and by nobody else.
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

    DI.register(TestConfiguration).as(Configuration);
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
    server.start();
  });

  after(async () => {
    server.stop();
    DI.clearCache();
  });

  async function makeUserToken(mail: string, login: string, roles: string[], tokenRoles: string[], expires: DateTime | null = null) {
    const { User: u } = await create(mail, login, 'password123', roles);
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
  });

  it('anonymous request is rejected', async () => {
    const res = await req().get('token-protected/data');
    expect(res.status).to.be.oneOf([401, 403]);
  });

  it('expired token is rejected', async () => {
    const { Token, Plaintext } = await makeUserToken('e3@spinajs.com', 'e3', ['user'], ['user'], DateTime.now().plus({ minutes: 5 }));
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 5 });
    await row.update();

    const res = await req().get('token-protected/data').set('Authorization', `Bearer ${Plaintext}`);
    expect(res.status).to.be.oneOf([401, 403]);
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
});
