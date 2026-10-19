import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, QueryContext, extractMigrationDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { AuthzFsAcl_2026_10_17_00_00_00, FileAclStore, OrmFileAclStore } from '../src/index.js';
import { aclPathHash } from '../src/acl/shared.js';
import { FakeConfiguration } from './helpers.js';
import { ALICE, BOB, aclStoreContract } from './support/acl-contract.js';
import { installQuietLog } from './support/log.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

type DbKind = 'sqlite' | 'postgres' | 'mysql';

/** Runs plain SQL; executeOnDb lives on the SQL drivers, not on OrmDriver. */
const rawSql = (driver: OrmDriver, sql: string): Promise<unknown> => (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<unknown> }).executeOnDb(sql, [], QueryContext.Schema);

const PG = { Host: '127.0.0.1', Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432), User: 'postgres', Password: 'postgres' };
const MYSQL = { Host: '127.0.0.1', Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306), User: 'root', Password: 'root' };

/** A throwaway database on the orm packages' test containers, dropped afterwards. */
async function externalDb(kind: 'postgres' | 'mysql'): Promise<{ connection: Record<string, unknown>; drop(): Promise<void> }> {
  const name = `authz_fs_${randomUUID().slice(0, 8)}`;
  const type = kind === 'postgres' ? (await import('@spinajs/orm-postgres')).PostgresOrmDriver : (await import('@spinajs/orm-mysql')).MySqlOrmDriver;
  const server = kind === 'postgres' ? { ...PG, Database: 'postgres' } : { ...MYSQL, Database: 'mysql' };
  const admin = async (): Promise<OrmDriver> => {
    const driver = (await DI.child().resolve(type as never, [{ Name: `authz-fs-${kind}-admin`, Driver: `orm-driver-${kind}`, ...server }])) as OrmDriver;
    await driver.connect();
    return driver;
  };
  const a = await admin();
  try {
    await a.schema().createDatabase(name);
  } finally {
    await a.disconnect();
  }
  const quoted = kind === 'postgres' ? `"${name}"` : `\`${name}\``;
  return {
    connection: { Driver: `orm-driver-${kind}`, Name: kind, ...server, Database: name, Migration: { Table: 'orm_migrations', OnStartup: false } },
    async drop() {
      const d = await admin();
      try {
        await rawSql(d, `DROP DATABASE IF EXISTS ${quoted}${kind === 'postgres' ? ' WITH (FORCE)' : ''}`);
      } finally {
        await d.disconnect();
      }
    },
  };
}

