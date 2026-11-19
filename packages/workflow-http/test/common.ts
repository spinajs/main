import { mkdirSync } from 'fs';
import os from 'os';
import { join, resolve } from 'path';
import chai from 'chai';
import chaiHttp from 'chai-http';
import chaiSubset from 'chai-subset';
import express from 'express';

import { DI } from '@spinajs/di';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { WorkflowService } from '@spinajs/workflow';

import { WorkflowInstancesController } from '../src/index.js';
import workflowHttpConfig from '../src/config/workflow-http.js';
import { FakeWorkflowService } from './fakes/fake-workflow.js';
import { appPort, startApp, stopApp } from './support/app.js';

export { TEST_USER_UUID } from './support/principals.js';

chai.use(chaiHttp);
chai.use(chaiSubset);

// a reused keep-alive socket can be reset by the server closing it at the same moment
const JSON_HEADERS = { Accept: 'application/json', Connection: 'close' };
const CACHE_DIR = join(os.tmpdir(), 'spinajs-workflow-http-cache');
mkdirSync(CACHE_DIR, { recursive: true });

// literal IPv4 loopback: dual-stack 'localhost' resolution flakes on some Windows machines
export function req() {
  return chai.request(`http://127.0.0.1:${appPort()}/`);
}

export function asRole(role: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...JSON_HEADERS, 'x-test-role': role, ...extra };
}

function config(): Record<string, unknown> {
  const permissions = Object.fromEntries(Object.entries(workflowHttpConfig.authz.permissions).map(([name, def]) => [`authz.permissions.${name}`, def]));
  return {
    'system.dirs': { controllers: [], workflows: [] },
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
    logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
    'http.cookie': { secret: 'workflow-http-test-secret' },
    'http.middlewares': [express.json({ limit: '5mb' }), express.urlencoded({ extended: true })],
    'http.AcceptHeaders': 1 | 2,
    'workflow.enabled': false,
    ...permissions,
    'db.DefaultConnection': 'default',
    'db.Connections': [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'default', Migration: { Table: 'orm_migrations', OnStartup: true } }],
    'db.Aliases': { workflow: 'default' },
  };
}

export async function bootHttp(): Promise<FakeWorkflowService> {
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  const fake = new FakeWorkflowService();
  fake.reset();
  DI.register(() => fake).as(WorkflowService);
  await startApp({ controllers: [WorkflowInstancesController], config: config() });
  return fake;
}

export async function stopHttp(): Promise<void> {
  await stopApp();
  DI.uncache(WorkflowService);
}
