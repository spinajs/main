import '@spinajs/fs';
import '@spinajs/hooks';
import '@spinajs/orm-sqlite';
import '@spinajs/queue';
import './strict-fs.js';

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import { FILE_PROVIDER_INSTANCES, fsService } from '@spinajs/fs';
import type { fs } from '@spinajs/fs';
import { Orm, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { QueueService } from '@spinajs/queue';
import { DateTime } from 'luxon';

import { Upload_2026_10_23_00_00_00, UploadStore } from '../../src/index.js';
import { CaptureLogTarget, CaptureQueueClient } from './capture.js';
import { TEST_ROOT, bootConfiguration } from './config.js';
import { StrictFs } from './strict-fs.js';

export { TEST_ROOT };

export interface UploadEnv {
  readonly orm: Orm;
  readonly driver: OrmDriver;
  readonly store: UploadStore;
}

let opened: Promise<UploadEnv> | undefined;

async function open(): Promise<UploadEnv> {
  await bootConfiguration();
  await DI.resolve(fsService);
  const orm = await DI.resolve(Orm);
  const driver = orm.Connections.get('default');
  if (!driver) throw new Error('upload test db: no connection default');
  await new Upload_2026_10_23_00_00_00().up(driver);
  // The Orm read the table info before the tables existed.
  await orm.reloadTableInfo();
  CaptureQueueClient.Probe = () => driver.CurrentTransaction !== undefined;
  return { orm, driver, store: await DI.resolve(UploadStore) };
}

/** One in-memory database and one pair of providers per mocha process, shared by every test file. */
export function uploadEnv(): Promise<UploadEnv> {
  return (opened ??= open());
}

export async function resetUploads(): Promise<void> {
  const { driver } = await uploadEnv();
  // The WHERE keeps the delete builder from refusing an unbounded DELETE (orm/src/builders.ts:2034-2038).
  await driver.del().from('upload_blobs').where('id', '!=', '');
  await driver.del().from('upload_parts').where('session_id', '!=', '');
  await driver.del().from('upload_sessions').where('id', '!=', '');
  for (const dir of ['temp', 'files']) rmSync(join(TEST_ROOT, dir, 'uploads'), { recursive: true, force: true });
  CaptureQueueClient.reset();
  CaptureLogTarget.reset();
  StrictFs.Banned.length = 0;
}

export async function rows(table: string, where: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
  const { driver } = await uploadEnv();
  const query = driver.select().from(table);
  return (await (Object.keys(where).length > 0 ? query.where(where) : query)) as Record<string, unknown>[];
}

export async function raw(sql: string): Promise<Record<string, unknown>[]> {
  const { driver } = await uploadEnv();
  return (await (driver as unknown as { executeOnDb(s: string, b: unknown[], c: QueryContext): Promise<unknown> }).executeOnDb(sql, [], QueryContext.Select)) as Record<string, unknown>[];
}

/** A session row as the service would write it: a 10-byte notes.txt in parts of 4 bytes. `values` overrides any column. */
export async function insertSessionRow(values: Record<string, unknown> = {}): Promise<string> {
  const { driver } = await uploadEnv();
  const now = DateTime.utc();
  const id = typeof values.id === 'string' ? values.id : randomUUID();
  const { metadata, ...rest } = values;
  await driver
    .insert()
    .into('upload_sessions')
    .values({
      id,
      owner: null,
      name: 'notes.txt',
      size: 10,
      part_size: 4,
      part_count: 3,
      declared_mime: 'text/plain',
      status: 'open',
      temp_fs: 'upload-temp',
      files_fs: 'upload-files',
      created_at: now,
      updated_at: now,
      expires_at: now.plus({ hours: 24 }),
      ...rest,
      metadata: JSON.stringify(metadata ?? {}),
    });
  return id;
}

export async function setSession(id: string, values: Record<string, unknown>): Promise<void> {
  const { driver } = await uploadEnv();
  await driver.update().in('upload_sessions').update(values).where('id', id);
}

/** Where a key of a test provider is on disk. */
export const pathIn = (provider: 'temp' | 'files', key: string): string => join(TEST_ROOT, provider, key);

/** Entries of a directory of a test provider, read with node:fs (the providers refuse list). */
export function objectsOf(provider: 'temp' | 'files', dir: string): string[] {
  const path = join(TEST_ROOT, provider, dir);
  return existsSync(path) ? readdirSync(path) : [];
}

// A root hook: it runs once, after every test file.
after(async function () {
  this.timeout(60000);
  if (!opened) return;
  const env = await opened;
  opened = undefined;
  await (await DI.resolve(QueueService)).dispose();
  // Package configs add fsTemp providers with cleanup timers (fs-s3/src/config/fs-s3.ts:16-26); disposing stops them.
  for (const provider of DI.get<Map<string, fs>>(FILE_PROVIDER_INSTANCES)?.values() ?? []) await provider.dispose();
  await env.orm.dispose();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});
