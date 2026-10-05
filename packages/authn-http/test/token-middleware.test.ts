import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider } from '@spinajs/users';
import { RbacMiddleware } from '../src/middlewares.js';

import { DbTestConfiguration } from './token-db-common.js';
import { AccessToken } from '@spinajs/authn-token';
import { TokenAuthMiddleware } from '../src/token/middlewares.js';
import '@spinajs/authn-token';

// The rows that need a valid token are in `legacy-v2/token-middleware.test.ts`: since C1 the
// 2.x token code reads no roles for a stored owner (LEDGER, N8a task 9).

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

  it('C7 leaves a bearer value without the token prefix alone: no lookup, no warning', async () => {
    const logSpy = makeLogSpy();
    Object.defineProperty(middleware, 'Log', { value: logSpy, configurable: true, writable: true });
    const lookup = sinon.spy(AccessToken, 'where');
    try {
      for (const headers of [{ authorization: 'Bearer telemetry-opaque-token' }, { 'x-api-key': 'telemetry-opaque-token' }] as Record<string, string>[]) {
        const { req, res, next } = makeReqRes(headers);
        await middleware.before()(req, res, next);
        expect(req.storage.TokenAuth).to.be.undefined;
        sinon.assert.calledOnce(next);
        expect(next.firstCall.args.length).to.equal(0);
      }
      expect(lookup.called, 'no token lookup').to.eq(false);
      expect(logSpy.Calls, 'nothing logged').to.deep.eq([]);
    } finally {
      lookup.restore();
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
});
