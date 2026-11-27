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

import { AuthzFsAcl_2026_10_17_00_00_00, FS_ACL_CONNECTION, FileAclStore, FsAclRecord, OrmFileAclStore } from '../src/index.js';
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

const rawRows = async (driver: OrmDriver, sql: string, bindings: unknown[] = []): Promise<Record<string, unknown>[]> =>
  (await (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<unknown> }).executeOnDb(sql, bindings, QueryContext.Select)) as Record<string, unknown>[];

/** How many statements of this database wait for a row lock. */
async function lockWaits(driver: OrmDriver, kind: 'postgres' | 'mysql'): Promise<number> {
  const sql =
    kind === 'postgres'
      ? "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
      : 'SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA = DATABASE()';
  const [row] = await rawRows(driver, sql);
  return Number(row.n);
}

/** Polls (no timing is asserted) until `count` statements wait for a lock. */
async function untilWaiting(driver: OrmDriver, kind: 'postgres' | 'mysql', count: number): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if ((await lockWaits(driver, kind)) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no ${count} statements waited for a lock`);
}

interface HeldLock {
  release(): Promise<void>;
}

/** Holds a row lock on `id` from a connection of its own until release(). */
async function lockRow(locker: OrmDriver, id: string): Promise<HeldLock> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const held = locker.transaction(async (t) => {
    await t.select().from('fs_acl').where({ id }).forUpdate();
    locked();
    await released;
  });
  await Promise.race([isLocked, held]);
  return {
    async release() {
      release();
      await held;
    },
  };
}

/** A throwaway database on the orm packages' test containers, dropped afterwards; AUTHZ_FS_DB_NAME names it. */
async function externalDb(kind: 'postgres' | 'mysql'): Promise<{ connection: Record<string, unknown>; open: () => Promise<OrmDriver>; drop(): Promise<void> }> {
  const name = process.env.AUTHZ_FS_DB_NAME ?? `authz_fs_${randomUUID().slice(0, 8)}`;
  const type = kind === 'postgres' ? (await import('@spinajs/orm-postgres')).PostgresOrmDriver : (await import('@spinajs/orm-mysql')).MySqlOrmDriver;
  const server = kind === 'postgres' ? { ...PG, Database: 'postgres' } : { ...MYSQL, Database: 'mysql' };
  const connect = async (options: Record<string, unknown>): Promise<OrmDriver> => {
    const driver = (await DI.child().resolve(type as never, [options])) as OrmDriver;
    await driver.connect();
    return driver;
  };
  const admin = (): Promise<OrmDriver> => connect({ Name: `authz-fs-${kind}-admin`, Driver: `orm-driver-${kind}`, ...server });
  const a = await admin();
  try {
    await a.schema().createDatabase(name);
  } finally {
    await a.disconnect();
  }
  const quoted = kind === 'postgres' ? `"${name}"` : `\`${name}\``;
  const connection = { Driver: `orm-driver-${kind}`, Name: kind, ...server, Database: name, Migration: { Table: 'orm_migrations' } };
  return {
    connection,
    open: () => connect({ ...connection, Name: `authz-fs-${kind}-second`, Migration: undefined }),
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
    let open: (() => Promise<OrmDriver>) | undefined;
    const store = new OrmFileAclStore();
    const pathsOf = async (fs: string): Promise<string[]> => ((await db.select().from('fs_acl').where({ fs })) as Record<string, unknown>[]).map((r) => `${String(r.path)}:${String(r.subject_key)}`).sort();
    const idOf = async (fs: string, path: string): Promise<string> => String(((await db.select().from('fs_acl').where({ fs, path })) as Record<string, unknown>[])[0].id);

    before(async () => {
      undoLog = installQuietLog();
      // By hand, not migrateTestDatabase(): that would run every migration this process imports; the suite runs fs_acl's alone.
      const sqlite = (name: string) => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: name, Migration: { Table: 'orm_migrations' } });
      let main: Record<string, unknown> = sqlite('sqlite');
      if (kind !== 'sqlite') {
        const external = await externalDb(kind);
        main = external.connection;
        drop = external.drop;
        open = () => external.open();
      }
      DI.register(FakeConfiguration).as(Configuration);
      DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
      config = (await DI.resolve(Configuration)) as Configuration;
      // MigrationCheck off: the boot would otherwise refuse the pending migrations this suite applies by hand
      // StrictTableCheck off: fs_acl is made after the boot, and MigrationCheck 'off' does not skip the table check.
      config.set(['db'], { DefaultConnection: main.Name, MigrationCheck: 'off', StrictTableCheck: false, Connections: [main], Aliases: { [FS_ACL_CONNECTION]: 'default' } });
      orm = (await DI.resolve(Orm)) as Orm;
      db = orm.Connections.get('default')!;
      await new AuthzFsAcl_2026_10_17_00_00_00().up(db);
      // The table was made after the boot, by hand: the model has no columns until the ORM reads it.
      await orm.reloadTableInfo({ models: [FsAclRecord] });
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

    it('stores a datetime in the form a builder insert stores it', async () => {
      const fs = `dates-${randomUUID().slice(0, 8)}`;
      const until = new Date('2031-02-03T04:05:06.000Z');
      await store.grant({ fs, path: 'a.txt', subject: ALICE, relation: 'viewer', expiresAt: until });
      await db.insert().into('fs_acl').values({ id: randomUUID(), fs, path: 'b.txt', path_hash: aclPathHash('b.txt'), subject_key: 'user:alice', relation: 'viewer', expires_at: until, created_at: until });
      const rows = (await db.select().from('fs_acl').where({ fs }).orderBy('path')) as Record<string, unknown>[];
      expect(rows.map((r) => r.path)).to.deep.equal(['a.txt', 'b.txt']);
      expect(rows[0].expires_at).to.deep.equal(rows[1].expires_at);
    });

    // MySQL's utf8mb4_bin and MSSQL compare with trailing spaces ignored; the store decides by === in code.
    it('a row answers only its exact filesystem, path and subject: no case, trailing-space, Unicode-form or prefix variant', async () => {
      const fs = `exact-${randomUUID().slice(0, 8)}`;
      const at = new Date();
      await store.grant({ fs, path: 'A/b', subject: ALICE, relation: 'viewer' });
      await store.grant({ fs, path: 'café.txt', subject: ALICE, relation: 'viewer' });
      expect(await store.holds(fs, ['./A//b/'], ['user:alice'], 'viewer', at)).to.equal(true);
      expect(await store.holds(fs, ['a/b', 'A/B', 'A/bc', 'A'], ['user:alice'], 'viewer', at)).to.equal(false);
      expect(await store.holds(`${fs} `, ['A/b'], ['user:alice'], 'viewer', at)).to.equal(false);
      expect(await store.holds(fs.toUpperCase(), ['A/b'], ['user:alice'], 'viewer', at)).to.equal(false);
      expect(await store.holds(fs, ['A/b'], ['user:alice ', 'USER:ALICE'], 'viewer', at)).to.equal(false);
      expect(await store.holds(fs, ['café.txt'], ['user:alice'], 'viewer', at)).to.equal(false);
      expect(await store.list(`${fs} `, 'A/b')).to.deep.equal([]);
      await store.deleteTree(fs, 'A/b/c');
      await store.deleteTree(`${fs} `, 'A');
      expect(await store.list(fs, 'A/b')).to.have.length(1);

      // Another subject: under PAD SPACE the unique key would refuse the same subject on both filesystems.
      await store.grant({ fs: `${fs} `, path: 'm.txt', subject: BOB, relation: 'viewer' });
      await store.grant({ fs, path: 'm.txt', subject: ALICE, relation: 'viewer' });
      await store.movePath(fs, 'm.txt', fs, 'n.txt');
      expect(await store.list(`${fs} `, 'm.txt')).to.have.length(1);
      expect(await store.list(fs, 'n.txt')).to.have.length(1);
    });

    it('movePath also moves a grant committed while it waits: one statement moves the path', async function () {
      if (kind === 'sqlite') return this.skip();
      const fs = `race-${randomUUID().slice(0, 8)}`;
      await store.grant({ fs, path: 'm.txt', subject: ALICE, relation: 'viewer' });
      await store.grant({ fs, path: 'n.txt', subject: ALICE, relation: 'viewer' });
      const locker = await open!();
      try {
        // The replaced destination row is locked, so the move waits between its reads and its writes.
        const lock = await lockRow(locker, await idOf(fs, 'n.txt'));
        const moved = store.movePath(fs, 'm.txt', fs, 'n.txt');
        await untilWaiting(db, kind, 1);
        await store.grant({ fs, path: 'm.txt', subject: BOB, relation: 'viewer' });
        await lock.release();
        await moved;
      } finally {
        await locker.disconnect();
      }
      expect(await pathsOf(fs)).to.deep.equal(['n.txt:user:alice', 'n.txt:user:bob']);
    });

    it('of two moves of one path the second finds nothing: it never takes a row that already left', async function () {
      if (kind === 'sqlite') return this.skip();
      const fs = `race2-${randomUUID().slice(0, 8)}`;
      await store.grant({ fs, path: 'm.txt', subject: ALICE, relation: 'viewer' });
      const locker = await open!();
      try {
        const lock = await lockRow(locker, await idOf(fs, 'm.txt'));
        const first = store.movePath(fs, 'm.txt', fs, 'n.txt');
        await untilWaiting(db, kind, 1);
        const second = store.movePath(fs, 'm.txt', fs, 'o.txt');
        await untilWaiting(db, kind, 2);
        await lock.release();
        await Promise.all([first, second]);
      } finally {
        await locker.disconnect();
      }
      expect(await pathsOf(fs)).to.deep.equal(['n.txt:user:alice']);
    });

    it('an unreadable expiry on a grant refuses the check instead of granting', async function () {
      const fs = `bad-date-${randomUUID().slice(0, 8)}`;
      const row = { fs, path: 'a.txt', path_hash: aclPathHash('a.txt'), subject_key: 'user:alice', relation: 'viewer' };
      if (kind === 'sqlite') {
        await db.insert().into('fs_acl').values({ id: randomUUID(), ...row, expires_at: 'not a date', created_at: new Date() });
      } else if (kind === 'postgres') {
        await rawRows(db, `INSERT INTO fs_acl (id, fs, path, path_hash, subject_key, relation, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'infinity', now())`, [randomUUID(), ...Object.values(row)]);
      } else {
        await db.transaction(async (t) => {
          // A zero date needs a lenient SESSION sql_mode; the connection's own mode is put back before it returns to the pool.
          const [{ mode }] = await rawRows(t, 'SELECT @@SESSION.sql_mode AS mode');
          await rawRows(t, "SET SESSION sql_mode = ''");
          await rawRows(t, `INSERT INTO fs_acl (id, fs, path, path_hash, subject_key, relation, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, '0000-00-00 00:00:00', NOW())`, [randomUUID(), ...Object.values(row)]);
          await rawRows(t, 'SET SESSION sql_mode = ?', [mode]);
        });
      }
      await expect(store.holds(fs, ['a.txt'], ['user:alice'], 'viewer', new Date())).to.be.rejectedWith(AuthzConfigError, 'unreadable datetime');
      await expect(store.list(fs, 'a.txt')).to.be.rejectedWith(AuthzConfigError, 'unreadable datetime');
    });
  });
}

ormSuite('sqlite');
for (const kind of (process.env.AUTHZ_FS_DB ?? '').split(',')) if (kind === 'postgres' || kind === 'mysql') ormSuite(kind);
