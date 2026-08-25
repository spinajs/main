import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DateTime } from 'luxon';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, activate, create } from '@spinajs/rbac';
import { RbacMiddleware } from '@spinajs/rbac-http';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { AccessTokenRolePolicy } from '../src/interfaces.js';
import { createToken } from '../src/actions.js';
import { TokenAuthMiddleware } from '../src/middlewares.js';
import '../src/generator.js';
import '../src/role-policy.js';

/**
 * Lets the nested `profiles` block mint a profiled token: the shipped
 * `OwnRolesTokenRolePolicy` offers no profiles at all, so `createToken` would
 * refuse the pin and `validateToken` would then reject the token on every
 * request.
 *
 * Selected by name through `rbac.token.rolePolicy.service`, so only that block
 * runs against it; the rest of this suite keeps the shipped default.
 */
@Injectable(AccessTokenRolePolicy)
class MiddlewareProfileStubPolicy extends AccessTokenRolePolicy {
  public async allowedRoles(owner: User): Promise<string[]> {
    return [...owner.Role];
  }

  public async allowedProfiles(): Promise<string[]> {
    return ['admin'];
  }
}

/**
 * Stand-in for the injected `Log`. Every level funnels into one ordered list so a
 * test can assert over *everything* the middleware wrote, not just `warn`.
 */
const makeLogSpy = () => {
  const Calls: unknown[][] = [];
  const record = (...args: unknown[]) => {
    Calls.push(args);
  };

  return {
    Calls,
    trace: sinon.spy(record),
    debug: sinon.spy(record),
    info: sinon.spy(record),
    warn: sinon.spy(record),
    error: sinon.spy(record),
    fatal: sinon.spy(record),
    security: sinon.spy(record),
  };
};

const makeReqRes = (headers: Record<string, string | string[]>, storage: any = {}) => {
  const req: any = {
    headers,
    storage,
    get: (name: string) => headers[name.toLowerCase()],
  };
  const res: any = { setHeader: sinon.spy() };
  const next = sinon.spy();
  return { req, res, next };
};

