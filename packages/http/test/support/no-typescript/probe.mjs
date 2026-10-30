// Boots the built @spinajs/http in require mode, serves one request, and prints which modules imported typescript or glob.
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const imports = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(typescript|glob)(\/|$)/.test(specifier)) imports.push({ specifier, parent: context.parentURL ?? '' });
    return nextResolve(specifier, context);
  },
});

const { createTestApp, sourceRef, testManifest, withManifest } = await import('@spinajs/testing');
const { fsService } = await import('@spinajs/fs');
const { Controllers, HttpServer } = await import('@spinajs/http');

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

const app = await createTestApp({
  config: {
    system: { dirs: { controllers: [] } },
    fs: {
      defaultProvider: 'fs-temp',
      providers: [
        { service: 'fsNative', name: 'fs-temp', basePath: tmpdir() },
        { service: 'fsNative', name: '__fs_http_response_templates__', basePath: join(process.cwd(), 'src', 'views', 'responses') },
        // only the TypeScript cache writes here; registered so the base code fails on typescript, not on a missing provider
        { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(tmpdir(), 'spinajs-probe-controller-cache') },
      ],
    },
    logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
    http: { port: 0 },
  },
  register: withManifest(manifest, 'require'),
  resolve: [fsService, Controllers],
});

let body;
try {
  const server = await app.resolve(HttpServer);
  await server.start();
  const response = await fetch(`http://localhost:${server.Server.address().port}/probe/ping?value=ok`);
  body = await response.json();
} finally {
  await app.dispose();
}

const loaded = Object.keys(createRequire(import.meta.url).cache);
console.log(`<<JSON\n${JSON.stringify({ body, imports, loaded })}\nJSON>>`);
process.exit(0);
