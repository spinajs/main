import { mkdirSync } from 'fs';
import os from 'os';
import { join, resolve } from 'path';
import chai from 'chai';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import express from 'express';

import { DI } from '@spinajs/di';
import type { Class, Factory } from '@spinajs/di';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { SchedulerService } from '@spinajs/scheduler';

import { ErrorsController, MaintenanceController, RunsController, SchedulesController } from '../src/index.js';
import schedulerHttpConfig from '../src/config/scheduler-http.js';
import { FakeSchedulerService } from './fakes/fake-scheduler.js';
import { appPort, startApp, stopApp } from './support/app.js';

export { appPort } from './support/app.js';
export { TEST_USER_UUID } from './support/principals.js';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);

export const TEST_HEARTBEAT_MS = 200;
// a reused keep-alive socket can be reset by the server closing it at the same moment
export const JSON_HEADERS = { Accept: 'application/json', Connection: 'close' };

const CACHE_DIR = join(os.tmpdir(), 'spinajs-scheduler-http-cache');
mkdirSync(CACHE_DIR, { recursive: true });

// literal IPv4 loopback: dual-stack 'localhost' resolution flakes on some Windows machines
export function req() {
  return chai.request(`http://127.0.0.1:${appPort()}/`);
}

/** Headers of a request signed in as the test user holding `role` (see support/principals.ts). */
export function asRole(role: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...JSON_HEADERS, 'x-test-role': role, ...extra };
}

export interface IBootOptions {
  /** The `scheduler` section without `http`; default `{ enabled: false }`. */
  scheduler?: Record<string, unknown>;
  /** ORM connections next to the in-memory `default` one. */
  connections?: Array<Record<string, unknown>>;
  /** More configuration, dotted path to value, set last. */
  config?: Record<string, unknown>;
}

function config(opts: IBootOptions): Record<string, unknown> {
  const permissions = Object.fromEntries(Object.entries(schedulerHttpConfig.authz.permissions).map(([name, def]) => [`authz.permissions.${name}`, def]));

  return {
    // Replaced whole, as the package defaults list the model, migration and controller dirs of every installed
    // package: models and migrations come from the imported packages, controllers are registered by class.
    'system.dirs': { controllers: [], schedules: [] },
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
    'http.cookie': { secret: 'scheduler-http-test-secret' },
    'http.middlewares': [express.json({ limit: '5mb' }), express.urlencoded({ extended: true })],
    'http.AcceptHeaders': 1 | 2,
    'http.swagger': {
      enabled: true,
      title: 'scheduler-http test',
      version: '1.0.0',
      securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ssid' } },
      security: [{ cookieAuth: [] }],
    },
    scheduler: {
      ...(opts.scheduler ?? { enabled: false }),
      http: { sse: { heartbeat: TEST_HEARTBEAT_MS } },
    },
    ...permissions,
    'db.DefaultConnection': 'default',
    'db.Connections': [
      {
        Driver: 'orm-driver-sqlite',
        Filename: ':memory:',
        Name: 'default',
        Migration: { Table: 'orm_migrations', OnStartup: true },
      },
      ...(opts.connections ?? []),
    ],
    ...opts.config,
  };
}

let registered: Array<Class<unknown> | Factory<unknown>> = [];

async function boot(opts: IBootOptions, registerScheduler: () => void): Promise<void> {
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

  const before = new Set(DI.getRegisteredTypes(SchedulerService) ?? []);
  registerScheduler();
  registered = (DI.getRegisteredTypes(SchedulerService) ?? []).filter((t) => !before.has(t));

  await startApp({ controllers: [SchedulesController, RunsController, ErrorsController, MaintenanceController], config: config(opts) });
}

export async function bootHttp(): Promise<FakeSchedulerService> {
  const fake = new FakeSchedulerService();
  await boot({}, () => DI.register(() => fake).as(SchedulerService));
  return fake;
}

export async function bootRealHttp(opts: IBootOptions, registerScheduler: () => void): Promise<void> {
  await boot(opts, registerScheduler);
}

export async function stopHttp(): Promise<void> {
  await stopApp();

  // what the boot registered, so the next suite's SchedulerService is its own
  for (const type of registered) {
    DI.unregister(SchedulerService, type);
    DI.uncache(type as Class<unknown>);
  }
  registered = [];
  DI.uncache(SchedulerService);
}
