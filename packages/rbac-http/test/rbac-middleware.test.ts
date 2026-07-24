import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import * as cs from 'cookie-signature';

import { DI } from '@spinajs/di';
import { UserSession } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { RbacMiddleware } from '../src/middlewares.js';
// side-effect import: brings in the `@spinajs/http` storage-context augmentation
// (User / Session / ActiveRole / Impersonator) the middleware relies on.
import '../src/interfaces.js';

const COOKIE_SECRET = 'middleware-test-secret';

/**
 * Unit tests for the sliding-renewal behaviour added to RbacMiddleware.before.
 * The middleware is constructed directly; injected fields are set by hand so the
 * process-wide DI container is only used for the user factories the middleware
 * resolves.
 */
describe('RbacMiddleware sliding renewal', function () {
  this.timeout(10000);

  let middleware: RbacMiddleware;
  let touchStub: sinon.SinonStub;
  let session: ISession;

  const makeReqRes = (signedSsid: string) => {
    const req: any = { cookies: { ssid: signedSsid }, storage: {} };
    const res: any = { cookie: sinon.spy() };
    const next = sinon.spy();
    return { req, res, next };
  };

  beforeEach(() => {
    // A user factory the middleware resolves for the session's User uuid.
    DI.register(() => ({ Role: ['user'], Uuid: 'user-uuid' })).as('RbacUserFactory');
    DI.register(() => ({ Role: ['guest'] })).as('RbacGuestUserFactory');

    session = new UserSession();
    session.UserId = 1;
    session.Data.set('User', 'user-uuid');
    session.Data.set('ActiveRole', 'user');

    middleware = new RbacMiddleware();
    touchStub = sinon.stub().resolves(false);
    const sessionProvider = {
      restore: sinon.stub().resolves(session),
      touch: touchStub,
    };

    Object.defineProperty(middleware, 'CoockieSecret', { value: COOKIE_SECRET, configurable: true, writable: true });
    Object.defineProperty(middleware, 'SessionProvider', { value: sessionProvider, configurable: true, writable: true });
    Object.defineProperty(middleware, 'SessionCookieConfig', { value: {}, configurable: true, writable: true });
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('calls touch on an authenticated request', async () => {
    const { req, res, next } = makeReqRes(cs.sign(session.SessionId, COOKIE_SECRET));

    await middleware.before()(req, res, next);

    sinon.assert.calledOnce(touchStub);
    sinon.assert.calledOnce(next);
  });

  it('refreshes the ssid cookie when touch reports the expiry changed (sliding mode)', async () => {
    session.Expiration = (await import('luxon')).DateTime.now().plus({ minutes: 30 });
    touchStub.resolves(true);

    const { req, res, next } = makeReqRes(cs.sign(session.SessionId, COOKIE_SECRET));

    await middleware.before()(req, res, next);

    sinon.assert.calledOnce(res.cookie);
    const [name, value, opts] = res.cookie.firstCall.args;
    expect(name).to.equal('ssid');
    expect(value).to.equal(session.SessionId);
    expect(opts).to.have.property('maxAge');
    expect(opts.maxAge).to.be.greaterThan(0);
    expect(opts.signed).to.be.true;
  });

  it('does NOT refresh the cookie when touch reports no change (absolute mode)', async () => {
    touchStub.resolves(false);

    const { req, res, next } = makeReqRes(cs.sign(session.SessionId, COOKIE_SECRET));

    await middleware.before()(req, res, next);

    sinon.assert.notCalled(res.cookie);
    sinon.assert.calledOnce(next);
  });
});
