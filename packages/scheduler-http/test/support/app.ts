import type { AddressInfo } from 'node:net';

import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { Orm, OrmMigrator } from '@spinajs/orm';
import { AuthorizationModel } from '@spinajs/authz';
import { PrincipalMiddleware, PrincipalSource } from '@spinajs/authz-http';
import { testHost } from '@spinajs/authz-testing';

import { roleModel, TestRoleSource } from './principals.js';

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
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.keys(value).map((k) => [k, plain(value[k])]));
  return value;
}

let app: { server: HttpServer; controllers: Class<BaseController>[]; port: number } | undefined;

/** Port of the running app; `http.port` is 0, so every start binds a free one. */
export function appPort(): number {
  if (!app) throw new Error('no app running: call startApp() first');
  return app.port;
}

/**
 * Boots an http server over testHost's in-memory configuration, seeded with the package defaults and
 * `config` (dotted path to value), with the ORM resolved before the server starts. The controllers are
 * registered for this app only; requests sign in through `TestRoleSource` and are decided by `roleModel()`.
 * Pair with `stopApp()` in an `after` hook.
 */
export async function startApp(opts: { controllers: Class<BaseController>[]; config: Readonly<Record<string, unknown>> }): Promise<HttpServer> {
  if (app) throw new Error('startApp: an app is already running; call stopApp() first');

  for (const b of await DI.resolve<Bootstrapper>(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }

  const defaults = await DI.resolve<DefaultsConfiguration>(DefaultsConfiguration);
  const seeded = plain(defaults.RootConfig) as Record<string, unknown>;
  DI.uncache(DefaultsConfiguration);

  const cfg = await testHost.installHost();
  cfg.set([], seeded);
  cfg.set(['http', 'port'], 0);
  // Installed packages' defaults declare list permissions (configuration:read, team:read, …), and boot rule 12
  // refuses them on the role model: it routes every permission and cannot plan lists.
  for (const [name, def] of Object.entries(cfg.get<Record<string, unknown>>(['authz', 'permissions']) ?? {})) {
    if (isRecord(def) && def.list === true) cfg.set(['authz', 'permissions', name, 'list'], false);
  }
  for (const [path, value] of Object.entries(opts.config)) cfg.set(path.split('.'), value);

  testHost.registerInRoot(PrincipalSource, TestRoleSource);
  testHost.registerInRoot(AuthorizationModel, testHost.instance(roleModel()));

  const before = new Set(DI.getRegisteredTypes(BaseController) ?? []);
  for (const c of opts.controllers) DI.register(c).as(BaseController);

  await DI.resolve(fsService);
  await (await DI.resolve(Orm)).Migrator.ready();
  await DI.resolve(Controllers);
  const server = await DI.resolve<HttpServer>(HttpServer);
  await server.start();

  const port = (server.Server.address() as AddressInfo).port;
  // Also what http registered itself (the sources), so no controller outlives this app.
  app = { server, controllers: [...new Set<Class<BaseController>>(DI.getRegisteredTypes(BaseController) ?? [])].filter((t) => !before.has(t)), port };
  return server;
}

/** Stops the server and removes what `startApp` added; never `DI.clearCache()`. */
export async function stopApp(): Promise<void> {
  if (!app) return;
  const { server, controllers } = app;
  app = undefined;

  await server.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type);
  for (const c of controllers) DI.unregister(c);
  DI.uncache(BaseController);
  await DI.get(PrincipalMiddleware)?.dispose();
  // Middlewares keep what they resolved at boot (PrincipalMiddleware: the root AuthzService uninstallHost disposes).
  for (const type of DI.getRegisteredTypes(ServerMiddleware) ?? []) DI.uncache(type);
  DI.uncache(ServerMiddleware);
  DI.uncache(TestRoleSource);
  DI.uncache(PrincipalSource);

  const orm = DI.get(Orm);
  if (orm) {
    await orm.dispose();
    DI.uncache(Orm);
    DI.uncache(OrmMigrator);
  }

  await testHost.uninstallHost();
}
