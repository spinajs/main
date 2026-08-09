import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import os from 'os';
import { join } from 'path';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import { fsService } from '@spinajs/fs';
import { Controllers, HttpServer } from '@spinajs/http';
import { AuthorizedPolicy, RbacMiddleware, RbacPolicy } from '@spinajs/rbac-http';

import { dir, req, TestConfiguration } from './common.js';

/**
 * Wire-format proof for the "2FA disabled system-wide" guard.
 *
 * `two-factor-policy.test.ts` proves that `TwoFactorAuthEnabled` throws an
 * exception carrying `error.code === 'E_2FA_SYSTEM_DISABLED'` in memory. That
 * value only reaches a real client through machinery the unit test never
 * exercises: @spinajs/http's error handler spreading the exception's own
 * properties, the `Forbidden` -> 403 status map, and the default error
 * `DataTransformer` that response serialization routes through. This suite
 * drives an actual HTTP request through that whole pipeline and asserts on the
 * response the way a caller (the frontend polling `GET /user/2fa`) would.
 *
 * Boot pattern copied from `controller-override.test.ts`, the only sibling
 * suite that starts a real http server for this package: same fs providers,
 * same cookie secret, same policy stubs for the authentication plumbing that
 * sits in front of every `user/*` route and is not what this suite is about.
 */
class TwoFactorDisabledConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    const cfg = this.Config as any;

    // fsNative CREATES its basePath, so every path here points at a directory
    // that is either real or throwaway - never at a spot inside the repo that
    // would be left behind as junk.
    cfg.fs.providers.push(
      { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(os.tmpdir(), 'spinajs-rbac-http-user-2fa-wire-format-cache') },
      { service: 'fsNative', name: '__fs_http_response_templates__', basePath: dir('./../../http/src/views/responses') },
      { service: 'fsNative', name: '__file_upload_default_provider__', basePath: os.tmpdir() },
    );

    // RbacMiddleware refuses to resolve without it ( eg. it signs the ssid
    // cookie ). No request in this suite carries a session, so the value only
    // has to exist.
    cfg.http.cookie = { secret: 'two-factor-wire-format-test-secret' };

    // The one value this suite is actually about: system-wide 2FA switched off.
    cfg.rbac = { twoFactorAuth: { enabled: false, service: 'Default2FaToken' } };
  }
}

describe('GET /user/2fa — system 2FA disabled (wire format)', function () {
  this.timeout(25000);

  before(async () => {
    DI.setESMModuleSupport();

    // Same three stubs as `controller-override.test.ts`, standing in for the
    // authentication plumbing in front of every `user/*` route. A real
    // session, real permission grants and a real database are no part of what
    // this suite is proving — it is about what `TwoFactorAuthEnabled` puts on
    // the wire once it rejects, not about session or permission handling.
    sinon.stub(AuthorizedPolicy.prototype, 'execute').resolves();
    sinon.stub(RbacPolicy.prototype, 'execute').resolves();
    sinon.stub(RbacMiddleware.prototype, 'before').returns((req: any, _res: any, next: any) => {
      req.storage.User = { Role: [] };
      next();
    });

    DI.register(TwoFactorDisabledConfiguration).as(Configuration);

    // Bootstrap before resolving anything - the bootstrappers register the
    // framework's services ( eg. AccessControl, the rbac route-arg extractors,
    // ORM wiring ) that Controllers and the http stack then resolve against.
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    // order matters - @Config getters fire during fs / controller resolution
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);

    const server = await DI.resolve<HttpServer>(HttpServer);
    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    sinon.restore();

    // These suites share one global container, so this file has to leave it
    // as it found it - see `controller-override.test.ts` for why this matters
    // to sibling suites resolving Configuration / Controllers of their own.
    DI.unregister(TwoFactorDisabledConfiguration);
    DI.clearCache();
  });

  it('answers 403 with error.code E_2FA_SYSTEM_DISABLED', async () => {
    const res = await req().get('user/2fa').set('Accept', 'application/json');

    expect(res.status).to.eq(403);
    expect(res.body?.error?.code).to.eq('E_2FA_SYSTEM_DISABLED');
  });
});
