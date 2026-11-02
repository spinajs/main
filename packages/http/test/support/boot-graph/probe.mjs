// Boots the built @spinajs/http in require mode, serves one request, and prints every bare package specifier
// resolved on the way, by `import` or `require`.
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (typeof nodeModule.registerHooks !== 'function') {
  console.log(`<<JSON\n${JSON.stringify({ unsupported: `module.registerHooks is missing in Node ${process.version}; this probe needs Node >= 22.15` })}\nJSON>>`);
  process.exit(0);
}

const packages = new Set();
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const bare = /^(@[^/]+\/[^/]+|[^./][^/:]*)(\/|$)/.exec(specifier);
    if (bare && !specifier.startsWith('node:')) {
      packages.add(bare[1]);
    }
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

const result = {};
try {
  const app = await createTestApp({
    config: {
      system: { dirs: { controllers: [] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          { service: 'fsNative', name: 'fs-temp', basePath: tmpdir() },
          { service: 'fsNative', name: '__fs_http_response_templates__', basePath: join(process.cwd(), 'src', 'views', 'responses') },
        ],
      },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      http: { port: 0 },
    },
    register: withManifest(manifest, 'require'),
    resolve: [fsService, Controllers],
  });
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

result.packages = [...packages].sort();
console.log(`<<JSON\n${JSON.stringify(result)}\nJSON>>`);
process.exit(0);
