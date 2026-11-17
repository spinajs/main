import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { join, normalize, resolve } from 'node:path';
import chai from 'chai';
import chaiHttp from 'chai-http';
import '@spinajs/audit/testing';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { BaseController, Controllers, HttpServer, defaultMiddlewares } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { AUDIT_HTTP_CONFIGURATION_SCHEMA } from '../../src/schema.js';

chai.use(chaiHttp);

const httpSrc = (path: string): string => resolve(normalize(join(process.cwd(), '..', 'http', 'src', path)));
const scratch = (path: string): string => join(os.tmpdir(), 'spinajs-audit-http', path);

export interface AuditAppOptions {
  readonly audit: Record<string, unknown>;
  /** Laid over the http section, for example `{ routes: { middlewares: ['Audit'] } }`. */
  readonly http?: Record<string, unknown>;
  /** More top-level sections, for example `idempotency`. */
  readonly sections?: Record<string, unknown>;
  readonly controllers: readonly Class<BaseController>[];
  /** `child` boots the server in a child container of the root. */
  readonly scope?: 'root' | 'child';
}

// Replaces the loaded configuration instead of merging into it: every @spinajs package in node_modules ships a config,
// and merging would scan all their controllers too.
function configurationOf(options: AuditAppOptions): Class<FrameworkConfiguration> {
  return class extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      this.Config = {
        system: { dirs: { locales: [httpSrc('locales')], controllers: [] } },
        fs: {
          defaultProvider: 'fs-temp',
          providers: [
            { service: 'fsNative', name: 'fs-temp', basePath: scratch('files') },
            { service: 'fsNative', name: '__file_upload_default_provider__', basePath: os.tmpdir() },
            { service: 'fsNative', name: '__fs_http_response_templates__', basePath: httpSrc('views/responses') },
            { service: 'fsNative', name: '__fs_controller_cache__', basePath: scratch('controllers') },
          ],
        },
        intl: { locales: ['en'], defaultLocale: 'en' },
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        http: {
          port: 0,
          cookie: { secret: 'test-cookie-secret' },
          middlewares: defaultMiddlewares(),
          Files: { MaxSize: 1024 * 1024, BasePath: scratch('uploads') },
          Static: [],
          AcceptHeaders: 1 | 2,
          FatalTemplate: '<html><body>{ticket}</body></html>',
          ...options.http,
        },
        audit: options.audit,
        ...options.sections,
      };
      // The boot check ran on the loaded configuration, so audit.http is checked here as the boot would check it.
      this.validateModule(AUDIT_HTTP_CONFIGURATION_SCHEMA);
    }
  };
}

let current: TestApp | undefined;

/** Boots a server on a free port with `controllers` and the given `audit` section. Dispose it in `after`. */
export async function auditApp(options: AuditAppOptions): Promise<TestApp> {
  const app = await createTestApp({
    scope: options.scope,
    configuration: configurationOf(options),
    register: (container) => {
      for (const controller of options.controllers) container.register(controller).as(BaseController);
    },
    // The fs bootstrapper's provider factory throws unless fsService was resolved first.
    resolve: [fsService, Intl, Controllers],
  });

  try {
    await (await app.resolve(HttpServer)).start();
  } catch (error) {
    await app.dispose();
    throw error;
  }
  return (current = app);
}

/** The message of the error that stops an app with these options from booting. */
export async function bootFailure(options: AuditAppOptions): Promise<string> {
  let app: TestApp | undefined;
  try {
    app = await auditApp(options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await app?.dispose();
  }
  throw new Error('the app booted');
}

export function appPort(): number {
  const address = (current?.container ?? DI.RootContainer).get(HttpServer)?.Server?.address() as AddressInfo | null | undefined;
  if (!address) throw new Error('no http server listening: call auditApp() first');
  return address.port;
}

export const req = () => chai.request(`http://localhost:${appPort()}/`);
