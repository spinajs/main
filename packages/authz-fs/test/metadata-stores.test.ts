import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AuthzConfigError, TRUE } from '@spinajs/authz';
import type { Decision, Principal } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { fsNative } from '@spinajs/fs';
import type { fs } from '@spinajs/fs';
import { fsS3 } from '@spinajs/fs-s3';
import { Orm, QueryContext, extractMigrationDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthzFsObject_2026_10_01_00_00_00, FileMetadataStore, OrmFileMetadataStore, S3ObjectMetadataStore, guardFs, parseFsAccessConfig } from '../src/index.js';
import type { FileMeta } from '../src/index.js';
import { FakeConfiguration, configuredChild } from './helpers.js';
import { installQuietLog } from './support/log.js';
import { MemoryFileMetadataStore } from './support/memory-store.js';

const expect = chai.expect;

const ALICE = { type: 'user', id: 'alice' } as const;
const BOB = { type: 'user', id: 'bob' } as const;
const FULL: FileMeta = { owner: ALICE, scope: { type: 'project', id: 'p1' }, tags: ['invoice', 'q3'] };

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

interface ContractSetup {
  readonly store: FileMetadataStore;
  /** Makes the file exist (S3 keeps the metadata on the object). */
  touch(fsName: string, path: string): Promise<void>;
}

/** What every FileMetadataStore must do; `fsA` and `fsB` are two filesystems the store serves. */
function storeContract(setup: () => ContractSetup, fsA: string, fsB: string): void {
  let s: ContractSetup;
  let n = 0;
  // Fresh paths per case, so the cases need no cleanup between them.
  let dir: string;

  beforeEach(() => {
    s = setup();
    dir = `c${++n}-${randomUUID().slice(0, 8)}`;
  });

  it('gets null for a path without metadata', async () => {
    expect(await s.store.get(fsA, `${dir}/none.txt`)).to.equal(null);
  });

  it('sets and gets owner, scope and tags', async () => {
    await s.touch(fsA, `${dir}/a.txt`);
    await s.store.set(fsA, `${dir}/a.txt`, FULL);
    expect(await s.store.get(fsA, `${dir}/a.txt`)).to.deep.equal(FULL);
  });

  it('replaces the whole metadata on set', async () => {
    await s.touch(fsA, `${dir}/a.txt`);
    await s.store.set(fsA, `${dir}/a.txt`, FULL);
    await s.store.set(fsA, `${dir}/a.txt`, { owner: BOB });
    expect(await s.store.get(fsA, `${dir}/a.txt`)).to.deep.equal({ owner: BOB });
  });

  it('keeps a scope without an id and an owner id outside ASCII', async () => {
    const meta: FileMeta = { owner: { type: 'user', id: 'zażółć-żółw 1' }, scope: { type: 'org' } };
    await s.touch(fsA, `${dir}/u.txt`);
    await s.store.set(fsA, `${dir}/u.txt`, meta);
    expect(await s.store.get(fsA, `${dir}/u.txt`)).to.deep.equal(meta);
  });

  it('normalises the path (D3)', async () => {
    await s.touch(fsA, `${dir}/docs/a.txt`);
    await s.store.set(fsA, `${dir}\\docs\\a.txt`, { owner: ALICE });
    expect(await s.store.get(fsA, `./${dir}/docs/a.txt`)).to.deep.equal({ owner: ALICE });
    expect(await s.store.get(fsA, `${dir}/docs//a.txt`)).to.deep.equal({ owner: ALICE });
  });

  it('keeps filesystems apart', async () => {
    await s.touch(fsA, `${dir}/a.txt`);
    await s.store.set(fsA, `${dir}/a.txt`, { owner: ALICE });
    expect(await s.store.get(fsB, `${dir}/a.txt`)).to.equal(null);
  });

  it('deletes, and a delete without metadata is a no-op', async () => {
    await s.touch(fsA, `${dir}/a.txt`);
    await s.store.set(fsA, `${dir}/a.txt`, { owner: ALICE });
    await s.store.delete(fsA, `${dir}/a.txt`);
    expect(await s.store.get(fsA, `${dir}/a.txt`)).to.equal(null);
    await s.store.delete(fsA, `${dir}/a.txt`);
    await s.store.delete(fsA, `${dir}/never.txt`);
  });

  it('moves within a filesystem, replacing the destination', async () => {
    await s.touch(fsA, `${dir}/a.txt`);
    await s.touch(fsA, `${dir}/b.txt`);
    await s.store.set(fsA, `${dir}/a.txt`, FULL);
    await s.store.set(fsA, `${dir}/b.txt`, { owner: BOB });
    await s.store.move(fsA, `${dir}/a.txt`, fsA, `${dir}/b.txt`);
    expect(await s.store.get(fsA, `${dir}/a.txt`)).to.equal(null);
    expect(await s.store.get(fsA, `${dir}/b.txt`)).to.deep.equal(FULL);
  });

  it('moves across filesystems', async () => {
    await s.touch(fsA, `${dir}/a.txt`);
    await s.touch(fsB, `${dir}/moved.txt`);
    await s.store.set(fsA, `${dir}/a.txt`, { owner: ALICE });
    await s.store.move(fsA, `${dir}/a.txt`, fsB, `${dir}/moved.txt`);
    expect(await s.store.get(fsA, `${dir}/a.txt`)).to.equal(null);
    expect(await s.store.get(fsB, `${dir}/moved.txt`)).to.deep.equal({ owner: ALICE });
  });

  it('refuses the filesystem root and a malformed FileMeta', async () => {
    expect(await s.store.get(fsA, '')).to.equal(null);
    expect(await rejection(s.store.set(fsA, '/', { owner: ALICE }))).to.be.instanceOf(InvalidArgument);
    await s.touch(fsA, `${dir}/a.txt`);
    expect(await rejection(s.store.set(fsA, `${dir}/a.txt`, { owner: { type: 'user' } } as unknown as FileMeta))).to.be.instanceOf(InvalidArgument);
    expect(await rejection(s.store.set(fsA, `${dir}/a.txt`, { tags: ['ok', 3] } as unknown as FileMeta))).to.be.instanceOf(InvalidArgument);
    expect(await rejection(s.store.set(fsA, `${dir}/../../a.txt`, { owner: ALICE }))).to.be.instanceOf(InvalidArgument);
  });
}

