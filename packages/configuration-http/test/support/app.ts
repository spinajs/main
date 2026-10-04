import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { PrincipalMiddleware } from '@spinajs/authz-http';
import { testHost } from '@spinajs/authz-testing';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Loads every package's config defaults, as an app does; the result seeds testHost's in-memory configuration. */
class DefaultsConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
    };
  }
}

function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.keys(value).map((k) => [k, plain(value[k])]));
  return value;
}

let running: { server: HttpServer; controllers: Class<BaseController>[] } | undefined;

/**
 * Boots an http server over testHost's in-memory configuration, seeded with the package defaults and
 * `config` (dotted path to value). `skip` names bootstrappers by class name. Pair with `stopApp()`.
 */
export async function startApp(opts: {
  controllers: Class<BaseController>[];
  config: Readonly<Record<string, unknown>>;
  skip?: readonly string[];
}): Promise<void> {
  if (running) throw new Error('startApp: an app is already running; call stopApp() first');

  for (const b of (await DI.resolve(Array.ofType(Bootstrapper))) as Bootstrapper[]) {
    if (opts.skip?.includes(b.constructor.name)) continue;
    await b.bootstrap();
  }

  const defaults = (await DI.resolve(DefaultsConfiguration)) as DefaultsConfiguration;
  const seeded = plain(defaults.RootConfig) as Record<string, unknown>;
  DI.uncache(DefaultsConfiguration);

  const cfg = await testHost.installHost();
  cfg.set([], seeded);
  for (const [path, value] of Object.entries(opts.config)) cfg.set(path.split('.'), value);

  const before = new Set(DI.getRegisteredTypes(BaseController) ?? []);
  for (const c of opts.controllers) DI.register(c).as(BaseController);

  await DI.resolve(fsService);
  await DI.resolve(Controllers);
  const server = (await DI.resolve(HttpServer)) as HttpServer;
  await server.start();

  running = {
    server,
    controllers: [...new Set(DI.getRegisteredTypes(BaseController) ?? [])].filter(
      (t) => !before.has(t),
    ) as Class<BaseController>[],
  };
}

/** Stops the server and removes what `startApp` added; never `DI.clearCache()`. */
export async function stopApp(): Promise<void> {
  if (!running) return;
  const { server, controllers } = running;
  running = undefined;

  await server.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  for (const c of controllers) DI.unregister(c);
  DI.uncache(BaseController);
  await DI.get(PrincipalMiddleware)?.dispose();
  for (const type of DI.getRegisteredTypes(ServerMiddleware) ?? []) DI.uncache(type as Class<ServerMiddleware>);
  DI.uncache(ServerMiddleware);
  await testHost.uninstallHost();
}
