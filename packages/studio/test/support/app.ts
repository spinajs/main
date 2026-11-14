import type { AddressInfo } from 'node:net';

import chai from 'chai';
import chaiHttp from 'chai-http';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import type { DecisionRequest } from '@spinajs/authz';
import { PrincipalMiddleware } from '@spinajs/authz-http';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import type { VoteFn } from '@spinajs/authz-testing';

import { STUDIO_SERVICES } from '../../src/index.js';
import { testConfig } from './config.js';

chai.use(chaiHttp);

export interface TestApp {
  readonly server: HttpServer;
  readonly port: number;
  request(): ChaiHttp.Agent;
}

export const STUDIO_TEST_PERMISSIONS: readonly string[] = ['studio:read', 'studio:explain', 'authz:explain'];

/** bob holds every Studio permission and authz:explain; anyone else holds nothing. */
export const studioVotes: VoteFn = (req: DecisionRequest) => (req.principal.id === 'bob' && STUDIO_TEST_PERMISSIONS.includes(req.permission) ? { permitWhen: { op: 'true' } } : {});

export interface StartOptions {
  readonly config?: Readonly<Record<string, unknown>>;
  /** Votes of the root StaticModel `m1`; default {@link studioVotes}. */
  readonly votes?: VoteFn;
}

let running: { server: HttpServer; before: Set<unknown> } | undefined;

// http and authz-http register this map at import; a suite's DI.clearCache() drops it and every mapped error renders as a 500.
const ERROR_MAP = DI.get<Map<string, Class<unknown>>>('__http_error_map__');

/**
 * Boots an http server on a free port over testHost's in-memory configuration, seeded with `testConfig()`
 * and `config` (dotted path to value). Studio controllers come from StudioControllerSource, which the
 * import of `src/index.ts` above registered. Pair with `stopApp()` in an `after`/`afterEach` hook.
 */
export async function startApp(opts: StartOptions = {}): Promise<TestApp> {
  if (running) throw new Error('startApp: an app is already running; call stopApp() first');

  const errorMap = DI.get<Map<string, Class<unknown>>>('__http_error_map__');
  for (const [name, type] of ERROR_MAP ?? []) if (!errorMap?.has(name)) DI.register(type).asMapValue('__http_error_map__', name);

  const cfg = await testHost.installHost();
  cfg.set([], testConfig());
  for (const [path, value] of Object.entries(opts.config ?? {})) cfg.set(path.split('.'), value);
  // Root activates only the models authz.models names; activate registers m1 and lists it (uninstallHost removes both).
  testHost.activate(DI.RootContainer, 'root', new StaticModel({ name: 'm1', votes: opts.votes ?? studioVotes }));

  DI.resolve(FsBootsrapper).bootstrap();
  await DI.resolve(fsService);
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }

  const before = new Set(DI.getRegisteredTypes(BaseController) ?? []);
  await DI.resolve(Controllers);
  const server = await DI.resolve(HttpServer);
  await server.start();

  running = { server, before };
  const port = (server.Server.address() as AddressInfo).port;
  return { server, port, request: () => chai.request(`http://127.0.0.1:${port}`) };
}

/** Stops the server and removes what `startApp` added; never `DI.clearCache()`. */
export async function stopApp(): Promise<void> {
  if (!running) return;
  const { server, before } = running;
  running = undefined;
  const added = [...new Set(DI.getRegisteredTypes(BaseController) ?? [])].filter((t) => !before.has(t));

  await server.stop();
  for (const type of STUDIO_SERVICES) {
    await (DI.get(type as Class<{ dispose?(): Promise<void> }>) ?? undefined)?.dispose?.();
    DI.uncache(type);
  }
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type);
  for (const c of added) {
    // Controllers registers a type a second time on add().
    for (let i = 0; i < 3 && (DI.getRegisteredTypes(BaseController) ?? []).includes(c); i++) DI.unregister(c);
  }
  DI.uncache(BaseController);
  await DI.get(PrincipalMiddleware)?.dispose();
  for (const type of DI.getRegisteredTypes(ServerMiddleware) ?? []) DI.uncache(type);
  DI.uncache(ServerMiddleware);
  await testHost.uninstallHost();
}
