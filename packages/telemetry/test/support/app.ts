import type { AddressInfo } from 'node:net';

import chai from 'chai';
import chaiHttp from 'chai-http';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { PrincipalMiddleware } from '@spinajs/authz-http';
import { testHost } from '@spinajs/authz-testing';

import { testConfig } from '../common.js';

chai.use(chaiHttp);

export interface TestApp {
  readonly server: HttpServer;
  readonly controllers: Controllers;
  request(): ChaiHttp.Agent;
}

let running: { server: HttpServer; before: Set<unknown> } | undefined;

/**
 * Boots an http server on a free port over testHost's in-memory configuration (so `hostHarness` can
 * share it), seeded with the telemetry test configuration and `config` (dotted path to value). The
 * controller dirs stay those of `testConfig()`: the file scan is memoized per process, so every suite
 * must scan the same dirs. Pair with `stopApp()` in an `after` hook.
 */
export async function startApp(opts: { controllers?: Class<BaseController>[]; config?: Readonly<Record<string, unknown>> } = {}): Promise<TestApp> {
  if (running) throw new Error('startApp: an app is already running; call stopApp() first');

  DI.setESMModuleSupport();
  const cfg = await testHost.installHost();
  cfg.set([], testConfig());
  cfg.set(['http', 'port'], 0);
  for (const [path, value] of Object.entries(opts.config ?? {})) cfg.set(path.split('.'), value);

  DI.resolve(FsBootsrapper).bootstrap();
  await DI.resolve(fsService);
  for (const b of (await DI.resolve(Array.ofType(Bootstrapper))) as Bootstrapper[]) {
    await b.bootstrap();
  }

  const before = new Set(DI.getRegisteredTypes(BaseController) ?? []);
  for (const c of opts.controllers ?? []) DI.register(c).as(BaseController);

  const controllers = (await DI.resolve(Controllers)) as Controllers;
  const server = (await DI.resolve(HttpServer)) as HttpServer;
  await server.start();

  running = { server, before };
  const port = (server.Server.address() as AddressInfo).port;
  return { server, controllers, request: () => chai.request(`http://127.0.0.1:${port}`) };
}

/** Stops the server and removes what `startApp` added; never `DI.clearCache()`. */
export async function stopApp(): Promise<void> {
  if (!running) return;
  const { server, before } = running;
  running = undefined;
  // Also what http and the tests registered since boot, so no controller outlives this app.
  const added = [...new Set(DI.getRegisteredTypes(BaseController) ?? [])].filter((t) => !before.has(t)) as Class<BaseController>[];

  await server.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  for (const c of added) {
    // Controllers.add registers a type a second time.
    for (let i = 0; i < 3 && (DI.getRegisteredTypes(BaseController) ?? []).includes(c); i++) DI.unregister(c);
  }
  DI.uncache(BaseController);
  await DI.get(PrincipalMiddleware)?.dispose();
  for (const type of DI.getRegisteredTypes(ServerMiddleware) ?? []) DI.uncache(type as Class<ServerMiddleware>);
  DI.uncache(ServerMiddleware);
  await testHost.uninstallHost();
}
