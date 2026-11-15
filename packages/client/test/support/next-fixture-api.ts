// app-basic for fixtures/next-app/scripts/e2e.mjs: prints `{ api, counter }` on stdout once it listens, and serves the
// number of requests per `METHOD path` it has received at `counter`.
import type express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccessPolicy, PrincipalMiddleware } from '@spinajs/authz-http';
import { fsService } from '@spinajs/fs';
import { BaseController, Controllers, HttpServer, ServerMiddleware, type Request } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
import { createTestApp } from '@spinajs/testing';
import { HealthController } from '../../../compiler/test/fixtures/app-basic/src/controllers/HealthController.js';
import { UsersController } from '../../../compiler/test/fixtures/app-basic/src/controllers/users.js';
import { AllowAccess, E2eConfiguration } from './harness.js';

const counts: Record<string, number> = {};

class CountRequests extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 0;
  }

  public before() {
    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      const key = `${req.method} ${req.path}`;
      counts[key] = (counts[key] ?? 0) + 1;
      next();
    };
  }

  public after() {
    return null;
  }
}

// The session cookie makes the CSRF guard check unsafe requests; the Next app's origin is the one it accepts.
class FixtureConfiguration extends E2eConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const origin = process.env.FRONTEND_ORIGIN;
    if (!origin) throw new Error('FRONTEND_ORIGIN is not set');
    (this.Config as { http: Record<string, unknown> }).http.csrf = { ambientCookies: ['session'], allowedOrigins: [origin] };
  }
}

const app = await createTestApp({
  configuration: FixtureConfiguration,
  register: (c) => {
    c.unregister(ServerMiddleware, PrincipalMiddleware);
    for (const controller of [HealthController, UsersController]) c.register(controller).as(BaseController);
    c.register(AllowAccess).as(AccessPolicy);
    c.register(CountRequests).as(ServerMiddleware);
  },
  resolve: [fsService, Intl, Controllers],
  bootTimeout: 50000,
});
const http = await app.resolve(HttpServer);
await http.start();
const { port } = http.Server.address() as AddressInfo;

const counter = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(counts));
});
await new Promise<void>((resolve) => counter.listen(0, '127.0.0.1', resolve));

const stop = () => {
  counter.close();
  void app.dispose().finally(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

console.log(JSON.stringify({ api: `http://127.0.0.1:${port}`, counter: `http://127.0.0.1:${(counter.address() as AddressInfo).port}` }));