describe('TokenAuthMiddleware', function () {
  this.timeout(15000);

  let middleware: TokenAuthMiddleware;

  before(async () => {
    DI.setESMModuleSupport();

    DI.register(DbTestConfiguration).as(Configuration);
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
    await DI.resolve(Orm);
  });

  beforeEach(() => {
    middleware = new TokenAuthMiddleware();
    // Constructed by hand, outside DI - pin the two config-backed fields so the
    // tests do not depend on what the ambient Configuration happens to carry.
    Object.defineProperty(middleware, 'HeaderName', { value: 'x-api-key', configurable: true, writable: true });
    Object.defineProperty(middleware, 'LastUsedUpdateInterval', { value: 60, configurable: true, writable: true });
  });

  after(async () => {
    DI.clearCache();
  });

  async function tokenFor(mail: string, login: string, ownerRoles: string[] = ['user'], tokenRoles: string[] = ['user']) {
    const { User: owner } = await create(mail, login, 'password123', ownerRoles);
    await activate(owner.Id);
    return { owner, ...(await createToken(owner, 'mw token', tokenRoles, null)) };
  }

  it('authenticates a valid Bearer token', async () => {
    const { owner, Plaintext, Token } = await tokenFor('m1@spinajs.com', 'm1');
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` });

    await middleware.before()(req, res, next);

    expect(req.storage.User).to.not.be.undefined;
    expect(req.storage.User.Id).to.equal(owner.Id);
    expect(req.storage.User.Role).to.deep.equal(['user']);
    expect(req.storage.ActiveRole, 'a token must not pin an active role - see the class docblock').to.be.undefined;
    expect(req.storage.TokenAuth).to.deep.equal({ Uuid: Token.Uuid, Profile: undefined });
    sinon.assert.calledWith(res.setHeader, 'Cache-Control', 'no-store');
    sinon.assert.calledOnce(next);
  });

  /**
   * Both `checkRoutePermission` ( rbac-http ) and the orm rbac query middleware
   * read `ActiveRole ? [ActiveRole] : User.Role`. Pinning one role here would
   * therefore authorize a multi-role token with a strict SUBSET of what it was
   * issued for, permanently - a token has no way to switch its active role the
   * way a session does.
   */
  it('keeps the whole effective role set authorizable, without pinning an active role', async () => {
    const { Plaintext } = await tokenFor('m10@spinajs.com', 'm10', ['user', 'admin'], ['user', 'admin']);
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` });

    await middleware.before()(req, res, next);

    expect(req.storage.User.Role, 'the effective set must reach the permission checks whole').to.deep.equal(['user', 'admin']);
    expect(req.storage.ActiveRole, 'a pinned active role collapses the token to that one role').to.be.undefined;
    sinon.assert.calledOnce(next);
  });

  /**
   * Clearing `ActiveRole` cannot be done by simply not writing it: `RbacMiddleware`
   * runs FIRST and, finding no session, stamps the guest account's first role
   * there ( `rbac-http/src/middlewares.ts`, the `else` branch ). Left in place it
   * would authorize the whole token request as `guest`.
   */
  it('clears the guest active role RbacMiddleware left behind', async () => {
    const { Plaintext } = await tokenFor('m11@spinajs.com', 'm11', ['user', 'admin'], ['user', 'admin']);
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` }, { ActiveRole: 'guest', User: { Role: ['guest'] } });

    await middleware.before()(req, res, next);

    expect(req.storage.ActiveRole, "the guest's active role survived into a token request").to.be.undefined;
    expect(req.storage.User.Role).to.deep.equal(['user', 'admin']);
  });

  it('authenticates via fallback header', async () => {
    const { Plaintext } = await tokenFor('m2@spinajs.com', 'm2');
    const { req, res, next } = makeReqRes({ 'x-api-key': Plaintext });

    await middleware.before()(req, res, next);

    expect(req.storage.TokenAuth).to.not.be.undefined;
    sinon.assert.calledOnce(next);
  });

  it('leaves request untouched without token header', async () => {
    const { req, res, next } = makeReqRes({});
    await middleware.before()(req, res, next);

    expect(req.storage.TokenAuth).to.be.undefined;
    expect(req.storage.User).to.be.undefined;
    sinon.assert.notCalled(res.setHeader);
    sinon.assert.calledOnce(next);
  });

  it('stays guest on invalid token, does not throw', async () => {
    const { req, res, next } = makeReqRes({ authorization: 'Bearer spt_invalid' });
    await middleware.before()(req, res, next);

    expect(req.storage.TokenAuth).to.be.undefined;
    expect(req.storage.User).to.be.undefined;
    sinon.assert.calledOnce(next);
    // called with NO argument - passing the error on would turn a bad token into
    // a 500 instead of letting the route policy answer 401/403
    expect(next.firstCall.args.length).to.equal(0);
  });

  /**
   * Node hands a header sent twice over as an array. `.startsWith` / `.trim` on
   * one throws, and the outer catch would forward that to `next(err)` - turning
   * a malformed request into a 500. It has to read as "no token" instead.
   */
  it('ignores a duplicated token header instead of failing the request', async () => {
    const { Plaintext } = await tokenFor('m5@spinajs.com', 'm5');
    const { req, res, next } = makeReqRes({ 'x-api-key': [Plaintext, 'spt_other'] });

    await middleware.before()(req, res, next);

    expect(req.storage.TokenAuth).to.be.undefined;
    expect(req.storage.User).to.be.undefined;
    sinon.assert.calledOnce(next);
    expect(next.firstCall.args.length).to.equal(0);
  });

  it('does not override an existing session user', async () => {
    const { Plaintext } = await tokenFor('m3@spinajs.com', 'm3');
    const sessionUser = { Id: 999, Role: ['admin'] };
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` }, { User: sessionUser, Session: { SessionId: 's' } });

    await middleware.before()(req, res, next);

    expect(req.storage.User).to.equal(sessionUser);
    expect(req.storage.TokenAuth).to.be.undefined;
  });

  it('updates LastUsedAt on successful auth', async () => {
    const { Plaintext, Token } = await tokenFor('m4@spinajs.com', 'm4');
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` });

    await middleware.before()(req, res, next);
    // touch is fire-and-forget - give it a tick
    await new Promise((r) => setTimeout(r, 50));

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.LastUsedAt).to.not.be.null;
    expect(row.LastUsedAt).to.not.be.undefined;
  });

  it('accepts a lowercase bearer scheme', async () => {
    const { Plaintext } = await tokenFor('m6@spinajs.com', 'm6');
    const { req, res, next } = makeReqRes({ authorization: `bearer ${Plaintext}` });

    await middleware.before()(req, res, next);

    // RFC 7235 makes the scheme name case-insensitive and real clients send it
    // lowercase; rejecting those looks like an invalid key to the caller
    expect(req.storage.TokenAuth).to.not.be.undefined;
    sinon.assert.calledOnce(next);
  });

  /**
   * `Role` is a persisted `@Set()` column and this very instance is what a
   * controller gets from `@User()`. Narrowing it for the request must not survive
   * an unrelated `.update()` - that would permanently strip every role the token
   * did not carry from the account.
   */
  it('narrowing Role does not persist when the controller later updates the user', async () => {
    const { owner, Plaintext } = await tokenFor('m7@spinajs.com', 'm7', ['user', 'admin'], ['user']);
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` });

    await middleware.before()(req, res, next);

    const narrowed = req.storage.User as User;
    expect(narrowed.Role, 'request-scoped narrowing did not happen').to.deep.equal(['user']);

    // what a controller does on a completely unrelated edit
    narrowed.Login = 'm7-renamed';
    await narrowed.update();

    const fresh = await User.where('Id', owner.Id).firstOrFail();
    expect(fresh.Login, 'the controller edit must still be written').to.equal('m7-renamed');
    expect(fresh.Role, 'the account lost roles the token did not carry').to.deep.equal(['user', 'admin']);
  });

  /**
   * The presented secret must never reach a log sink, on ANY path. A rejection is
   * identified by the token row's uuid instead, which is safe to write down.
   */
  it('never logs the presented plaintext, and names the token by uuid when known', async () => {
    const logSpy = makeLogSpy();

    // --- failing path: an expired token, so validateToken attaches the uuid
    const { Plaintext, Token } = await tokenFor('m8@spinajs.com', 'm8');
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 5 });
    await row.update();

    Object.defineProperty(middleware, 'Log', { value: logSpy, configurable: true, writable: true });

    const bad = makeReqRes({ authorization: `Bearer ${Plaintext}` });
    await middleware.before()(bad.req, bad.res, bad.next);

    sinon.assert.calledOnce(logSpy.warn);
    const [, meta] = logSpy.warn.firstCall.args as [string, Record<string, unknown>];
    expect(meta.Token, 'rejection log must name the token by uuid').to.equal(Token.Uuid);

    // --- success path: nothing about the secret may be written either
    const { Plaintext: goodPlaintext } = await tokenFor('m9@spinajs.com', 'm9');
    const good = makeReqRes({ authorization: `Bearer ${goodPlaintext}` });
    await middleware.before()(good.req, good.res, good.next);
    await new Promise((r) => setTimeout(r, 50));

    expect(logSpy.Calls.length, 'expected at least the rejection to be logged').to.be.greaterThan(0);

    for (const args of logSpy.Calls) {
      const dump = JSON.stringify(args);
      expect(dump, 'presented plaintext leaked into a log call').to.not.contain(Plaintext);
      expect(dump, 'presented plaintext leaked into a log call').to.not.contain(goodPlaintext);
      // the stored hash is internal too - it must not travel either
      expect(dump).to.not.contain(row.Token);
    }
  });

  /**
   * The whole "session wins" contract rests on ordering: RbacMiddleware restores
   * the session BEFORE this middleware looks for a token. `ServerMiddleware`s are
   * sorted by `Order` ascending, so the relation - not the literal numbers - is
   * what has to hold. Asserted against the real RbacMiddleware so that moving
   * either number breaks here rather than silently in production.
   */
  it('runs after RbacMiddleware', () => {
    expect(new TokenAuthMiddleware().Order).to.be.greaterThan(new RbacMiddleware().Order);
  });

  /**
   * A token minted before profiles existed carries no pin, and the field has to
   * read as "unpinned" rather than as some default - the application's
   * row-scoping layer distinguishes the two.
   */
  it('leaves Profile undefined on TokenAuth for a legacy token', async () => {
    const { Plaintext } = await tokenFor('m12@spinajs.com', 'm12');
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` });

    await middleware.before()(req, res, next);

    expect(req.storage.TokenAuth).to.not.be.undefined;
    expect(req.storage.TokenAuth?.Profile).to.equal(undefined);
    sinon.assert.calledOnce(next);
  });

  describe('profiles', () => {
    before(async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('rbac.token.rolePolicy.service', MiddlewareProfileStubPolicy.name);
    });

    after(async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('rbac.token.rolePolicy.service', 'OwnRolesTokenRolePolicy');
    });

    /**
     * The profile is what the application's row-scoping layer reads, and it can
     * only read it off `TokenAuth` - `ActiveRole` deliberately stays cleared
     * ( see the middleware's class docblock ), so the two must be asserted
     * together: stamping the profile must not have reintroduced the collapse
     * that clearing `ActiveRole` exists to prevent.
     */
    it('stamps the token profile on TokenAuth', async () => {
      const { User: owner } = await create('m13@spinajs.com', 'm13', 'password123', ['user', 'admin']);
      await activate(owner.Id);
      const { Plaintext } = await createToken(owner, 'profiled mw token', ['user'], null, 'admin');
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` });

      await middleware.before()(req, res, next);

      expect(req.storage.TokenAuth).to.include({ Profile: 'admin' });
      expect(req.storage.ActiveRole, 'a profiled token must still not pin an active role').to.equal(undefined);
      sinon.assert.calledOnce(next);
    });
  });
});
