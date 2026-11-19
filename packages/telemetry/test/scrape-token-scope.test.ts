import 'mocha';
import { expect } from 'chai';
import { IsAuthenticated } from '@spinajs/authz-http';
import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';

import '../src/index.js';
import { TEST_TOKEN } from './common.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

@BasePath('host-app')
class HostRoutes extends BaseController {
  @Get('status')
  @Policy(IsAuthenticated)
  public status() {
    return new Ok({ ok: true });
  }
}

const TOKEN_HEADERS: Record<string, string>[] = [{ 'x-metrics-token': TEST_TOKEN }, { authorization: `Bearer ${TEST_TOKEN}` }];

describe('the scrape token outside telemetry', function () {
  this.timeout(30000);

  const get = (app: TestApp, path: string, headers: Record<string, string>) => {
    let r = app.request().get(path).set('Accept', 'application/json');
    for (const [name, value] of Object.entries(headers)) r = r.set(name, value);
    return r;
  };

  describe('with the bridged telemetry.auth.token', () => {
    let app: TestApp;
    let unregisterSource: () => void;

    before(async () => {
      unregisterSource = registerHeaderSource();
      app = await startApp({ rbac: true, controllers: [HostRoutes] });
    });

    after(async () => {
      await stopApp();
      unregisterSource?.();
    });

    it('is refused 401 by an IsAuthenticated route of the host app, on either header', async () => {
      for (const headers of TOKEN_HEADERS) {
        const res = await get(app, '/host-app/status', headers);
        expect(res.status, JSON.stringify(headers)).to.eq(401);
        expect(res.body, JSON.stringify(headers)).to.deep.include({ error: 'unauthenticated' });
      }
    });

    it('still reads the telemetry endpoints, on either header', async () => {
      for (const headers of TOKEN_HEADERS) {
        for (const path of ['/metrics', '/telemetry/stats']) {
          expect((await get(app, path, headers)).status, `${path} ${JSON.stringify(headers)}`).to.eq(200);
        }
      }
    });

    it('leaves the IsAuthenticated route open to an authenticated user', async () => {
      expect((await get(app, '/host-app/status', { 'x-user': 'alice' })).status).to.eq(200);
    });

    it('leaves the telemetry endpoints refusing an anonymous caller with 401', async () => {
      const res = await get(app, '/telemetry/stats', {});
      expect(res.status).to.eq(401);
      expect(res.body).to.deep.include({ error: 'unauthenticated' });
    });
  });

  describe('with an explicit telemetry entry marked authenticated: false', () => {
    let app: TestApp;

    before(async () => {
      app = await startApp({
        rbac: true,
        controllers: [HostRoutes],
        config: { 'authz.http.services': [{ name: 'telemetry', header: 'x-scrape', token: 'scrape-token-456', authenticated: false }] },
      });
    });

    after(async () => {
      await stopApp();
    });

    it('reads telemetry and is refused 401 by the IsAuthenticated route', async () => {
      expect((await get(app, '/telemetry/stats', { 'x-scrape': 'scrape-token-456' })).status).to.eq(200);
      expect((await get(app, '/host-app/status', { 'x-scrape': 'scrape-token-456' })).status).to.eq(401);
    });
  });
});
