import assert from 'node:assert/strict';
import 'mocha';
import { CookieJar, send } from '@spinajs/authn-testing';
import type { HarnessContext, ProbeBody } from '@spinajs/authn-testing';

import { PROBE_PATH } from '../support/AuthnProbeController.js';
import { usersAuthnHarness } from '../support/authn-harness.js';
import { ROUTES, registerRootRbac, startUsersHttpApp, stopUsersHttpApp, usersHttpApp } from '../support/http-app.js';

const PASSWORD = 'mfa-port-Pass-1';

describe('users http app (C3b test support)', function () {
  this.timeout(120000);

  describe('started without root RBAC', function () {
    before(async function () {
      await startUsersHttpApp();
    });

    after(async function () {
      await stopUsersHttpApp();
    });

    it('boots the root domain and serves requests', async function () {
      const app = usersHttpApp();
      assert.equal((await app.send({ method: 'GET', path: '/auth' })).status, 401);
      const probe = await app.send({ method: 'GET', path: `/${PROBE_PATH}` });
      assert.equal(probe.status, 200);
      assert.equal((probe.body as ProbeBody).principal, null);
    });
  });

  describe("the harness's mfa port", function () {
    before(async function () {
      await startUsersHttpApp({ register: registerRootRbac });
    });

    after(async function () {
      await stopUsersHttpApp();
    });

    // Two cases in a row: each harness has its own step, and the second proves the swap reaches the app.
    for (const round of [1, 2]) {
      it(`drives the step the app verifies (case ${round})`, async function () {
        const h = await usersAuthnHarness({ config: {} } as unknown as HarnessContext);
        const http = { http: h.http! };
        try {
          const ref = await h.seed!.user({ login: `mfa-port-${round}@users.test`, password: PASSWORD });
          await h.mfa!.enrol(ref);
          const jar = new CookieJar();

          assert.equal((await send(http, ROUTES.login!(`mfa-port-${round}@users.test`, PASSWORD), jar)).status, 200);
          assert.equal(((await send(http, { method: 'GET', path: h.http!.probePath }, jar)).body as ProbeBody).principal, null, 'login leaves a pending session');

          const verified = await send(http, ROUTES.mfaVerify!(await h.mfa!.code(ref)), jar);
          assert.equal(verified.status, 200, `mfa verify: ${JSON.stringify(verified.body)}`);
          const principal = ((await send(http, { method: 'GET', path: h.http!.probePath }, jar)).body as ProbeBody).principal;
          assert.equal(principal?.id, ref.id);
          assert.equal(principal?.authn?.assurance, 'aal2');
          assert.deepEqual(principal?.authn?.mfa, ['totp']);
        } finally {
          await h.dispose!();
        }
      });
    }
  });
});
