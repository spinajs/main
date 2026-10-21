import * as chai from 'chai';
import 'mocha';

import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, QueryContext, extractMigrationDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { AuthzFsAclPathIndex_2026_10_21_00_00_00, AuthzFsAcl_2026_10_17_00_00_00 } from '../src/index.js';
import { FakeConfiguration } from './helpers.js';
import { installQuietLog } from './support/log.js';

const expect = chai.expect;

const sqlite = (name: string) => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: name, Migration: { Table: 'orm_migrations', OnStartup: false } });

const rows = (driver: OrmDriver, sql: string): Promise<Record<string, unknown>[]> => (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<Record<string, unknown>[]> }).executeOnDb(sql, [], QueryContext.Select);

/** Each index name with its columns in key order, from the SQLite pragmas. */
async function indexesOf(driver: OrmDriver, table: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const { name } of await rows(driver, `PRAGMA index_list('${table}')`)) {
    const info = await rows(driver, `PRAGMA index_info('${name as string}')`);
    out[name as string] = info.sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((c) => c.name as string);
  }
  return out;
}

describe('fs_acl (fs, path) index', function () {
  this.timeout(30000);

  let orm: Orm | undefined;
  let db: OrmDriver;
  let config: Configuration;
  let undoLog: (() => void) | undefined;

  before(async () => {
    undoLog = installQuietLog();
    DI.register(FakeConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    config = await DI.resolve(Configuration);
    config.set(['db'], { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite'), sqlite('other')] });
    orm = await DI.resolve(Orm);
    db = orm.Connections.get('default')!;
    await new AuthzFsAcl_2026_10_17_00_00_00().up(db);
    await new AuthzFsAclPathIndex_2026_10_21_00_00_00().up(db);
  });

  after(async () => {
    for (const c of new Set(orm?.Connections.values() ?? [])) await c.disconnect().catch(() => undefined);
    DI.uncache(Orm);
    DI.uncache(Configuration);
    DI.unregister(FakeConfiguration);
    DI.unregister(SqliteOrmDriver);
    undoLog?.();
  });

  beforeEach(() => {
    config.set(['authz', 'fsAcl'], undefined);
  });

  it('indexes fs_acl on (fs, path), for the prefix reads of tree()', async () => {
    const indexes = await indexesOf(db, 'fs_acl');

    expect(Object.values(indexes)).to.deep.include(['fs', 'path']);
  });

  it('keeps the unique key and the path_hash index of the first migration', async () => {
    const indexes = await indexesOf(db, 'fs_acl');

    expect(indexes.fs_acl_uq).to.deep.equal(['fs', 'path_hash', 'subject_key', 'relation']);
    expect(indexes.fs_acl_path).to.deep.equal(['fs', 'path_hash', 'relation']);
  });

  it('is a non-unique index: it must not refuse rows the unique key allows', async () => {
    const list = await rows(db, "PRAGMA index_list('fs_acl')");
    const index = list.find((i) => i.name === 'fs_acl_fs_path');

    expect(index, 'fs_acl_fs_path').to.not.equal(undefined);
    expect(index!.unique).to.equal(0);
  });

  it('registers through @Migration on the connection authz.fsAcl.connection names', () => {
    expect(orm!.Migrations.map((m) => m.name)).to.include(AuthzFsAclPathIndex_2026_10_21_00_00_00.name);
    expect(extractMigrationDescriptor(AuthzFsAclPathIndex_2026_10_21_00_00_00)?.Connection).to.equal('default');
    config.set(['authz', 'fsAcl', 'connection'], 'other');
    expect(extractMigrationDescriptor(AuthzFsAclPathIndex_2026_10_21_00_00_00)?.Connection).to.equal('other');
  });

  it('down drops only its own index', async () => {
    const other = orm!.Connections.get('other')!;
    await new AuthzFsAcl_2026_10_17_00_00_00().up(other);
    const migration = new AuthzFsAclPathIndex_2026_10_21_00_00_00();
    await migration.up(other);

    await migration.down(other);

    const indexes = await indexesOf(other, 'fs_acl');
    expect(Object.values(indexes)).to.not.deep.include(['fs', 'path']);
    expect(Object.keys(indexes)).to.include.members(['fs_acl_uq', 'fs_acl_path']);
  });
});
