import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chai from 'chai';
import chaiHttp from 'chai-http';
import { Bootstrapper, DI } from '@spinajs/di';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { ArgInputFilter, BaseController, Controllers, DataTransformer, HttpServer, ServerMiddleware } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { testHost } from '@spinajs/authz-testing';
import { AuthzFieldTransformer, AuthzInputFieldFilter, ExplainPolicy, PrincipalMiddleware } from '../../src/index.js';
chai.use(chaiHttp);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Loads every package's config defaults, as an app does; the result seeds testHost's in-memory configuration. */
class DefaultsConfiguration extends FrameworkConfiguration {
    onLoad() {
        return {
            logger: {
                targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
                rules: [{ name: '*', level: 'trace', target: 'Empty' }],
            },
        };
    }
}
function plain(value) {
    if (Array.isArray(value))
        return value.map(plain);
    if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype)
        return Object.fromEntries(Object.keys(value).map((k) => [k, plain(value[k])]));
    return value;
}
let app;
/**
 * Boots an http server on a free port over testHost's in-memory configuration (so `hostHarness`
 * can share it), seeded with the package defaults and `config`. The controllers are registered for
 * this app only. Pair with `stopApp()` in an `after` hook.
 */
export async function startApp(opts = {}) {
    if (app)
        throw new Error('startApp: an app is already running; call stopApp() first');
    for (const b of (await DI.resolve(Array.ofType(Bootstrapper)))) {
        await b.bootstrap();
    }
    const defaults = (await DI.resolve(DefaultsConfiguration));
    const seeded = plain(defaults.RootConfig);
    DI.uncache(DefaultsConfiguration);
    const cfg = await testHost.installHost();
    cfg.set([], seeded);
    cfg.set(['http', 'port'], 0);
    // The package defaults list the controller dirs of every installed package (users-http, authz-http-admin, …).
    cfg.set(['system', 'dirs', 'controllers'], []);
    // Installed packages' defaults declare list permissions (configuration:read, team:read, group:read, …), and boot
    // rule 12 refuses them on the kit's test-domain models: they route every permission and cannot plan lists.
    for (const [name, def] of Object.entries(cfg.get(['authz', 'permissions']) ?? {})) {
        if (isRecord(def) && def.list === true)
            cfg.set(['authz', 'permissions', name, 'list'], false);
    }
    cfg.set(['fs', 'providers'], [
        ...((cfg.get(['fs', 'providers']) ?? []).filter((p) => p.name !== '__fs_controller_cache__')),
        { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(tmpdir(), 'spinajs-authz-http-test-cache') },
        { service: 'fsNative', name: 'authz-http-test', basePath: join(tmpdir(), 'spinajs-authz-http-test') },
    ]);
    cfg.set(['fs', 'defaultProvider'], 'authz-http-test');
    for (const [path, value] of Object.entries(opts.config ?? {}))
        cfg.set(path.split('.'), value);
    const before = new Set(DI.getRegisteredTypes(BaseController) ?? []);
    const controllers = [...(opts.controllers ?? [])];
    for (const c of controllers)
        DI.register(c).as(BaseController);
    await DI.resolve(fsService);
    await DI.resolve(Controllers);
    const server = (await DI.resolve(HttpServer));
    await server.start();
    const port = server.Server.address().port;
    // Also what http registered itself (the sources), so no controller outlives this app.
    app = { server, controllers: [...new Set(DI.getRegisteredTypes(BaseController) ?? [])].filter((t) => !before.has(t)), port };
    return { server, port, request: () => chai.request(`http://127.0.0.1:${port}`) };
}
/** Stops the server and removes what `startApp` added; never `DI.clearCache()`. */
export async function stopApp() {
    if (!app)
        return;
    const { server, controllers } = app;
    app = undefined;
    await server.stop();
    DI.uncache(HttpServer);
    DI.uncache(Controllers);
    for (const type of DI.getRegisteredTypes(BaseController) ?? [])
        DI.uncache(type);
    for (const c of controllers)
        DI.unregister(c);
    DI.uncache(BaseController);
    await DI.get(PrincipalMiddleware)?.dispose();
    // Middlewares keep what they resolved at boot (PrincipalMiddleware: the root AuthzService uninstallHost disposes).
    for (const type of DI.getRegisteredTypes(ServerMiddleware) ?? [])
        DI.uncache(type);
    DI.uncache(ServerMiddleware);
    // Root singletons that hold the AuthzDomains uninstallHost uncaches.
    for (const type of [AuthzInputFieldFilter, ArgInputFilter, AuthzFieldTransformer, DataTransformer, ExplainPolicy])
        DI.uncache(type);
    await testHost.uninstallHost();
}
//# sourceMappingURL=app.js.map