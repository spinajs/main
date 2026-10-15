import { mkdirSync } from 'fs';
import os from 'os';
import { join, normalize, resolve } from 'path';
import chai from 'chai';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import express from 'express';

import { Bootstrapper, Constructor, DI, Injectable } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { Controllers, HttpServer, Request as sRequest, ServerMiddleware } from '@spinajs/http';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import type { ISession, User } from '@spinajs/rbac';
// RbacMiddleware, policies and the request storage typings
import '@spinajs/rbac-http';
import { SchedulerService } from '@spinajs/scheduler';

import '../src/index.js';
import { FakeSchedulerService } from './fakes/fake-scheduler.js';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);

export const PORT = 19731;
export const TEST_USER_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
export const TEST_HEARTBEAT_MS = 200;
// a reused keep-alive socket can be reset by the server closing it at the same moment
export const JSON_HEADERS = { Accept: 'application/json', Connection: 'close' };

const CACHE_DIR = join(os.tmpdir(), 'spinajs-scheduler-http-cache');
mkdirSync(CACHE_DIR, { recursive: true });

export const GRANTS = {
  guest: {},
  nobody: {},
  'scheduler-reader': { scheduler: { 'read:any': ['*'] } },
  'scheduler-operator': { scheduler: { 'read:any': ['*'], 'update:any': ['*'] } },
  'scheduler-admin': { scheduler: { 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] } },
};

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

// literal IPv4 loopback: dual-stack 'localhost' resolution flakes on some Windows machines
export function req() {
  return chai.request(`http://127.0.0.1:${PORT}/`);
}

export function asRole(role: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...JSON_HEADERS, 'x-test-role': role, ...extra };
}

/**
 * Stands in for a logged-in session: `x-test-role` makes the request an authorized user with
 * that single role, `x-test-token` also marks it as an api-token request. Runs after
 * RbacMiddleware ( Order 0 ), which has set a guest by then.
 */
@Injectable(ServerMiddleware)
export class TestIdentityMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 10;
  }

  public before() {
    return (req: sRequest, _res: express.Response, next: express.NextFunction) => {
      const role = req.headers['x-test-role'] as string | undefined;
      const token = req.headers['x-test-token'] as string | undefined;

      if (role) {
        req.storage.User = { Id: 7, Uuid: TEST_USER_UUID, Login: 'tester', Email: 'tester@spinajs.pl', Role: [role] } as unknown as User;
        req.storage.Session = { Data: new Map<string, unknown>([['Authorized', true]]) } as unknown as ISession;
        req.storage.ActiveRole = undefined;
      }

      if (token) {
        (req.storage as unknown as { TokenAuth?: { Uuid: string } }).TokenAuth = { Uuid: token };
      }

      next();
    };
  }

  public after(): null {
    return null;
  }
}

export class TestConfiguration extends FrameworkConfiguration {
  protected schedulerSection(): Record<string, unknown> {
    return { enabled: false };
  }

  /** Extra ORM connections; the real-service suite adds the `queue` connection the core needs. */
  protected extraConnections(): Array<Record<string, unknown>> {
    return [];
  }

  /** Extra top-level sections ( e.g. `queue` ); this config replaces package defaults, so they are not merged in. */
  protected extraSections(): Record<string, unknown> {
    return {};
  }

  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      ...this.extraSections(),
      system: {
        dirs: {
          controllers: [dir('./../src/controllers')],
          schedules: [],
        },
      },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          { service: 'fsNative', name: 'fs-temp', basePath: os.tmpdir() },
          { service: 'fsNative', name: '__file_upload_default_provider__', basePath: os.tmpdir() },
          { service: 'fsNative', name: '__fs_controller_cache__', basePath: CACHE_DIR },
          { service: 'fsNative', name: '__fs_swagger_cache__', basePath: CACHE_DIR },
          { service: 'fsNative', name: '__fs_http_response_templates__', basePath: resolve(process.cwd(), '..', 'http', 'src', 'views', 'responses') },
          { service: 'fsNative', name: '__fs_http_templates__', basePath: os.tmpdir() },
        ],
      },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      http: {
        port: PORT,
        cookie: { secret: 'scheduler-http-test-secret' },
        middlewares: [express.json({ limit: '5mb' }), express.urlencoded({ extended: true })],
        AcceptHeaders: 1 | 2,
        swagger: {
          enabled: true,
          title: 'scheduler-http test',
          version: '1.0.0',
          securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ssid' } },
          security: [{ cookieAuth: [] }],
        },
      },
      scheduler: {
        ...this.schedulerSection(),
        http: { sse: { heartbeat: TEST_HEARTBEAT_MS } },
      },
      rbac: {
        defaultRole: 'guest',
        grants: GRANTS,
      },
      db: {
        DefaultConnection: 'default',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'default',
            Migration: { Table: 'orm_migrations', OnStartup: true },
          },
          ...this.extraConnections(),
        ],
      },
    };
  }
}

const PRESERVED_DI_ENTRIES = ['__http_error_map__', '__schemas__'];

/**
 * DI.clearCache() also drops the registries that @HandleException and the response-schema
 * module fill once at import time, after which mapped errors silently become 500s.
 */
export function resetDi(): void {
  const saved = PRESERVED_DI_ENTRIES.map((key) => [key, DI.get(key)] as const);
  DI.clearCache();

  for (const [key, value] of saved) {
    if (value) {
      DI.RootContainer.Cache.add(key, value);
    }
  }
}

async function boot(configuration: Constructor<FrameworkConfiguration>, registerScheduler: () => void): Promise<void> {
  resetDi();

  const fsBootstrapper = await DI.resolve(FsBootsrapper);
  fsBootstrapper.bootstrap();

  DI.setESMModuleSupport();
  DI.register(configuration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  registerScheduler();

  const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
  for (const b of bootstrappers) {
    await b.bootstrap();
  }

  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Orm);
  await DI.resolve(Controllers);

  const server = await DI.resolve(HttpServer);
  await server.start();
}

let fakeFactory: (() => FakeSchedulerService) | null = null;

export async function bootHttp(): Promise<FakeSchedulerService> {
  const fake = new FakeSchedulerService();
  fakeFactory = () => fake;
  await boot(TestConfiguration, () => DI.register(fakeFactory!).as(SchedulerService));
  return fake;
}

/**
 * The registry keeps a class once, so registering DefaultSchedulerService again would not move it
 * after the fake factories of earlier suites, and the last factory would still win.
 */
function unregisterFake(): void {
  const types = DI.RootContainer.Registry.getTypes(SchedulerService);
  const index = fakeFactory && types ? types.indexOf(fakeFactory) : -1;
  if (index >= 0) {
    types.splice(index, 1);
  }
  fakeFactory = null;
}

export async function bootRealHttp(configuration: Constructor<FrameworkConfiguration>, registerScheduler: () => void): Promise<void> {
  await boot(configuration, registerScheduler);
}

export async function stopHttp(): Promise<void> {
  const server = DI.get(HttpServer);
  await server?.stop();
  unregisterFake();

  const orm = DI.get(Orm);
  if (orm) {
    await orm.dispose();
    DI.uncache(Orm);
  }
}
