import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, activate, create } from '@spinajs/rbac';
import { RbacMiddleware } from '@spinajs/rbac-http';

import { DbTestConfiguration } from './db-common.js';
import { createToken } from '../src/actions.js';
import { TokenAuthMiddleware } from '../src/middlewares.js';
import '../src/generator.js';

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

  async function tokenFor(mail: string, login: string) {
    const { User: owner } = await create(mail, login, 'password123', ['user']);
    await activate(owner.Id);
    return { owner, ...(await createToken(owner, 'mw token', ['user'], null)) };
  }

  it('authenticates a valid Bearer token', async () => {
    const { owner, Plaintext, Token } = await tokenFor('m1@spinajs.com', 'm1');
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` });

    await middleware.before()(req, res, next);

    expect(req.storage.User).to.not.be.undefined;
    expect(req.storage.User.Id).to.equal(owner.Id);
    expect(req.storage.User.Role).to.deep.equal(['user']);
    expect(req.storage.ActiveRole).to.equal('user');
    expect(req.storage.TokenAuth).to.deep.equal({ Uuid: Token.Uuid });
    sinon.assert.calledWith(res.setHeader, 'Cache-Control', 'no-store');
    sinon.assert.calledOnce(next);
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

    const { AccessToken } = await import('../src/models/AccessToken.js');
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.LastUsedAt).to.not.be.null;
    expect(row.LastUsedAt).to.not.be.undefined;
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
});
