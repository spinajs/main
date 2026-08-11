import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { CONTROLLED_DESCRIPTOR_SYMBOL, Controllers, HttpServer, IControllerDescriptor } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, create, activate, User } from '@spinajs/rbac';
import { RbacPolicy } from '@spinajs/rbac-http';

import { sessionCookieFor, req, restoreHttpErrorMap, useTestConfiguration } from './common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { AccessTokenController } from '../src/controllers/AccessTokenController.js';
import { NoTokenAuthPolicy } from '../src/policies/NoTokenAuthPolicy.js';
import { NoImpersonationPolicy } from '../src/policies/NoImpersonationPolicy.js';
import { createToken } from '../src/actions.js';
import '../src/generator.js';
import '../src/middlewares.js';

/**
 * End to end coverage of the self-service token API over a real http server.
 *
 * Two invariants carry this suite: the plaintext leaves the process exactly
 * once, and an access token can never manage tokens - not on the create route,
 * not on any other one.
 */
describe('AccessTokenController', function () {
  this.timeout(25000);

  let server: HttpServer;

  before(async () => {
    DI.setESMModuleSupport();

    // Sibling suites clear the container cache in their `after()`, taking the
    // exception -> response map with it; without this every rejection asserted
    // below would arrive as a 500. See `restoreHttpErrorMap` in `common.ts`.
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

    // order matters - @Config getters fire during fs / controller resolution,
    // and the controller cache reads its own `__fs_controller_cache__` provider
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);
    await DI.resolve(Controllers);

    server = await DI.resolve(HttpServer);

    // AWAITED, both here and in after(). `start()` binds the port inside a
    // promise that REJECTS on EADDRINUSE ( `http/src/server.ts:253-271` ) and
    // `stop()` is a promise too. Left un-awaited, a sibling suite that has not
    // finished releasing 8889 makes this one bind nothing at all and every
    // request fails with a bare connection error instead of a readable message -
    // and the outcome flips with mocha's file order.
    await server.start();
  });

  after(async () => {
    await server.stop();
    DI.clearCache();
  });

  async function makeUser(mail: string, login: string, roles: string[] = ['user']) {
    const { User: u } = await create(mail, login, 'password123', roles);
    await activate(u.Id);
    return User.where('Id', u.Id).populate('Metadata').firstOrFail();
  }

  it('rejects anonymous access', async () => {
    const res = await req().get('user/tokens');
    expect(res.status).to.be.oneOf([401, 403]);
  });

  it('creates a token and returns plaintext exactly once', async () => {
    const user = await makeUser('h1@spinajs.com', 'h1');
    const cookie = await sessionCookieFor(user);

    const res = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'my token', Roles: ['user'] });
    expect(res.status).to.equal(200);
    expect(res.body.Plaintext).to.match(/^spt_/);
    expect(res.body.Token.Uuid).to.be.a('string');
    expect(res.body.Token).to.not.have.property('Token');

    // a stranger's token must not appear in the listing - proves the
    // `.where('user_id', ...)` in list() is load bearing rather than incidental
    const stranger = await makeUser('h1b@spinajs.com', 'h1b');
    const { Token: strangersToken } = await createToken(stranger, 'not yours', ['user'], null);

    const list = await req().get('user/tokens').set('Cookie', cookie);
    expect(list.status).to.equal(200);
    expect(list.body).to.have.length(1);
    expect(list.body.map((t: any) => t.Uuid), "another user's token leaked into the listing").to.not.include(strangersToken.Uuid);
    expect(JSON.stringify(list.body)).to.not.contain(strangersToken.Uuid);
    expect(JSON.stringify(list.body), 'the plaintext must never be readable again').to.not.contain(res.body.Plaintext);

    // wire shape: no hash / internal ids, and Roles is a real array rather than
    // the storage encoding `@Set()`'s converter produces
    const [entry] = list.body;
    expect(entry).to.not.have.property('Token');
    expect(entry).to.not.have.property('Id');
    expect(entry).to.not.have.property('user_id');
    expect(entry.Uuid).to.be.a('string');
    expect(entry.Name).to.equal('my token');
    expect(entry.Roles).to.deep.equal(['user']);
  });

  it('rejects creating token with role caller does not hold', async () => {
    const user = await makeUser('h2@spinajs.com', 'h2');
    const cookie = await sessionCookieFor(user);

    const res = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'bad', Roles: ['admin'] });
    expect(res.status).to.equal(400);
  });

  it('deletes own token, foreign uuid not found', async () => {
    const alice = await makeUser('h3@spinajs.com', 'h3');
    const bob = await makeUser('h4@spinajs.com', 'h4');
    const { Token: bobsToken } = await createToken(bob, 'bobs', ['user'], null);

    const aliceCookie = await sessionCookieFor(alice);

    const foreign = await req().delete(`user/tokens/${bobsToken.Uuid}`).set('Cookie', aliceCookie);
    expect(foreign.status).to.equal(404);

    const { Token: own } = await createToken(alice, 'own', ['user'], null);
    const deleted = await req().delete(`user/tokens/${own.Uuid}`).set('Cookie', aliceCookie);
    expect(deleted.status).to.equal(200);
    expect(await AccessToken.where('Uuid', own.Uuid).first()).to.be.undefined;
  });

  it('grants and revokes role on own token', async () => {
    const user = await makeUser('h5@spinajs.com', 'h5', ['user', 'admin']);
    const cookie = await sessionCookieFor(user);
    const { Token } = await createToken(user, 'roles', ['user'], null);

    const granted = await req().put(`user/tokens/${Token.Uuid}/roles/admin`).set('Cookie', cookie);
    expect(granted.status).to.equal(200);
    expect(granted.body.Roles).to.have.members(['user', 'admin']);

    const revoked = await req().delete(`user/tokens/${Token.Uuid}/roles/admin`).set('Cookie', cookie);
    expect(revoked.status).to.equal(200);
    expect(revoked.body.Roles).to.deep.equal(['user']);
  });

  it('refuses to revoke the last role with 400, not 500', async () => {
    const user = await makeUser('h7@spinajs.com', 'h7');
    const cookie = await sessionCookieFor(user);
    const { Token } = await createToken(user, 'last role', ['user'], null);

    const res = await req().delete(`user/tokens/${Token.Uuid}/roles/user`).set('Cookie', cookie);
    expect(res.status).to.equal(400);

    // refused BEFORE any write - the row still carries its role
    expect((await AccessToken.where('Uuid', Token.Uuid).firstOrFail()).Roles).to.deep.equal(['user']);
  });

  it('a valid access token cannot manage tokens', async () => {
    const user = await makeUser('h6@spinajs.com', 'h6');
    const { Plaintext } = await createToken(user, 'self-replication attempt', ['user'], null);

    const res = await req().post('user/tokens').set('Authorization', `Bearer ${Plaintext}`).send({ Name: 'clone', Roles: ['user'] });
    expect(res.status).to.be.oneOf([401, 403]);
  });

  /**
   * An impersonated session must not be able to mint a token.
   *
   * `RbacMiddleware` puts the impersonation TARGET in `req.storage.User`, so the
   * grants, the ownership filter and `RbacPolicy` all read as the victim - the
   * request is indistinguishable from a genuine one everywhere except
   * `req.storage.Impersonator`. A token minted here would be a bearer credential
   * carrying the victim's roles that outlives the impersonation entirely.
   */
  it('an impersonated session cannot mint or manage tokens', async () => {
    const victim = await makeUser('h9@spinajs.com', 'h9');
    const admin = await makeUser('h10@spinajs.com', 'h10', ['admin']);

    // exactly what an active impersonation looks like on the wire: the victim's
    // session, carrying the administrator's uuid under the `Impersonator` key
    const cookie = await sessionCookieFor(victim, admin);
    const { Token: victimsToken } = await createToken(victim, 'pre-existing', ['user'], null);

    const created = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'stolen', Roles: ['user'] });
    expect(created.status, 'impersonation must not be able to mint a lasting credential').to.equal(403);

    // and no route of the controller is reachable either - the guard sits at the
    // controller scope, not on the create route alone
    const listed = await req().get('user/tokens').set('Cookie', cookie);
    expect(listed.status).to.equal(403);

    const deleted = await req().delete(`user/tokens/${victimsToken.Uuid}`).set('Cookie', cookie);
    expect(deleted.status).to.equal(403);

    // nothing was minted and nothing was destroyed
    const tokens = await AccessToken.where('user_id', victim.Id);
    expect(tokens).to.have.length(1);
    expect(tokens[0].Uuid).to.equal(victimsToken.Uuid);

    // control: the very same request WITHOUT the impersonation succeeds, so the
    // 403s above are the impersonation guard and not a broken fixture
    const ownCookie = await sessionCookieFor(victim);
    const own = await req().post('user/tokens').set('Cookie', ownCookie).send({ Name: 'mine', Roles: ['user'] });
    expect(own.status).to.equal(200);
  });

  /**
   * Structural guard on the decorator layout.
   *
   * The behavioural test above would still pass without `NoTokenAuthPolicy`,
   * because `RbacPolicy` happens to demand a session too - so it cannot tell a
   * deliberate guard from a lucky one. This asserts the layout itself: ONE
   * controller-scope group holding BOTH guards ( `createPolicyGate` ANDs the
   * controller scope with the route scope, ANDs the members of a group, and a
   * lone group cannot be ORed away ), plus RbacPolicy on every route from
   * `@Permission`.
   */
  it('guards every route with both controller-scope policies in ONE mandatory group', () => {
    // stored on the PROTOTYPE - `Controller()` writes to `target.prototype`
    const descriptor: IControllerDescriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AccessTokenController.prototype);

    expect(descriptor.Policies, 'a second controller-scope group would be ORed with this one, making both optional').to.have.length(1);
    // ONE group, BOTH members - split across two @Policy() calls they would be
    // ORed and neither would remain a requirement
    expect(descriptor.Policies[0].map((p) => p.Type)).to.have.members([NoTokenAuthPolicy, NoImpersonationPolicy]);

    expect([...descriptor.Routes.keys()]).to.have.members(['list', 'create', 'delete', 'grantRole', 'revokeRole']);
    for (const [name, route] of descriptor.Routes) {
      const types = route.Policies.flat().map((p) => p.Type);
      expect(types, `route ${String(name)} must carry the rbac permission check`).to.include(RbacPolicy);
    }
  });

  it('a valid access token cannot reach ANY route of this controller', async () => {
    // The class level `@Policy([NoTokenAuthPolicy, NoImpersonationPolicy])` is a
    // single controller-scope group, so it is ANDed with every route's own
    // policies - no route can opt out of it, and none may be reachable by token.
    const user = await makeUser('h8@spinajs.com', 'h8', ['user', 'admin']);
    const { Plaintext } = await createToken(user, 'probe', ['user', 'admin'], null);
    const { Token: target } = await createToken(user, 'target', ['user', 'admin'], null);

    const auth = `Bearer ${Plaintext}`;

    const routes: [string, () => Promise<any>][] = [
      ['GET tokens', () => req().get('user/tokens').set('Authorization', auth)],
      ['POST tokens', () => req().post('user/tokens').set('Authorization', auth).send({ Name: 'clone', Roles: ['user'] })],
      ['DELETE tokens/:uuid', () => req().delete(`user/tokens/${target.Uuid}`).set('Authorization', auth)],
      ['PUT tokens/:uuid/roles/:role', () => req().put(`user/tokens/${target.Uuid}/roles/admin`).set('Authorization', auth)],
      ['DELETE tokens/:uuid/roles/:role', () => req().delete(`user/tokens/${target.Uuid}/roles/admin`).set('Authorization', auth)],
    ];

    for (const [name, call] of routes) {
      const res = await call();
      expect(res.status, `token authenticated request reached ${name}`).to.be.oneOf([401, 403]);

      // Positive control. Without it this test would also pass against a token
      // that never authenticated at all ( a typo'd header, a rejected token ),
      // which proves nothing about the policy. `TokenAuthMiddleware` sets
      // `Cache-Control: no-store` ONLY after a token validates
      // ( rbac-http-token/src/middlewares.ts ), and no session is involved here,
      // so the header's presence pins that the credential really was accepted
      // and it was the POLICY that turned it away.
      expect(res.headers['cache-control'], `${name} rejected a token that never authenticated`).to.equal('no-store');
    }

    // and nothing was actually done
    expect((await AccessToken.where('Uuid', target.Uuid).firstOrFail()).Roles).to.have.members(['user', 'admin']);
    expect(await AccessToken.where('user_id', user.Id)).to.have.length(2);
  });
});
