import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import os from 'os';
import { join, normalize, resolve } from 'path';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import chaiLike from 'chai-like';
import chaiThings from 'chai-things';
import express from 'express';
import { BasePolicy, Request as sRequest } from '@spinajs/http';

// register models + migrations ( @Model / @Migration side effects )
import { DbConfig } from '@spinajs/configuration-db-source';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

// 9697 is unusable on at least one dev machine in this org: a bare Node http
// server bound to it refuses/times out virtually every connection (~310ms
// ETIMEDOUT), reproduced outside this test suite entirely - some local
// service/security software is holding onto that exact port. Not a code bug;
// picking a different port sidesteps it.
export const PORT = 19697;

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

// Use the literal IPv4 loopback address rather than 'localhost': Node's
// Happy-Eyeballs dual-stack resolution (racing ::1 and 127.0.0.1) adds enough
// jitter on some Windows dev machines to intermittently fail loopback
// connections; connecting by IP literal skips that resolution entirely.
export function req() {
  return chai.request(`http://127.0.0.1:${PORT}/`);
}

/**
 * Bypasses the route-level AuthorizedPolicy / RbacPolicy, but ( unlike a pure
 * no-op ) establishes an identity in request storage. Model-level RBAC - the
 * `RbacModelPermissionMiddleware` query middleware that guards the `configuration`
 * resource - is NOT a route policy and cannot be bypassed here, so requests must
 * carry a role that actually holds the grant.
 *
 * Defaults to `admin` ( which inherits configuration management ) and user id 1; a test can
 * send `x-test-role` / `x-test-user-id` headers to assume a different role or user.
 */
export class FakePolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }
  public execute(req: sRequest): Promise<void> {
    // RbacMiddleware ( a ServerMiddleware ) has already set a guest user; override
    // it here, after that global middleware and before the action runs.
    const role = (req.headers['x-test-role'] as string) ?? 'admin';
    const userId = Number((req.headers['x-test-user-id'] as string) ?? 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req.storage as any).User = { Role: [role], PrimaryKeyValue: userId };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req.storage as any).ActiveRole = role;
    return Promise.resolve();
  }
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      system: {
        dirs: {
          controllers: [dir('./../src/controllers')],
          schemas: [dir('./schemas')],
        },
      },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          { service: 'fsNative', name: 'fs-temp', basePath: os.tmpdir() },
          { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(os.tmpdir(), 'spinajs-cfg-http-cache') },
          { service: 'fsNative', name: '__fs_http_response_templates__', basePath: resolve(process.cwd(), '..', 'http', 'lib', 'views', 'responses') },
          { service: 'fsNative', name: '__fs_http_templates__', basePath: os.tmpdir() },
        ],
      },
      logger: {
        targets: [{ name: 'Empty', type: 'ConsoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      http: {
        port: PORT,
        cookie: {
          secret: 'cfg-http-test-secret',
        },
        middlewares: [
          express.json({ limit: '5mb' }),
          express.urlencoded({ extended: true }),
        ],
        AcceptHeaders: 1 | 2,
      },
      rbac: {
        defaultRole: 'guest',
        // mirrors the module's own grants ( @spinajs/configuration-http config ):
        // configuration management lives in an admin sub-role that admin inherits.
        grants: {
          guest: {},
          user: {},
          'admin.configuration': {
            configuration: {
              'read:any': ['*'],
              'update:any': ['*'],
            },
          },
          admin: {
            $extend: ['admin.configuration'],
          },
        },
      },
      db: {
        DefaultConnection: 'default',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'default',
            Migration: {
              Table: 'orm_migrations',
              OnStartup: true,
            },
          },
        ],
      },
    };
  }
}

/**
 * Seeds the configuration table with entries covering the value types the api
 * has to validate / serialize. Values are stored in their canonical db string
 * form, mirroring how configuration-db-source persists them.
 */
export async function seed() {
  // every row must share the same set of keys, otherwise the multi-row insert
  // emits `DEFAULT` placeholders which sqlite rejects in a VALUES list
  const row = (data: Record<string, unknown>) => ({
    Slug: '',
    Value: null as unknown,
    Default: null as unknown,
    Group: '',
    Label: null as unknown,
    Description: null as unknown,
    Meta: null as unknown,
    Required: 0,
    Exposed: 1,
    Watch: 0,
    Type: 'string',
    ...data,
  });

  // Values are seeded in their canonical stored (string) form; Meta is stored as
  // JSON text. Numbers use type 'number', dates use ISO, booleans 'true'/'false'.
  await DbConfig.insert([
    row({ Slug: 'app.name', Group: 'app', Type: 'string', Value: 'spinajs', Default: 'spinajs', Label: 'App name', Description: 'application name', Required: 1 }),
    row({ Slug: 'app.maxUsers', Group: 'app', Type: 'number', Value: '10', Default: '5', Watch: 1, Meta: { min: 1, max: 100 } }),
    row({ Slug: 'app.debug', Group: 'app', Type: 'boolean', Value: 'false', Default: 'false' }),
    row({ Slug: 'app.theme', Group: 'app', Type: 'oneOf', Value: 'dark', Default: 'dark', Meta: { oneOf: ['dark', 'light'] } }),
    row({ Slug: 'app.features', Group: 'app', Type: 'manyOf', Value: JSON.stringify(['a', 'b']), Default: JSON.stringify([]), Meta: { manyOf: ['a', 'b', 'c'] } }),
    row({ Slug: 'app.startDate', Group: 'app', Type: 'date', Value: '2020-01-01', Default: '2020-01-01' }),
    row({ Slug: 'app.ratio', Group: 'app', Type: 'float', Value: '0.5', Default: '0.5', Meta: { min: 0, max: 1 } }),
    row({ Slug: 'app.window', Group: 'app', Type: 'datetime-range', Value: '2020-01-01T00:00:00.000+00:00;2020-12-31T00:00:00.000+00:00', Default: '2020-01-01T00:00:00.000+00:00;2020-12-31T00:00:00.000+00:00' }),
    row({ Slug: 'app.limits', Group: 'app', Type: 'json', Value: JSON.stringify({ perPage: 20 }), Default: JSON.stringify({ perPage: 20 }) }),
    row({ Slug: 'app.broken', Group: 'app', Type: 'string', Value: 'x', Default: 'x' }),
    row({ Slug: 'mail.from', Group: 'mail', Type: 'string', Value: 'noreply@spinajs.com', Default: 'noreply@spinajs.com' }),
  ]);
}
