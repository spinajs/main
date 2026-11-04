import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { AccessPolicy, PrincipalMiddleware } from '@spinajs/authz-http';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { BaseController, BasePolicy, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
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

/** Boots a real HTTP server on a free port, serving the given controllers with access allowed. */
export async function startApp(controllers: (typeof BaseController)[]): Promise<StartedApp> {
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
  const { port } = DI.get(HttpServer)!.Server.address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}
