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

// register model + migration ( @Model / @Migration side effects )
import { DbConfig } from '@spinajs/configuration-db-source';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

export const PORT = 9697;

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export function req() {
  return chai.request(`http://localhost:${PORT}/`);
}

/**
 * Bypasses both AuthorizedPolicy and RbacPolicy so we can test controller logic
 * in isolation. RBAC wiring itself is asserted via the ACL descriptor metadata.
 */
export class FakePolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }
  public execute(_req: sRequest): Promise<void> {
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
        grants: {
          guest: {},
          configuration: {
            configuration: {
              'read:any': ['*'],
              'update:any': ['*'],
            },
          },
          admin: {
            $extend: ['configuration'],
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

  await DbConfig.insert([
    row({ Slug: 'app.name', Group: 'app', Type: 'string', Value: 'spinajs', Default: 'spinajs', Label: 'App name', Description: 'application name', Required: 1 }),
    row({ Slug: 'app.maxUsers', Group: 'app', Type: 'int', Value: '10', Default: '5', Watch: 1, Meta: { min: 1, max: 100 } }),
    row({ Slug: 'app.debug', Group: 'app', Type: 'boolean', Value: '0', Default: '0' }),
    row({ Slug: 'app.theme', Group: 'app', Type: 'oneOf', Value: 'dark', Default: 'dark', Meta: { oneOf: ['dark', 'light'] } }),
    row({ Slug: 'app.features', Group: 'app', Type: 'manyOf', Value: JSON.stringify(['a', 'b']), Default: JSON.stringify([]), Meta: { manyOf: ['a', 'b', 'c'] } }),
    row({ Slug: 'app.startDate', Group: 'app', Type: 'date', Value: '01-01-2020', Default: '01-01-2020' }),
    row({ Slug: 'mail.from', Group: 'mail', Type: 'string', Value: 'noreply@spinajs.com', Default: 'noreply@spinajs.com' }),
  ]);
}
