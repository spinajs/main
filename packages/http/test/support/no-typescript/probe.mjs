// Boots the built @spinajs/http, serves one request, and prints which modules imported typescript or glob.
//   probe.mjs                                   require mode, ProbeController listed in the manifest
//   probe.mjs off <cache dir> [no-typescript]   off mode, ProbeController registered in DI, its parameter names from the
//                                               controller cache in <cache dir>; `no-typescript` makes typescript unresolvable
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [mode = 'require', controllerCache = tmpdir(), typescript] = process.argv.slice(2);
const withoutTypescript = typescript === 'no-typescript';

if (typeof nodeModule.registerHooks !== 'function') {
  console.log(`<<JSON\n${JSON.stringify({ unsupported: `module.registerHooks is missing in Node ${process.version}; this probe needs Node >= 22.15` })}\nJSON>>`);
  process.exit(0);
}

const imports = [];
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(typescript|glob)(\/|$)/.test(specifier)) {
      imports.push({ specifier, parent: context.parentURL ?? '' });
      if (withoutTypescript && specifier.startsWith('typescript')) {
        throw Object.assign(new Error(`Cannot find package '${specifier}' imported from ${context.parentURL}`), { code: 'ERR_MODULE_NOT_FOUND' });
      }
    }
    return nextResolve(specifier, context);
  },
});

const { createTestApp, sourceRef, testManifest, withManifest } = await import('@spinajs/testing');
const { fsService } = await import('@spinajs/fs');
const { BaseController, Controllers, HttpServer } = await import('@spinajs/http');

const source = sourceRef('test/support/no-typescript/ProbeController.mjs');
const manifest = testManifest({
  root: process.cwd(),
  controllers: [
    {
      id: 'test-app:ProbeController',
      className: 'ProbeController',
      basePath: 'probe',
      mountPath: 'probe',
      policies: [],
      middlewares: [],
      routes: [
        {
          method: 'get',
          path: 'ping',
          handler: 'ping',
          fullPath: '/probe/ping',
          params: [{ index: 0, name: 'value', kind: 'FromQuery', runtimeType: { text: 'string' }, required: true }],
          returnType: { text: 'Ok' },
          policies: [],
          middlewares: [],
          source,
        },
      ],
      source,
    },
  ],
});

async function boot() {
  const register =
    mode === 'off'
      ? async (container) => {
          const { ProbeController } = await import('./ProbeController.mjs');
          container.register(ProbeController).as(BaseController);
        }
      : withManifest(manifest, 'require');

  return createTestApp({
    config: {
      system: { dirs: { controllers: [] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          { service: 'fsNative', name: 'fs-temp', basePath: tmpdir() },
          { service: 'fsNative', name: '__fs_http_response_templates__', basePath: join(process.cwd(), 'src', 'views', 'responses') },
          { service: 'fsNative', name: '__fs_controller_cache__', basePath: controllerCache },
        ],
      },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      http: { port: 0 },
    },
    register,
    resolve: [fsService, Controllers],
  });
}

const result = { imports };
try {
  const app = await boot();
  try {
    const server = await app.resolve(HttpServer);
    await server.start();
    const response = await fetch(`http://localhost:${server.Server.address().port}/probe/ping?value=ok`);
    result.body = await response.json();
  } finally {
    await app.dispose();
  }
} catch (err) {
  result.error = { name: err?.constructor?.name, message: String(err?.message) };
}

console.log(`<<JSON\n${JSON.stringify(result)}\nJSON>>`);
process.exit(0);
