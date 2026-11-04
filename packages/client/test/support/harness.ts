import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessPolicy, PrincipalMiddleware } from '@spinajs/authz-http';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { BaseController, BasePolicy, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
import { hashManifest, type Manifest } from '@spinajs/manifest';
import { createTestApp, type TestApp } from '@spinajs/testing';
import shipped from '../../../http/lib/config/http.js';

// The fixture guards two routes with @Access; authorization is not what this suite checks. Importing the fixture
// also registers authz-http's PrincipalMiddleware, which stops the server when no authz domain boots.
export class AllowAccess extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

export class E2eConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const provider = (name: string) => ({ service: 'fsNative', name, basePath: tmpdir() });
    this.Config = {
      system: { dirs: { controllers: [] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [provider('fs-temp'), provider('__file_upload_default_provider__'), provider('__fs_http_templates__'), provider('__fs_controller_cache__'), provider('__fs_http_response_templates__')],
      },
      intl: { locales: ['en'], defaultLocale: 'en' },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      http: { port: 0, middlewares: shipped.http.middlewares, AcceptHeaders: 1 | 2 },
    };
  }
}

export interface StartedApp {
  app: TestApp;
  baseUrl: string;
}

const MANIFEST_ENV = ['SPINAJS_MANIFEST', 'SPINAJS_MANIFEST_MODE'] as const;

/**
 * Boots a real HTTP server on a free port, serving the given controllers with access allowed. With a manifest, the
 * app's configuration source loads it from `SPINAJS_MANIFEST` in `require` mode, as in production, so the server
 * validates request bodies against its derived schemas.
 */
export async function startApp(controllers: (typeof BaseController)[], manifest?: Manifest): Promise<StartedApp> {
  const saved = MANIFEST_ENV.map((name) => [name, process.env[name]] as const);
  const dir = manifest && mkdtempSync(join(tmpdir(), 'client-e2e-manifest-'));
  if (manifest && dir) {
    const file = join(dir, 'app.manifest.json');
    writeFileSync(file, JSON.stringify({ ...manifest, hash: hashManifest(manifest) }));
    process.env.SPINAJS_MANIFEST = file;
    process.env.SPINAJS_MANIFEST_MODE = 'require';
  }
  try {
    const app = await createTestApp({
      configuration: E2eConfiguration,
      register: (c) => {
        c.unregister(ServerMiddleware, PrincipalMiddleware);
        for (const controller of controllers) c.register(controller).as(BaseController);
        c.register(AllowAccess).as(AccessPolicy);
      },
      resolve: [fsService, Intl, Controllers],
      bootTimeout: 50000,
    });
    const server = await app.resolve(HttpServer);
    await server.start();
    const { port } = server.Server.address() as AddressInfo;
    return { app, baseUrl: `http://127.0.0.1:${port}` };
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