/** OrmFileAclStore on SQLite always; on Postgres or MySQL when AUTHZ_FS_DB names them (AUTHZ_FS_DB=postgres,mysql). */
function ormSuite(kind: DbKind): void {
  describe(`authz-fs OrmFileAclStore on ${kind}`, function () {
    this.timeout(60000);

    let orm: Orm | undefined;
    let db: OrmDriver;
    let config: Configuration;
    let undoLog: (() => void) | undefined;
    let drop: (() => Promise<void>) | undefined;
    const store = new OrmFileAclStore();
    const sqliteOnly = (ctx: Mocha.Context): void => {
      if (kind !== 'sqlite') ctx.skip();
    };

    before(async () => {
      undoLog = installQuietLog();
      // Not on startup: every migration this process imports would run; the suite runs fs_acl's alone.
      const sqlite = (name: string) => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: name, Migration: { Table: 'orm_migrations', OnStartup: false } });
      let main: Record<string, unknown> = sqlite('sqlite');
      if (kind !== 'sqlite') {
        const external = await externalDb(kind);
        main = external.connection;
        drop = external.drop;
      }
      DI.register(FakeConfiguration).as(Configuration);
      DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
      config = (await DI.resolve(Configuration)) as Configuration;
      config.set(['db'], { DefaultConnection: main.Name, Connections: [main, sqlite('other'), sqlite('nocase')] });
      orm = (await DI.resolve(Orm)) as Orm;
      db = orm.Connections.get('default')!;
      await new AuthzFsAcl_2026_10_17_00_00_00().up(db);
    });

    after(async () => {
      // A before() that failed half-way may leave a cached Orm with open connections, which keep mocha alive.
      const opened = orm ?? (DI.RootContainer.Cache.has(Orm) ? (DI.get(Orm) as Orm | undefined) : undefined);
      for (const c of new Set(opened?.Connections.values() ?? [])) await c.disconnect().catch(() => undefined);
      DI.uncache(Orm);
      DI.uncache(Configuration);
      DI.unregister(FakeConfiguration);
      DI.unregister(SqliteOrmDriver);
      await drop?.();
      undoLog?.();
    });

    beforeEach(() => {
      config.set(['authz', 'fsAcl'], undefined);
    });

    describe('contract', () => {
      aclStoreContract(() => store);
    });

    it('is registered under FileAclStore', () => {
      expect(DI.RootContainer.getRegisteredTypes(FileAclStore)).to.include(OrmFileAclStore);
    });

    it('the migration registers through @Migration and creates fs_acl (design §3.1)', async () => {
      expect(orm!.Migrations.map((m) => m.name)).to.include(AuthzFsAcl_2026_10_17_00_00_00.name);
      const info = await db.tableInfo('fs_acl');
      expect(info.map((c) => c.Name).sort()).to.deep.equal(['created_at', 'expires_at', 'fs', 'granted_by', 'id', 'path', 'path_hash', 'relation', 'subject_key']);
      expect(info.filter((c) => c.PrimaryKey).map((c) => c.Name)).to.deep.equal(['id']);
    });

    it('the migration runs on the connection the store uses, authz.fsAcl.connection', () => {
      expect(extractMigrationDescriptor(AuthzFsAcl_2026_10_17_00_00_00)?.Connection).to.equal('default');
      config.set(['authz', 'fsAcl', 'connection'], 'other');
      expect(extractMigrationDescriptor(AuthzFsAcl_2026_10_17_00_00_00)?.Connection).to.equal('other');
    });

    it('keeps case variants of a path apart: Report.pdf and report.pdf are two files', async () => {
      const fs = `case-${randomUUID().slice(0, 8)}`;
      await store.setOwnerIfAbsent(fs, 'Report.pdf', ALICE);
      await store.setOwnerIfAbsent(fs, 'report.pdf', BOB);
      expect(await store.ownerOf(fs, 'Report.pdf')).to.deep.equal(ALICE);
      expect(await store.ownerOf(fs, 'report.pdf')).to.deep.equal(BOB);
      await store.deleteTree(fs, 'report.pdf');
      expect(await store.ownerOf(fs, 'Report.pdf')).to.deep.equal(ALICE);
    });

    it('writes one row per grant with the subject key the rbac stores use', async () => {
      const fs = `rows-${randomUUID().slice(0, 8)}`;
      await store.grant({ fs, path: 'a.txt', subject: { set: { role: 'team.member', scope: { type: 'team', id: 't1' } } }, relation: 'viewer', grantedBy: 'user:root' });
      await store.grant({ fs, path: 'a.txt', subject: { set: { role: 'team.member', scope: { type: 'team', id: 't1' } } }, relation: 'viewer' });
      const rows = (await db.select().from('fs_acl').where({ fs })) as Record<string, unknown>[];
      expect(rows).to.have.length(1);
      expect(rows[0]).to.deep.include({ fs, path: 'a.txt', path_hash: aclPathHash('a.txt'), subject_key: 'team:t1#team.member', relation: 'viewer', granted_by: null });
      expect(rows[0].id).to.be.a('string').with.length(36);
    });

    it('moveTree rewrites path_hash with path', async () => {
      const fs = `hash-${randomUUID().slice(0, 8)}`;
      await store.grant({ fs, path: 'm/a.txt', subject: ALICE, relation: 'viewer' });
      await store.moveTree(fs, 'm', fs, 'n');
      const rows = (await db.select().from('fs_acl').where({ fs })) as Record<string, unknown>[];
      expect(rows.map((r) => [r.path, r.path_hash])).to.deep.equal([['n/a.txt', aclPathHash('n/a.txt')]]);
    });

    // Decision 1: the key is (fs, path_hash, subject_key, relation), short enough for InnoDB's 3072-byte limit.
    it('the unique index refuses a second equal row written around the store, on every driver', async () => {
      const uq = `uq-${randomUUID().slice(0, 8)}`;
      const row = (id: string) => ({ id, fs: uq, path: 'a.txt', path_hash: aclPathHash('a.txt'), subject_key: 'user:alice', relation: 'viewer', created_at: new Date() });
      await db.insert().into('fs_acl').values(row(randomUUID()));
      await expect(db.insert().into('fs_acl').values(row(randomUUID()))).to.be.rejected;
    });

    it('the unique index keeps subject keys that differ only in case apart', async () => {
      const fs = `ci-key-${randomUUID().slice(0, 8)}`;
      await store.grant({ fs, path: 'a.txt', subject: { type: 'user', id: 'Alice' }, relation: 'viewer' });
      await store.grant({ fs, path: 'a.txt', subject: { type: 'user', id: 'alice' }, relation: 'viewer' });
      expect(await store.list(fs, 'a.txt')).to.have.length(2);
    });

    it('uses the connection authz.fsAcl.connection names, else the default one', async function () {
      sqliteOnly(this);
      const other = orm!.Connections.get('other')!;
      await new AuthzFsAcl_2026_10_17_00_00_00().up(other);
      config.set(['authz', 'fsAcl', 'connection'], 'other');
      await store.setOwnerIfAbsent('conn', 'a.txt', BOB);
      expect(((await other.select().from('fs_acl').where({ path: 'a.txt', fs: 'conn' })) as unknown[]).length).to.equal(1);
      expect(((await db.select().from('fs_acl').where({ path: 'a.txt', fs: 'conn' })) as unknown[]).length).to.equal(0);
      expect(await new OrmFileAclStore({ connection: 'default' }).ownerOf('conn', 'a.txt')).to.equal(null);

      config.set(['authz', 'fsAcl', 'connection'], 'nope');
      const e = await store.ownerOf('conn', 'a.txt').then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e!.message).to.contain('authz.fsAcl.connection');
    });

    it('on a case-insensitive table matches rows exactly in code', async function () {
      sqliteOnly(this);
      // As MySQL's or MSSQL's default collation would make the table; SQLite's LIKE also ignores ASCII case.
      await rawSql(orm!.Connections.get('nocase')!, 'CREATE TABLE fs_acl (id varchar(36) PRIMARY KEY, fs varchar(64) COLLATE NOCASE NOT NULL, path varchar(512) COLLATE NOCASE NOT NULL, path_hash varchar(64) COLLATE NOCASE NOT NULL, subject_key varchar(200) COLLATE NOCASE NOT NULL, relation varchar(64) COLLATE NOCASE NOT NULL, expires_at datetime, granted_by varchar(100), created_at datetime NOT NULL)');
      const ci = new OrmFileAclStore({ connection: 'nocase' });
      await ci.grant({ fs: 'ci', path: 'Docs/A.txt', subject: ALICE, relation: 'viewer' });
      expect(await ci.holds('ci', ['docs/a.txt'], ['user:alice'], 'viewer', new Date())).to.equal(false);
      expect(await ci.list('ci', 'docs/a.txt')).to.deep.equal([]);
      await ci.deleteTree('ci', 'docs');
      expect(await ci.list('ci', 'Docs/A.txt')).to.have.length(1);
    });
  });
}

ormSuite('sqlite');
for (const kind of (process.env.AUTHZ_FS_DB ?? '').split(',')) if (kind === 'postgres' || kind === 'mysql') ormSuite(kind);
