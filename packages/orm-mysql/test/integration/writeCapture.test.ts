/**
 * The ORM write capture against a live MySQL: the index list it reads an upsert's conflict keys from, ON DUPLICATE KEY
 * UPDATE and REPLACE, and the locking before read under REPEATABLE READ.
 *
 *   npx ts-mocha -p tsconfig.json test/integration/writeCapture.test.ts
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, InsertBehaviour, Model, ModelBase, Orm, Primary, QueryContext, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, QueryBuilder } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};
const DATABASE = `orm_capture_${randomUUID().slice(0, 8)}`;

@Connection('capture')
@Model('cap_member')
class CapMember extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

@Connection('capture')
@Model('cap_pair')
class CapPair extends ModelBase {
  @Primary()
  public Id: number;

  public Tenant: string;

  public Slug: string;

  public Name: string;
}

@Connection('capture')
@Model('cap_lower')
class CapLower extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

@Connection('capture')
@Model('cap_prefix')
class CapPrefix extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

const MODELS = [CapMember, CapPair, CapLower, CapPrefix];
const writes: CapturedWrite[] = [];

class Recorder extends WriteObserver {
  interest(query: QueryBuilder): CaptureInterest | undefined {
    return MODELS.some((m) => query.Model === m) ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    writes.push(write);
  }
}

class CaptureConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
    this.Config.db = { ...(this.Config.db as object), Migration: { Startup: false }, StrictTableCheck: false, DefaultConnection: 'capture', Connections: [{ Driver: 'orm-driver-mysql', Name: 'capture', ...SERVER, Database: DATABASE, Migration: { OnStartup: false } }] };
  }
}

const TABLES = [
  'CREATE TABLE cap_member (Id INT AUTO_INCREMENT PRIMARY KEY, Email VARCHAR(64) UNIQUE, Name VARCHAR(64))',
  'CREATE TABLE cap_pair (Id INT AUTO_INCREMENT PRIMARY KEY, Tenant VARCHAR(32), Slug VARCHAR(32), Name VARCHAR(64), UNIQUE KEY cap_pair_slug (Tenant, Slug))',
  'CREATE TABLE cap_lower (Id INT AUTO_INCREMENT PRIMARY KEY, Email VARCHAR(64), Name VARCHAR(64), UNIQUE KEY cap_lower_email ((lower(Email))))',
  'CREATE TABLE cap_prefix (Id INT AUTO_INCREMENT PRIMARY KEY, Email VARCHAR(64), Name VARCHAR(64), UNIQUE KEY cap_prefix_email (Email(4)))',
];

const SEED = [
  "INSERT INTO cap_member (Id, Email, Name) VALUES (1, 'a', 'one'), (2, 'x', 'two')",
  "INSERT INTO cap_pair (Id, Tenant, Slug, Name) VALUES (1, 't', 'a', 'one'), (2, 't', 'b', 'two')",
  "INSERT INTO cap_lower (Id, Email, Name) VALUES (1, 'a', 'one'), (2, 'x', 'two')",
  "INSERT INTO cap_prefix (Id, Email, Name) VALUES (1, 'abcd-one', 'one'), (2, 'wxyz-two', 'two')",
];

const driver = () => DI.get(Orm)!.Connections.get('capture')!;
const sql = async (statement: string): Promise<void> => {
  await driver().schema().raw(statement);
};

describe('write capture on mysql (integration)', function () {
  this.timeout(60000);

  let admin: MySqlOrmDriver;

  before(async () => {
    admin = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'capture-admin', Driver: 'orm-driver-mysql', ...SERVER, Database: 'mysql' }]);
    await admin.connect();
    await admin.schema().createDatabase(DATABASE);

    DI.clearCache();
    DI.register(CaptureConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    DI.register(Recorder).as(WriteObserver);
    await DI.resolve(Orm);
    for (const statement of TABLES) await sql(statement);
    await DI.get(Orm)!.reloadTableInfo();
  });

  beforeEach(async () => {
    for (const table of ['cap_member', 'cap_pair', 'cap_lower', 'cap_prefix']) await sql(`TRUNCATE TABLE ${table}`);
    for (const statement of SEED) await sql(statement);
    writes.length = 0;
  });

  after(async () => {
    await DI.get(Orm)?.Connections.get('capture')?.disconnect();
    DI.unregister(Recorder);
    DI.clearCache();
    await admin.executeOnDb(`DROP DATABASE IF EXISTS \`${DATABASE}\``, [], QueryContext.Schema);
    await admin.disconnect();
  });

  it('lists a composite unique index as it is, and marks a functional and a prefix one inexact', async () => {
    const index = async (table: string, name: string) => (await driver().tableIndexes!(table)).find((i) => i.name === name);

    expect(await index('cap_pair', 'cap_pair_slug')).to.deep.eq({ name: 'cap_pair_slug', columns: ['Tenant', 'Slug'], unique: true, primary: false });
    expect((await index('cap_lower', 'cap_lower_email'))?.inexact).to.eq(true);
    expect((await index('cap_prefix', 'cap_prefix_email'))?.inexact).to.eq(true);
  });

  it('reports the row ON DUPLICATE KEY UPDATE changes through a unique column as an update', async () => {
    await CapMember.insert({ Id: 5, Email: 'x', Name: 'new' }, InsertBehaviour.InsertOrUpdate);

    expect(writes[0].unknownKeys).to.eq(false);
    expect(writes[0].rows).to.deep.eq([{ id: '2', before: { Id: 2, Email: 'x', Name: 'two' }, after: { Id: 2, Email: 'x', Name: 'new' } }]);
  });

  it('reports the row REPLACE deletes through a unique column as gone, and the new row as inserted', async () => {
    await CapMember.insert({ Id: 5, Email: 'x', Name: 'new' }, InsertBehaviour.InsertOrReplace);

    expect(writes[0].rows).to.deep.eq([
      { id: '2', before: { Id: 2, Email: 'x', Name: 'two' }, after: undefined },
      { id: '5', before: undefined, after: { Id: 5, Email: 'x', Name: 'new' } },
    ]);
  });

  it('reports an upsert as unknown where a composite, functional or prefix unique index may decide its conflict', async () => {
    await CapPair.insert({ Tenant: 't', Slug: 'b', Name: 'new' }, InsertBehaviour.InsertOrUpdate);
    await CapLower.insert({ Id: 5, Email: 'X', Name: 'new' }, InsertBehaviour.InsertOrReplace);
    await CapPrefix.insert({ Id: 5, Email: 'wxyz-new', Name: 'new' }, InsertBehaviour.InsertOrReplace);

    expect(writes.map((w) => [w.unknownKeys, w.rows.length])).to.deep.eq([
      [true, 0],
      [true, 0],
      [true, 0],
    ]);
  });

  it("reads the before values the update overwrites, not the caller's REPEATABLE READ snapshot", async () => {
    const other = await mysql.createConnection({ host: SERVER.Host, port: SERVER.Port, user: SERVER.User, password: SERVER.Password, database: DATABASE });
    try {
      await driver().transaction(async () => {
        await driver().select().from('cap_member');
        await other.query("UPDATE cap_member SET Name = 'theirs' WHERE Id = 1");
        await CapMember.update({ Name: 'mine' }).where('Id', 1);
      });
    } finally {
      await other.end();
    }

    expect(writes[0].rows).to.deep.eq([{ id: '1', before: { Id: 1, Email: 'a', Name: 'theirs' }, after: { Id: 1, Email: 'a', Name: 'mine' } }]);
  });
});
