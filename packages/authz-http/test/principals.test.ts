import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthzService, Unauthenticated, authz } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok, Req, ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import type * as express from 'express';

import { ANONYMOUS, AuthnPrincipalSource, PrincipalMiddleware, PrincipalSource } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';

const bob = userPrincipal('bob');
const carol = userPrincipal('carol');

@BasePath('whoami')
class WhoAmI extends BaseController {
  @Get('/')
  public who(@Req() req: Request) {
    return new Ok({ stored: req.storage.Principal ?? null, current: authz().current() });
  }
}

/** Stands in for authn-http's AuthnMiddleware (Order 5): `x-authn: <id>` becomes req.storage.AuthnPrincipal. */
class StubAuthnMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 5;
  }

  public before() {
    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      const id = req.headers['x-authn'];
      req.storage.AuthnPrincipal = typeof id === 'string' ? userPrincipal(id) : null;
      next();
    };
  }

  public after() {
    return null;
  }
}

const calls = { early: 0, late: 0, failing: 0 };

/** Registered by class: DI never returns factory registrations from Array.ofType. */
class EarlySource extends PrincipalSource {
  public readonly name = 'early';
  public readonly order = 45;

  public async authenticate(req: Request): Promise<Principal | null> {
    calls.early++;
    return req.headers['x-early'] === 'carol' ? carol : null;
  }
}

class LateSource extends PrincipalSource {
  public readonly name = 'late';
  public readonly order = 60;

  public async authenticate(req: Request): Promise<Principal | null> {
    calls.late++;
    return req.headers['x-late'] === 'bob' ? bob : null;
  }
}

class FailingSource extends PrincipalSource {
  public readonly name = 'failing';
  public readonly order = 1;

  public async authenticate(req: Request): Promise<Principal | null> {
    calls.failing++;
    if (req.headers['x-fail'] !== undefined) throw new Unauthenticated('bad credential');
    return null;
  }
}

const SOURCES = [EarlySource, LateSource, FailingSource];

describe('PrincipalMiddleware', function () {
  this.timeout(30000);

  let app: TestApp;
  let preload: sinon.SinonSpy;

  before(async () => {
    DI.register(StubAuthnMiddleware).as(ServerMiddleware);
    for (const s of SOURCES) DI.register(s).as(PrincipalSource);
    app = await startApp({ controllers: [WhoAmI] });
    preload = sinon.spy((await DI.resolve(AuthzService)) as AuthzService, 'preload');
  });

  after(async () => {
    preload?.restore();
    await stopApp();
    for (const t of [StubAuthnMiddleware, ...SOURCES] as Class<unknown>[]) {
      DI.unregister(t);
      DI.uncache(t);
    }
    DI.uncache(PrincipalSource);
  });

  beforeEach(() => {
    preload.resetHistory();
    Object.assign(calls, { early: 0, late: 0, failing: 0 });
  });

  it('is a server middleware after authn-http (Order 5) and AuthnPrincipalSource reads order 50', () => {
    expect(new PrincipalMiddleware().Order).to.be.greaterThan(5);
    expect(new AuthnPrincipalSource()).to.include({ name: 'authn', order: 50 });
  });

  it("takes authn-http's req.storage.AuthnPrincipal through AuthnPrincipalSource", async () => {
    const res = await app.request().get('/whoami').set('x-authn', 'alice');

    expect(res.status).to.eq(200);
    expect(res.body.stored).to.deep.include({ type: 'user', id: 'alice' });
  });

  it('runs the sources by order and the first non-null answer wins', async () => {
    const res = await app.request().get('/whoami').set('x-authn', 'alice').set('x-early', 'carol').set('x-late', 'bob');

    expect(res.body.stored).to.deep.include({ type: 'user', id: 'carol' });
    expect(calls.early).to.eq(1);
    expect(calls.late).to.eq(0);

    const later = await app.request().get('/whoami').set('x-late', 'bob');
    expect(later.body.stored).to.deep.include({ type: 'user', id: 'bob' });
    expect(calls.late).to.eq(1);
  });

  it('puts the principal in the store the action runs with, so authz().current() returns it', async () => {
    const res = await app.request().get('/whoami').set('x-authn', 'alice');

    expect(res.body.current).to.deep.include({ type: 'user', id: 'alice' });
  });

  it('preloads the principal in the root domain', async () => {
    await app.request().get('/whoami').set('x-authn', 'alice');

    expect(preload.callCount).to.eq(1);
    expect(preload.firstCall.args[0]).to.deep.include({ type: 'user', id: 'alice' });
  });

  it('falls back to the anonymous principal while authz.principals.anonymous.enabled', async () => {
    const res = await app.request().get('/whoami');

    expect(res.status).to.eq(200);
    expect(res.body.stored).to.deep.eq(ANONYMOUS);
    expect(preload.firstCall.args[0]).to.eq(ANONYMOUS);
  });

  it('leaves no principal when anonymous is disabled; the action runs unattended', async () => {
    testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
    try {
      const res = await app.request().get('/whoami');

      expect(res.status).to.eq(200);
      expect(res.body.stored).to.eq(null);
      expect(res.body.current).to.deep.include({ type: 'unattended' });
      expect(preload.callCount).to.eq(0);
    } finally {
      testHost.config().unset(['authz', 'principals', 'anonymous', 'enabled']);
    }
  });

  it('a configured service header wins over the authn principal (ServicePrincipalSource, order 40)', async () => {
    testHost.config().set(['authz', 'http', 'services'], [{ name: 'telemetry', header: 'X-Telemetry-Token', token: 's3cret' }]);
    try {
      const res = await app.request().get('/whoami').set('x-authn', 'alice').set('x-telemetry-token', 's3cret');
      expect(res.body.stored).to.deep.include({ type: 'service', id: 'telemetry' });

      const wrong = await app.request().get('/whoami').set('x-authn', 'alice').set('x-telemetry-token', 'nope');
      expect(wrong.body.stored).to.deep.include({ type: 'user', id: 'alice' });
    } finally {
      testHost.config().unset(['authz', 'http', 'services']);
    }
  });

  it('a source that throws Unauthenticated answers 401', async () => {
    const res = await app.request().get('/whoami').set('x-fail', '1');

    expect(res.status).to.eq(401);
    expect(calls.early).to.eq(0);
  });
});