describe('authz-fs FileMetadataStore contract: MemoryFileMetadataStore (test double)', () => {
  // The guard tests use the double, so it must keep the contract too.
  storeContract(() => ({ store: new MemoryFileMetadataStore(), touch: async () => undefined }), 'uploads', 'archive');
});

type DbKind = 'sqlite' | 'postgres' | 'mysql';

/** Runs plain SQL; executeOnDb lives on the SQL drivers, not on OrmDriver. */
const rawSql = (driver: OrmDriver, sql: string): Promise<unknown> => (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<unknown> }).executeOnDb(sql, [], QueryContext.Schema);

const PG = { Host: '127.0.0.1', Port: 15432, User: 'postgres', Password: 'postgres' };
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
    connection: { Driver: `orm-driver-${kind}`, Name: kind, ...server, Database: name, Migration: { Table: 'orm_migrations', OnStartup: true } },
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

/** OrmFileMetadataStore on SQLite always; on Postgres or MySQL when AUTHZ_FS_DB names them (AUTHZ_FS_DB=postgres,mysql). */
function ormSuite(kind: DbKind): void {
  describe(`authz-fs OrmFileMetadataStore on ${kind}`, function () {
    this.timeout(60000);

    let orm: Orm | undefined;
    let db: OrmDriver;
    let config: Configuration;
    let undoLog: (() => void) | undefined;
    let drop: (() => Promise<void>) | undefined;
    const store = new OrmFileMetadataStore();
    const sqliteOnly = (ctx: Mocha.Context): void => {
      if (kind !== 'sqlite') ctx.skip();
    };

    before(async () => {
      undoLog = installQuietLog();
      const sqlite = (name: string, migrate = false) => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: name, ...(migrate ? { Migration: { Table: 'orm_migrations', OnStartup: true } } : {}) });
      let main: Record<string, unknown> = sqlite('sqlite', true);
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
    });

    after(async () => {
      for (const c of new Set(orm?.Connections.values() ?? [])) await c.disconnect();
      DI.uncache(Orm);
      DI.uncache(Configuration);
      DI.unregister(FakeConfiguration);
      DI.unregister(SqliteOrmDriver);
      await drop?.();
      undoLog?.();
    });

    beforeEach(() => {
      config.set(['authz', 'fsMetadata'], undefined);
      config.set(['authz', 'fs'], undefined);
    });

    describe('contract', () => {
      storeContract(() => ({ store, touch: async () => undefined }), 'uploads', 'archive');
    });

    it('is registered under FileMetadataStore, as is S3ObjectMetadataStore', () => {
      const types = DI.RootContainer.getRegisteredTypes(FileMetadataStore);
      expect(types).to.include(OrmFileMetadataStore);
      expect(types).to.include(S3ObjectMetadataStore);
    });

    it('the migration registers through @Migration and creates fs_object at startup (design §9.1)', async () => {
      expect(orm!.Migrations.map((m) => m.name)).to.include(AuthzFsObject_2026_10_01_00_00_00.name);
      const info = await db.tableInfo('fs_object');
      expect(info.map((c) => c.Name).sort()).to.deep.equal(['created_at', 'fs', 'owner_id', 'owner_type', 'path', 'scope_id', 'scope_type', 'tags', 'updated_at']);
      expect(info.filter((c) => c.PrimaryKey).map((c) => c.Name)).to.have.members(['fs', 'path']);
    });

    it('the migration runs on the connection the store uses, authz.fsMetadata.connection (review M3)', () => {
      expect(extractMigrationDescriptor(AuthzFsObject_2026_10_01_00_00_00)?.Connection).to.equal('default');
      config.set(['authz', 'fsMetadata', 'connection'], 'other');
      expect(extractMigrationDescriptor(AuthzFsObject_2026_10_01_00_00_00)?.Connection).to.equal('other');
    });

    it('keeps case variants of a path apart: Report.pdf and report.pdf are two files (review C2)', async () => {
      await store.set('uploads', 'case/Report.pdf', { owner: ALICE });
      expect(await store.get('uploads', 'case/report.pdf')).to.equal(null);
      await store.set('uploads', 'case/report.pdf', { owner: BOB });
      expect(await store.get('uploads', 'case/Report.pdf')).to.deep.equal({ owner: ALICE });
      expect(await store.get('uploads', 'case/report.pdf')).to.deep.equal({ owner: BOB });
      await store.delete('uploads', 'case/report.pdf');
      expect(await store.get('uploads', 'case/Report.pdf')).to.deep.equal({ owner: ALICE });
    });

    it('writes one row with the owner and scope columns and the tags as JSON; set keeps created_at', async () => {
      await store.set('uploads', 'rows/a.txt', FULL);
      const [first] = (await db.select().from('fs_object').where({ fs: 'uploads', path: 'rows/a.txt' })) as Record<string, unknown>[];
      expect(first).to.deep.include({ owner_type: 'user', owner_id: 'alice', scope_type: 'project', scope_id: 'p1', tags: '["invoice","q3"]' });
      await new Promise((r) => setTimeout(r, 1100));
      await store.set('uploads', 'rows/a.txt', { owner: BOB });
      const rows = (await db.select().from('fs_object').where({ fs: 'uploads', path: 'rows/a.txt' })) as Record<string, unknown>[];
      expect(rows).to.have.length(1);
      expect(rows[0]).to.deep.include({ owner_type: 'user', owner_id: 'bob', scope_type: null, scope_id: null, tags: null });
      expect(String(rows[0].created_at)).to.equal(String(first.created_at));
      expect(String(rows[0].updated_at)).to.not.equal(String(first.updated_at));
    });

    it('delete and move take the rows under a directory along, and not its siblings by prefix or case (review I1)', async () => {
      for (const p of ['tree/d', 'tree/d/a.txt', 'tree/d/sub/b.txt', 'tree/d-x.txt', 'tree/dd/c.txt', 'tree/d.txt', 'tree/D/up.txt']) await store.set('uploads', p, { owner: ALICE });
      await store.move('uploads', 'tree/d', 'archive', 'moved/d2');
      expect(await store.get('archive', 'moved/d2')).to.deep.equal({ owner: ALICE });
      expect(await store.get('archive', 'moved/d2/a.txt')).to.deep.equal({ owner: ALICE });
      expect(await store.get('archive', 'moved/d2/sub/b.txt')).to.deep.equal({ owner: ALICE });
      for (const p of ['tree/d', 'tree/d/a.txt', 'tree/d/sub/b.txt']) expect(await store.get('uploads', p)).to.equal(null);
      for (const p of ['tree/d-x.txt', 'tree/dd/c.txt', 'tree/d.txt', 'tree/D/up.txt']) expect(await store.get('uploads', p), p).to.deep.equal({ owner: ALICE });

      await store.delete('archive', 'moved');
      expect(await store.get('archive', 'moved/d2/a.txt')).to.equal(null);
      expect(await store.get('uploads', 'tree/dd/c.txt')).to.deep.equal({ owner: ALICE });
    });

    it('escapes LIKE wildcards in directory paths: a_b and 100% match only themselves', async () => {
      for (const p of ['w/a_b/x', 'w/axb/y', 'w/100%/z', 'w/1000/q']) await store.set('uploads', p, { owner: ALICE });
      await store.delete('uploads', 'w/a_b');
      await store.delete('uploads', 'w/100%');
      expect(await store.get('uploads', 'w/a_b/x')).to.equal(null);
      expect(await store.get('uploads', 'w/100%/z')).to.equal(null);
      expect(await store.get('uploads', 'w/axb/y')).to.deep.equal({ owner: ALICE });
      expect(await store.get('uploads', 'w/1000/q')).to.deep.equal({ owner: ALICE });
    });

    it('refuses a move into its own subtree and values longer than their columns, also through checkMeta (review M2)', async () => {
      await store.set('uploads', 'loop/a', { owner: ALICE });
      expect(await rejection(store.move('uploads', 'loop/a', 'uploads', 'loop/a/b'))).to.be.instanceOf(InvalidArgument);
      expect(await store.get('uploads', 'loop/a')).to.deep.equal({ owner: ALICE });
      expect(await rejection(store.set('uploads', `long/${'x'.repeat(520)}`, { owner: ALICE }))).to.be.instanceOf(InvalidArgument);
      expect(await rejection(store.set('uploads', 'long/a', { owner: { type: 'user', id: 'x'.repeat(65) } }))).to.be.instanceOf(InvalidArgument);
      expect(await rejection(store.set('x'.repeat(65), 'long/a', { owner: ALICE }))).to.be.instanceOf(InvalidArgument);
      expect(() => store.checkMeta('uploads', 'long/a', { owner: { type: 'user', id: 'x'.repeat(65) } })).to.throw(InvalidArgument);
      expect(() => store.checkMeta('uploads', `long/${'x'.repeat(520)}`, { owner: ALICE })).to.throw(InvalidArgument);
      store.checkMeta('uploads', 'long/a', FULL);
    });

    it('uses the connection authz.fsMetadata.connection names, else the default one', async function () {
      sqliteOnly(this);
      const other = orm!.Connections.get('other')!;
      await new AuthzFsObject_2026_10_01_00_00_00().up(other);
      config.set(['authz', 'fsMetadata', 'connection'], 'other');
      await store.set('uploads', 'conn/a.txt', { owner: BOB });
      expect(((await other.select().from('fs_object').where({ path: 'conn/a.txt' })) as unknown[]).length).to.equal(1);
      expect(((await db.select().from('fs_object').where({ path: 'conn/a.txt' })) as unknown[]).length).to.equal(0);
      expect(await new OrmFileMetadataStore({ connection: 'default' }).get('uploads', 'conn/a.txt')).to.equal(null);

      config.set(['authz', 'fsMetadata', 'connection'], 'nope');
      const e = await rejection(store.get('uploads', 'conn/a.txt'));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.contain('authz.fsMetadata.connection');
    });

    it('on a case-insensitive table matches rows exactly in code and refuses to merge case variants (review C2)', async function () {
      sqliteOnly(this);
      // As MySQL's or MSSQL's default collation would make the table; SQLite's LIKE also ignores ASCII case.
      await rawSql(orm!.Connections.get('nocase')!, 'CREATE TABLE fs_object (fs varchar(64) COLLATE NOCASE NOT NULL, path varchar(512) COLLATE NOCASE NOT NULL, owner_type varchar(32), owner_id varchar(64), scope_type varchar(64), scope_id varchar(64), tags text, created_at datetime NOT NULL, updated_at datetime NOT NULL, PRIMARY KEY (fs, path))');
      const ci = new OrmFileMetadataStore({ connection: 'nocase' });
      await ci.set('uploads', 'Report.pdf', { owner: ALICE });
      expect(await ci.get('uploads', 'report.pdf')).to.equal(null);
      expect(await rejection(ci.set('uploads', 'report.pdf', { owner: BOB }))).to.be.an('error');
      expect(await ci.get('uploads', 'Report.pdf')).to.deep.equal({ owner: ALICE });
      await ci.delete('uploads', 'report.pdf');
      expect(await ci.get('uploads', 'Report.pdf')).to.deep.equal({ owner: ALICE });

      await ci.set('uploads', 'Docs/a.txt', { owner: ALICE });
      await ci.set('uploads', 'docs/b.txt', { owner: BOB });
      await ci.delete('uploads', 'docs');
      expect(await ci.get('uploads', 'Docs/a.txt')).to.deep.equal({ owner: ALICE });
      expect(await ci.get('uploads', 'docs/b.txt')).to.equal(null);
      await ci.move('uploads', 'Docs', 'uploads', 'moved');
      expect(await ci.get('uploads', 'moved/a.txt')).to.deep.equal({ owner: ALICE });
      await ci.set('uploads', 'x/one.txt', { owner: BOB });
      await ci.move('uploads', 'X', 'uploads', 'y');
      expect(await ci.get('uploads', 'x/one.txt')).to.deep.equal({ owner: BOB });
    });

    it("is what a guard with metadata: 'OrmFileMetadataStore' stamps owners into", async () => {
      const dir = mkdtempSync(join(tmpdir(), 'authz-fs-orm-'));
      try {
        config.set(['authz', 'fs'], { uploads: { mode: 'enforce', metadata: 'OrmFileMetadataStore', stampOwner: true } });
        const allow = async (principal: Principal): Promise<Decision> => ({ allowed: true, residual: TRUE, principal: { type: principal.type, id: principal.id } }) as unknown as Decision;
        const raw = new fsNative({ name: 'uploads', basePath: dir });
        const g = guardFs(raw, 'uploads', { service: async () => ({ check: async (req) => allow(req.principal), assert: async (p) => allow(p) }), principal: () => userPrincipal('carol') });
        await g.write('stamped.txt', 'x');
        expect(await store.get('uploads', 'stamped.txt')).to.deep.equal({ owner: { type: 'user', id: 'carol' } });
        await g.rm('stamped.txt');
        expect(await store.get('uploads', 'stamped.txt')).to.equal(null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

ormSuite('sqlite');
for (const kind of (process.env.AUTHZ_FS_DB ?? '').split(',')) if (kind === 'postgres' || kind === 'mysql') ormSuite(kind);

/** The raw-provider surface the S3 store uses, over a Map: keys missing from it are missing objects. */
class FakeS3Provider {
  readonly objects = new Map<string, Record<string, string>>();
  readonly sets: string[] = [];

  constructor(readonly Name: string) {}

  async getMetadata(path: string): Promise<Record<string, string> | undefined> {
    const meta = this.objects.get(path);
    if (!meta) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    return { ...meta };
  }

  async setMetadata(path: string, meta: Record<string, string>): Promise<void> {
    if (!this.objects.has(path)) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
    this.sets.push(path);
    this.objects.set(path, { ...meta });
  }
}

describe('authz-fs S3ObjectMetadataStore (provider surface)', () => {
  let child: IContainer;
  let a: FakeS3Provider;
  let b: FakeS3Provider;

  beforeEach(async () => {
    child = await configuredChild(undefined);
    a = new FakeS3Provider('s3a');
    b = new FakeS3Provider('s3b');
    child.register(a).asMapValue('__file_provider_instance__', 's3a');
    child.register(b).asMapValue('__file_provider_instance__', 's3b');
  });

  afterEach(async () => {
    await child.dispose();
  });

  describe('contract', () => {
    storeContract(
      () => ({
        store: new S3ObjectMetadataStore({ container: child }),
        touch: async (fsName, path) => {
          const p = fsName === 's3a' ? a : b;
          if (!p.objects.has(path)) p.objects.set(path, { hash: 'h' });
        },
      }),
      's3a',
      's3b',
    );
  });

  it('keeps FileMeta under the ASCII user metadata key authz-meta and keeps the other keys', async () => {
    a.objects.set('a.txt', { hash: 'abc', md5: 'def' });
    const store = new S3ObjectMetadataStore({ container: child });
    await store.set('s3a', 'a.txt', { owner: { type: 'user', id: 'zażółć' } });
    const stored = a.objects.get('a.txt')!;
    expect(stored).to.include({ hash: 'abc', md5: 'def' });
    // eslint-disable-next-line no-control-regex
    expect(stored['authz-meta']).to.match(/^[\x20-\x7e]+$/);
    await store.delete('s3a', 'a.txt');
    expect(a.objects.get('a.txt')).to.deep.equal({ hash: 'abc', md5: 'def' });
  });

  it('refuses a set on a missing object; get and delete of a missing object are null and a no-op', async () => {
    const store = new S3ObjectMetadataStore({ container: child });
    expect(await rejection(store.set('s3a', 'none.txt', { owner: ALICE }))).to.be.an('error');
    expect(await store.get('s3a', 'none.txt')).to.equal(null);
    await store.delete('s3a', 'none.txt');
    expect(a.sets).to.deep.equal([]);
  });

  it('move leaves the destination alone when the source object is gone (the provider moved the object with its metadata)', async () => {
    const store = new S3ObjectMetadataStore({ container: child });
    a.objects.set('to.txt', { 'authz-meta': encodeURIComponent(JSON.stringify({ owner: ALICE })) });
    await store.move('s3a', 'from.txt', 's3a', 'to.txt');
    expect(await store.get('s3a', 'to.txt')).to.deep.equal({ owner: ALICE });
  });

  it('refuses metadata over the S3 limit of 2 KB and leaves the object unchanged', async () => {
    a.objects.set('big.txt', { hash: 'h' });
    const store = new S3ObjectMetadataStore({ container: child });
    const e = await rejection(store.set('s3a', 'big.txt', { owner: ALICE, tags: Array.from({ length: 200 }, (_, i) => `tag-${i}`) }));
    expect(e).to.be.instanceOf(InvalidArgument);
    expect(a.objects.get('big.txt')).to.deep.equal({ hash: 'h' });
  });

  it('checkMeta refuses, before any IO, metadata that alone would not fit S3 user metadata (review M2)', () => {
    const store = new S3ObjectMetadataStore({ container: child });
    expect(() => store.checkMeta('s3a', 'a.txt', { owner: ALICE, tags: Array.from({ length: 200 }, (_, i) => `tag-${i}`) })).to.throw(InvalidArgument);
    store.checkMeta('s3a', 'a.txt', FULL);
    expect(a.sets).to.deep.equal([]);
  });

  it('refuses malformed authz-meta on an object (fail closed)', async () => {
    a.objects.set('bad.txt', { 'authz-meta': encodeURIComponent(JSON.stringify({ owner: { type: 'user' } })) });
    a.objects.set('junk.txt', { 'authz-meta': '%E0%A4%A' });
    const store = new S3ObjectMetadataStore({ container: child });
    expect(await rejection(store.get('s3a', 'bad.txt'))).to.be.instanceOf(AuthzConfigError);
    expect(await rejection(store.get('s3a', 'junk.txt'))).to.be.instanceOf(AuthzConfigError);
  });

  it('reaches the raw provider behind a guard, so its reads are not checked', async () => {
    const raw = new FakeS3Provider('s3g');
    raw.objects.set('a.txt', { 'authz-meta': encodeURIComponent(JSON.stringify({ owner: ALICE })) });
    const denyAll = async (): Promise<Decision> => ({ allowed: false, residual: { op: 'false' } }) as unknown as Decision;
    const guarded = guardFs(raw as unknown as fs, 's3g', { config: parseFsAccessConfig('s3g', { mode: 'enforce' }), container: child, service: async () => ({ check: denyAll, assert: denyAll }), principal: () => userPrincipal('mallory') });
    child.register(guarded).asMapValue('__file_provider_instance__', 's3g');
    expect(await new S3ObjectMetadataStore({ container: child }).get('s3g', 'a.txt')).to.deep.equal({ owner: ALICE });
  });

  it('refuses a filesystem that is not published or has no S3 metadata methods', async () => {
    child.register({ Name: 'plain', read: async () => '' }).asMapValue('__file_provider_instance__', 'plain');
    const store = new S3ObjectMetadataStore({ container: child });
    const missing = await rejection(store.get('nope', 'a.txt'));
    expect(missing).to.be.instanceOf(AuthzConfigError);
    expect(missing.message).to.contain('nope');
    const plain = await rejection(store.get('plain', 'a.txt'));
    expect(plain).to.be.instanceOf(AuthzConfigError);
    expect(plain.message).to.contain('setMetadata');
  });
});

const S3_ENDPOINT = process.env.AUTHZ_FS_S3_ENDPOINT ?? 'http://localhost:4566';

async function s3Reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${S3_ENDPOINT}/_localstack/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe('authz-fs S3ObjectMetadataStore on S3 (localstack)', function () {
  this.timeout(60000);

  const bucket = `authz-fs-meta-${randomUUID().slice(0, 8)}`;
  const providers = new Map<string, fsS3>();
  let child: IContainer;
  let undoLog: () => void;

  const s3 = async (name: string): Promise<fsS3> => {
    const raw = new fsS3({ name, bucket: `${bucket}-${name}` } as never);
    Object.defineProperty(raw, 'AwsConfig', { value: { forcePathStyle: true, endpoint: S3_ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, region: 'us-west-1' } });
    await raw.resolve();
    return raw;
  };

  before(async function () {
    if (!(await s3Reachable())) {
      console.warn(`      S3ObjectMetadataStore on S3 skipped: no localstack at ${S3_ENDPOINT} (docker run --rm -d -p 4566:4566 -e SERVICES=s3 localstack/localstack)`);
      this.skip();
    }
    undoLog = installQuietLog();
    child = await configuredChild(undefined);
    for (const name of ['s3a', 's3b']) {
      const raw = await s3(name);
      providers.set(name, raw);
      child.register(raw).asMapValue('__file_provider_instance__', name);
    }
  });

  after(async () => {
    for (const raw of providers.values()) (raw as unknown as { S3: { destroy(): void } }).S3.destroy();
    await child?.dispose();
    undoLog?.();
  });

  describe('contract', () => {
    storeContract(
      () => ({
        store: new S3ObjectMetadataStore({ container: child }),
        touch: async (fsName, path) => {
          await providers.get(fsName)!.write(path, 'x');
        },
      }),
      's3a',
      's3b',
    );
  });

  it('keeps the object content and its hash metadata', async () => {
    const raw = providers.get('s3a')!;
    await raw.write('typed/a.txt', 'content');
    const before = await raw.getMetadata('typed/a.txt');
    const store = new S3ObjectMetadataStore({ container: child });
    await store.set('s3a', 'typed/a.txt', { owner: ALICE });
    // fsS3.read downloads through a temp filesystem these tests do not set up.
    const chunks: Buffer[] = [];
    for await (const chunk of (await raw.readStream('typed/a.txt')) as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).to.equal('content');
    expect(await raw.getMetadata('typed/a.txt')).to.include({ hash: before!.hash, md5: before!.md5 });
    expect(await store.get('s3a', 'typed/a.txt')).to.deep.equal({ owner: ALICE });
  });

  it("fsS3.move within a bucket keeps the metadata, so the store's move after it is a no-op", async () => {
    const raw = providers.get('s3a')!;
    const store = new S3ObjectMetadataStore({ container: child });
    await raw.write('mv/a.txt', 'x');
    await store.set('s3a', 'mv/a.txt', { owner: ALICE });
    await raw.move('mv/a.txt', 'mv/b.txt');
    await store.move('s3a', 'mv/a.txt', 's3a', 'mv/b.txt');
    expect(await store.get('s3a', 'mv/b.txt')).to.deep.equal({ owner: ALICE });
    expect(await store.get('s3a', 'mv/a.txt')).to.equal(null);
  });
});
