import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import os from 'os';
import { join } from 'path';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import { fsService } from '@spinajs/fs';
import { Controllers, ForbiddenResponse, HttpServer } from '@spinajs/http';
import { RbacMiddleware, RbacPolicy } from '@spinajs/rbac-http';
import { UserSession } from '@spinajs/rbac';

import { dir, req, TestConfiguration } from './common.js';

/**
 * Wire-format proof for the system-wide 2FA switch, driven through a real
 * HTTP request rather than calling the controller directly.
 *
 * `@spinajs/http` merges every policy on a route into one gate that passes
 * when ANY policy resolves (`route-builder.ts`'s `createPolicyGate`), and
 * every `/user/2fa*` route also carries `AuthorizedPolicy` — which succeeds
 * for any logged-in caller. Enforcement therefore lives in the handler
 * (`TwoFactorAuthUserController.assertSystemEnabled`), not in a policy. This
 * suite proves that from the outside: an AUTHORIZED caller still gets a 200
 * with `SystemEnabled: false` from `status`, and still gets refused by the
 * mutating routes — the way a real frontend session would experience it.
 *
 * The caller is made authorized for real, not by stubbing
 * `AuthorizedPolicy.execute` to always resolve: that stub would make the gate
 * pass unconditionally and prove nothing about authorization specifically.
 * Instead `RbacMiddleware.before` is replaced with a stub that populates
 * `req.storage.User` and `req.storage.Session` (with `Authorized: true`) the
 * way the real middleware would after a real login — exactly what
 * `AuthorizedPolicy.execute` itself checks for. The unstubbed policy is left
 * to run and genuinely resolve.
 *
 * Boot pattern copied from `controller-override.test.ts`, the only sibling
 * suite that starts a real http server for this package: same fs providers,
 * same cookie secret, same `RbacPolicy` stub (real per-permission grants are
 * not what this suite is about — only the system-wide switch is).
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
    // cookie ). Requests in this suite carry no real ssid cookie — `before`
    // stubs `RbacMiddleware.before` to plant an authorized session directly —
    // so the value only has to exist for the middleware to resolve.
    cfg.http.cookie = { secret: 'two-factor-wire-format-test-secret' };

    // The one value this suite is actually about: system-wide 2FA switched off.
    cfg.rbac = { twoFactorAuth: { enabled: false, service: 'Default2FaToken' } };
  }
}

describe('system 2FA disabled, authorized caller (wire format)', function () {
  this.timeout(25000);

  before(async () => {
    DI.setESMModuleSupport();

    // `RbacPolicy` (attached by `@Permission`) still needs a real
    // AccessControl grant lookup against a database this suite has none of —
    // stubbed for the same reason `controller-override.test.ts` stubs it.
    // `AuthorizedPolicy` is deliberately left UNSTUBBED: the middleware stub
    // below feeds it exactly what it checks (`req.storage.User` and
    // `req.storage.Session.Data.get('Authorized')`), so it runs its real
    // `execute` and genuinely resolves. Stubbing it too would make the gate
    // pass unconditionally and prove nothing about authorization.
    sinon.stub(RbacPolicy.prototype, 'execute').resolves();
    sinon.stub(RbacMiddleware.prototype, 'before').returns((req: any, _res: any, next: any) => {
      const session = new UserSession();
      session.Data.set('Authorized', true);

      req.storage.User = { Role: [], Metadata: {} };
      req.storage.Session = session;
      next();
    });

    // `@HandleException(Forbidden)` on `ForbiddenResponse` registers the
    // Forbidden -> 403 mapping exactly once, as a side effect of that module
    // loading (`DI.register(...).asMapValue('__http_error_map__', 'Forbidden')`,
    // which stores the map in the container CACHE, not the registry). A sibling
    // suite's `DI.clearCache()` — several call it in `after()`, same as this
    // suite does below — wipes that cache, and nothing ever repopulates it: the
    // decorator runs once per process, long before any suite executes.
    // Depending on run order this suite's genuine `Forbidden` throw would
    // resolve to a 500 instead of 403 even though the response body carries the
    // right `error.code`. Re-registering it here makes the outcome independent
    // of what ran before this suite.
    DI.register(ForbiddenResponse).asMapValue('__http_error_map__', 'Forbidden');

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

  it('reports the system switch as off instead of failing', async () => {
    const res = await req().get('user/2fa').set('Accept', 'application/json');

    expect(res.status).to.eq(200);
    expect(res.body?.SystemEnabled).to.eq(false);
  });

  it('refuses to enrol while the switch is off', async () => {
    const res = await req().post('user/2fa/enable').send({ Password: 'current123' }).set('Accept', 'application/json');

    expect(res.status).to.eq(403);
    expect(res.body?.error?.code).to.eq('E_2FA_SYSTEM_DISABLED');
  });
});
