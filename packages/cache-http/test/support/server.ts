import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import type { IMiddlewareContext } from '@spinajs/http';
import { LogLevel, LogTarget } from '@spinajs/log';
import type { ICommonTargetOptions, ILogEntry } from '@spinajs/log';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

export const SILENT_LOGGER = { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

/** How many times each action ran since the test started. */
export const runs = new Map<string, number>();

export function run(name: string): number {
  const n = (runs.get(name) ?? 0) + 1;
  runs.set(name, n);
  return n;
}

/**
 * Stands in for the server middlewares that fill the request's store: `x-user` is the principal authz-http would
 * resolve, `x-lang` the language intl-http would detect, `x-tenant` a value the test scope part reads, `x-no-cache` a
 * flag the test CacheScope reads, `x-authn-only` the principal authn-http alone leaves.
 */
export class HeaderStore extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 10;
  }

  public onBefore({ req, storage }: IMiddlewareContext): void {
    const header = (name: string): string | undefined => {
      const value = req.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const user = header('x-user');
    if (user !== undefined) Reflect.set(storage, 'Principal', { type: 'user', id: user, authenticated: true, source: 'test', attributes: {} });
    // what authz-http's PrincipalMiddleware resolves for a caller without credentials
    if (header('x-anonymous') !== undefined) Reflect.set(storage, 'Principal', { type: 'anonymous', id: 'anonymous', authenticated: false, source: 'anonymous', attributes: {} });
    const authnOnly = header('x-authn-only');
    if (authnOnly !== undefined) Reflect.set(storage, 'AuthnPrincipal', { type: 'user', id: authnOnly, authenticated: true, source: 'authn', attributes: {} });
    const language = header('x-lang');
    if (language !== undefined) Reflect.set(storage, 'language', language);
    const tenant = header('x-tenant');
    if (tenant !== undefined) Reflect.set(storage, 'TestTenant', tenant);
    if (header('x-no-cache') !== undefined) Reflect.set(storage, 'NoCache', true);
    const fail = header('x-fail');
    if (fail !== undefined) Reflect.set(storage, 'Fail', fail);
  }
}

export class CaptureLogTarget extends LogTarget<ICommonTargetOptions> {
  public static readonly Entries: ILogEntry[] = [];

  public write(entry: ILogEntry): void {
    CaptureLogTarget.Entries.push(entry);
  }
}

/** The warnings of the logger `cache` since the server started, as written. */
export const cacheWarnings = (): string[] =>
  CaptureLogTarget.Entries.filter((e) => e.Variables.logger === 'cache' && e.Level === LogLevel.Warn).map((e) => String(e.Variables.message));

// http.routes.middlewares of the next useServer boot: the configuration class is instantiated by the boot itself
let globalRouteMiddlewares: readonly string[] = [];
// cache.http of the next boot
let cacheHttp: Readonly<Record<string, number>> = {};

class CacheHttpConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const provider = (name: string) => ({ service: 'fsNative', name, basePath: tmpdir() });
    this.Config = {
      system: { dirs: { controllers: [] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [provider('fs-temp'), provider('__file_upload_default_provider__'), provider('__fs_http_templates__'), provider('__fs_controller_cache__'), provider('__fs_http_response_templates__')],
      },
      logger: {
        targets: [...SILENT_LOGGER.targets, { name: 'Capture', type: 'CaptureLogTarget' }],
        rules: [...SILENT_LOGGER.rules, { name: 'cache', level: 'warn', target: 'Capture' }],
      },
      http: { port: 0, shutdownTimeout: 1000, middlewares: [], AcceptHeaders: 1 | 2, routes: { middlewares: [...globalRouteMiddlewares] } },
      cache: { caches: { hung: { store: 'HangingStore' } }, http: { timeout: 200, ...cacheHttp } },
      intl: { queryParameter: 'lang', defaultLocale: 'en' },
    };
  }
}

export interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/**
 * Boots the server in `before` and stops it in `after` of the enclosing describe; `runs` is cleared before each test.
 * `routeMiddlewares` are names of RouteMiddleware registrations for `http.routes.middlewares`; `overrides` replaces
 * keys of `cache.http`.
 */
export function useServer(controllers: readonly (typeof BaseController)[], register: (c: IContainer) => void = () => undefined, routeMiddlewares: readonly string[] = [], overrides: Readonly<Record<string, number>> = {}) {
  const server: { port: number; app?: TestApp } = { port: 0 };

  before(async () => {
    globalRouteMiddlewares = routeMiddlewares;
    cacheHttp = overrides;
    server.app = await createTestApp({
      configuration: CacheHttpConfiguration,
      register: (c) => {
        for (const type of controllers) c.register(type).as(BaseController);
        c.register(HeaderStore).as(ServerMiddleware);
        // log targets are resolved by their type name
        c.register(CaptureLogTarget).as('CaptureLogTarget');
        register(c);
      },
      resolve: [fsService, Controllers],
      bootTimeout: 50000,
    });
    const http = await server.app.resolve(HttpServer);
    await http.start();
    server.port = (http.Server.address() as AddressInfo).port;
  });

  after(async () => {
    await DI.get(HttpServer)?.stop();
    await server.app?.dispose();
  });

  beforeEach(() => runs.clear());

  const send = (method: string, path: string, headers: Record<string, string> = {}): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const req = request({ method, host: '127.0.0.1', port: server.port, path, headers: { accept: 'application/json', ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text === '' ? null : (JSON.parse(text) as unknown) }));
      });
      req.on('error', reject);
      req.end();
    });
  const get = (path: string, headers: Record<string, string> = {}): Promise<Answer> => send('GET', path, headers);

  return { server, send, get };
}

/** The error a boot with these controllers fails with; undefined when it boots, and the app is disposed again. */
export async function bootFailure(controllers: readonly (typeof BaseController)[], overrides: Readonly<Record<string, number>> = {}): Promise<Error | undefined> {
  globalRouteMiddlewares = [];
  cacheHttp = overrides;
  try {
    const app = await createTestApp({
      configuration: CacheHttpConfiguration,
      register: (c) => {
        for (const type of controllers) c.register(type).as(BaseController);
        c.register(CaptureLogTarget).as('CaptureLogTarget');
      },
      resolve: [fsService, Controllers],
      bootTimeout: 50000,
    });
    await app.dispose();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
