// Boots the built @spinajs/http and @spinajs/http-swagger in require mode, builds the OpenAPI document, serves one
// request, and prints which modules imported typescript.
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (typeof nodeModule.registerHooks !== 'function') {
  console.log(`<<JSON\n${JSON.stringify({ unsupported: `module.registerHooks is missing in Node ${process.version}; this probe needs Node >= 22.15` })}\nJSON>>`);
  process.exit(0);
}

const imports = [];
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^typescript(\/|$)/.test(specifier)) imports.push({ specifier, parent: context.parentURL ?? '' });
    return nextResolve(specifier, context);
  },
});

const { createTestApp, sourceRef, testManifest, withManifest } = await import('@spinajs/testing');
const { fsService } = await import('@spinajs/fs');
const { Controllers, HttpServer } = await import('@spinajs/http');
const { SwaggerService } = await import('@spinajs/http-swagger');

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
          params: [{ index: 0, name: 'value', kind: 'FromQuery', runtimeType: { text: 'string' }, required: true, wire: { in: 'query', name: 'value', shape: 'value' } }],
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

const result = { imports };
try {
  const app = await createTestApp({
    config: {
      system: { dirs: { controllers: [] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          { service: 'fsNative', name: 'fs-temp', basePath: tmpdir() },
          { service: 'fsNative', name: '__fs_http_response_templates__', basePath: join(process.cwd(), '..', 'http', 'src', 'views', 'responses') },
        ],
      },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      http: { port: 0, swagger: { enabled: true, title: 'Probe', version: '1.0.0' } },
    },
    register: withManifest(manifest, 'require'),
    resolve: [fsService, Controllers],
  });
  try {
    const spec = await (await app.resolve(SwaggerService)).buildSpec();
    result.paths = Object.keys(spec.paths ?? {});
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
