import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OrmDriver, QueryContext } from '@spinajs/orm';

import { AuthnInitial_2026_10_02_00_00_00, readInstant } from '../src/index.js';
import { bootDb, createPgDatabase, DB_KINDS, DbKind, dropPgDatabase, rawQuery, requirePostgres, TestDb } from './support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const MIGRATION = 'AuthnInitial_2026_10_02_00_00_00';
const TABLES = ['authn_identity', 'authn_throttle', 'authn_secret', 'authn_mfa', 'authn_recovery_code', 'authn_nonce'];

type ColumnKind = 'string' | 'text' | 'int' | 'bigint' | 'boolean' | 'datetime';

/** [name, kind, varchar length, nullable] in design §22.16 order; `char(64)` is varchar(64) (no char in the builder). */
type ColumnSpec = [string, ColumnKind, number | null, boolean];

const SCHEMA: Record<string, ColumnSpec[]> = {
  authn_identity: [
    ['id', 'string', 36, false],
    ['identity_type', 'string', 16, false],
    ['identity_id', 'string', 64, false],
    ['provider', 'string', 128, false],
    ['subject', 'string', 255, false],
    ['email', 'string', 255, true],
    ['email_verified', 'boolean', null, false],
    ['attributes', 'text', null, true],
    ['linked_at', 'datetime', null, false],
    ['last_used_at', 'datetime', null, true],
  ],
  authn_throttle: [
    ['k', 'string', 255, false],
    ['attempts', 'int', null, false],
    ['last_attempt_at', 'datetime', null, false],
    ['next_allowed_at', 'datetime', null, false],
    ['updated_at', 'datetime', null, false],
  ],
  authn_secret: [
    ['id', 'string', 36, false],
    ['identity', 'string', 100, false],
    ['purpose', 'string', 32, false],
    ['secret_hash', 'string', 64, false],
    ['expires_at', 'datetime', null, false],
    ['used_at', 'datetime', null, true],
    ['created_at', 'datetime', null, false],
  ],
  authn_mfa: [
    ['identity', 'string', 100, false],
    ['step', 'string', 32, false],
    ['secret_enc', 'text', null, false],
    ['secret_hash', 'string', 64, false],
    ['key_id', 'string', 32, false],
    ['confirmed_at', 'datetime', null, true],
    ['last_step', 'bigint', null, true],
    ['created_at', 'datetime', null, false],
  ],
  authn_recovery_code: [
    ['id', 'string', 36, false],
    ['identity', 'string', 100, false],
    ['code_hash', 'string', 64, false],
    ['used_at', 'datetime', null, true],
  ],
  authn_nonce: [
    ['k', 'string', 160, false],
    ['expires_at', 'datetime', null, false],
  ],
};

const PRIMARY_KEYS: Record<string, string[]> = {
  authn_identity: ['id'],
  authn_throttle: ['k'],
  authn_secret: ['id'],
  authn_mfa: ['identity', 'step'],
  authn_recovery_code: ['id'],
  authn_nonce: ['k'],
};

const NATIVE_TYPES: Record<DbKind, Record<ColumnKind, string>> = {
  sqlite: { string: 'TEXT', text: 'TEXT', int: 'INTEGER', bigint: 'INTEGER', boolean: 'BOOLEAN', datetime: 'TEXT' },
  postgres: { string: 'varchar', text: 'text', int: 'int4', bigint: 'int8', boolean: 'bool', datetime: 'timestamptz' },
};

const NOW = new Date('2026-10-02T12:00:00.000Z');

interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

function select(driver: OrmDriver, sql: string, bindings: unknown[] = []): Promise<any[]> {
  return rawQuery(driver, sql, bindings);
}

async function indexes(db: TestDb, table: string): Promise<IndexInfo[]> {
  if (db.kind === 'sqlite') {
    const list = await select(db.driver, `PRAGMA index_list("${table}")`);
    const result: IndexInfo[] = [];
    for (const idx of list) {
      const info = await select(db.driver, `PRAGMA index_info("${idx.name}")`);
      result.push({ name: idx.name, unique: idx.unique === 1, columns: info.sort((a: any, b: any) => a.seqno - b.seqno).map((c: any) => c.name) });
    }
    return result;
  }

  const rows = await select(
    db.driver,
    `SELECT i.relname AS name, ix.indisunique AS uniq, array_to_string(ARRAY(SELECT a.attname FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord), ',') AS cols
     FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE t.relname = ? AND n.nspname = current_schema()`,
    [table],
  );
  return rows.map((r: any) => ({ name: r.name, unique: r.uniq === true, columns: String(r.cols).split(',') }));
}

async function varcharLengths(db: TestDb, table: string): Promise<Map<string, number | null>> {
  const rows = await select(db.driver, `SELECT column_name, character_maximum_length FROM information_schema.columns WHERE table_name = ? AND table_schema = current_schema()`, [table]);
  return new Map(rows.map((r: any) => [r.column_name, r.character_maximum_length === null ? null : Number(r.character_maximum_length)]));
}

function insert(driver: OrmDriver, table: string, values: Record<string, unknown>) {
  return driver.insert().into(table).values(values);
}

async function row(driver: OrmDriver, table: string, where: Record<string, unknown>): Promise<Record<string, any>> {
  const rows = (await driver.select().from(table).where(where)) as any[];
  expect(rows, `${table} ${JSON.stringify(where)}`).to.have.length(1);
  return rows[0] as Record<string, any>;
}

const identity = (over: Record<string, unknown> = {}) => ({ id: 'i1', identity_type: 'user', identity_id: 'u1', provider: 'google', subject: 's1', linked_at: NOW, ...over });
const secret = (over: Record<string, unknown> = {}) => ({ id: 's1', identity: 'user:u1', purpose: 'reset', secret_hash: 'a'.repeat(64), expires_at: NOW, created_at: NOW, ...over });
const mfa = (over: Record<string, unknown> = {}) => ({ identity: 'user:u1', step: 'totp', secret_enc: 'v1.x.y.z', secret_hash: 'h'.repeat(64), key_id: 'k1', created_at: NOW, ...over });
const throttle = (over: Record<string, unknown> = {}) => ({ k: 'key-1', attempts: 1, last_attempt_at: NOW, next_allowed_at: NOW, updated_at: NOW, ...over });

/** `authn_audit` with its two indexes, as the released 3.x version of the migration created it. */
async function createReleasedAuditTable(driver: OrmDriver): Promise<void> {
  await driver.schema().createTable('authn_audit', (table) => {
    table.string('id', 36).notNull().primaryKey();
    table.dateTime('at').notNull();
    table.string('type', 32).notNull();
    table.string('outcome', 8).notNull();
    table.string('identity', 100);
    table.string('actor', 100);
    table.string('strategy', 64);
    table.string('reason', 64);
    table.string('ip', 64);
    table.string('user_agent', 255);
    table.string('session', 64);
    table.text('data');
  });
  await driver.index().table('authn_audit').name('authn_audit_at').columns(['at']);
  await driver.index().table('authn_audit').name('authn_audit_identity').columns(['identity', 'at']);
}

/** Stands for the checksum 3.x stored: any value other than the checksum of the 4.x class. */
const RELEASED_CHECKSUM = 'f'.repeat(64);

const auditIds = async (driver: OrmDriver) => ((await select(driver, 'SELECT id FROM authn_audit ORDER BY id')) as Array<{ id: string }>).map((r) => r.id);
const indexNames = async (db: TestDb, table: string) => (await indexes(db, table)).map((i) => i.name).filter((n) => n.startsWith('authn_audit_')).sort();

for (const kind of DB_KINDS) {
  describe(`${MIGRATION} (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'initial');
    });

    after(async () => {
      await db?.dispose();
    });

    it('is registered from the package root and applied on startup', async () => {
      expect(db.orm.Migrations.map((m) => m.type)).to.include(AuthnInitial_2026_10_02_00_00_00);

      const status = (await db.migrator.Runner.status()).find((s) => s.name === MIGRATION);
      expect(status, 'status entry').to.not.be.undefined;
      expect(status!.pending).to.eq(false);
      expect(status!.failed).to.eq(false);
      expect(status!.checksumMismatch).to.eq(false);

      for (const table of TABLES) {
        expect(await db.driver.schema().tableExists(table), table).to.eq(true);
      }
      expect(await db.driver.schema().tableExists('authn_audit'), 'authn_audit').to.eq(false);
    });

    for (const [table, columns] of Object.entries(SCHEMA)) {
      it(`${table} has the §22.16 columns, types, nullability and primary key`, async () => {
        const info = await db.driver.tableInfo(table);
        expect(info.map((c) => c.Name)).to.deep.eq(columns.map((c) => c[0]));

        const lengths = db.kind === 'postgres' ? await varcharLengths(db, table) : undefined;

        for (const [name, type, length, nullable] of columns) {
          const column = info.find((c) => c.Name === name)!;
          expect(column.NativeType, `${table}.${name} type`).to.eq(NATIVE_TYPES[db.kind][type]);
          expect(column.Nullable, `${table}.${name} nullable`).to.eq(nullable);
          expect(column.PrimaryKey, `${table}.${name} primary key`).to.eq(PRIMARY_KEYS[table].includes(name));

          if (lengths) {
            expect(lengths.get(name), `${table}.${name} length`).to.eq(length);
          }
        }
      });
    }

    it('creates the §22.16 indexes and authn_recovery_code_owner', async () => {
      const find = async (table: string, name: string) => (await indexes(db, table)).find((i) => i.name === name);

      expect(await find('authn_identity', 'authn_identity_subject')).to.deep.eq({ name: 'authn_identity_subject', unique: true, columns: ['provider', 'subject'] });
      expect(await find('authn_identity', 'authn_identity_owner')).to.deep.eq({ name: 'authn_identity_owner', unique: false, columns: ['identity_type', 'identity_id'] });
      expect(await find('authn_secret', 'authn_secret_hash')).to.deep.eq({ name: 'authn_secret_hash', unique: true, columns: ['secret_hash'] });
      expect(await find('authn_secret', 'authn_secret_owner')).to.deep.eq({ name: 'authn_secret_owner', unique: false, columns: ['identity', 'purpose'] });
      expect(await find('authn_recovery_code', 'authn_recovery_code_owner')).to.deep.eq({ name: 'authn_recovery_code_owner', unique: false, columns: ['identity'] });
    });

    it('authn_identity defaults email_verified to false and refuses a second (provider, subject)', async () => {
      await insert(db.driver, 'authn_identity', identity());

      const r = await row(db.driver, 'authn_identity', { id: 'i1' });
      expect([0, false]).to.include(r.email_verified);
      for (const name of ['email', 'attributes', 'last_used_at']) {
        expect(r[name], name).to.eq(null);
      }

      await expect(insert(db.driver, 'authn_identity', identity({ id: 'i2', identity_id: 'u2' }))).to.be.rejected;
      await insert(db.driver, 'authn_identity', identity({ id: 'i3', subject: 's2' }));
      await insert(db.driver, 'authn_identity', identity({ id: 'i4', provider: 'github' }));
    });

    it('authn_secret refuses a second row with the same secret_hash', async () => {
      await insert(db.driver, 'authn_secret', secret());
      await expect(insert(db.driver, 'authn_secret', secret({ id: 's2', purpose: 'invite' }))).to.be.rejected;
      await insert(db.driver, 'authn_secret', secret({ id: 's3', secret_hash: 'b'.repeat(64) }));
    });

    it('authn_nonce.k and authn_throttle.k refuse duplicates', async () => {
      await insert(db.driver, 'authn_nonce', { k: 'jti-1', expires_at: NOW });
      await expect(insert(db.driver, 'authn_nonce', { k: 'jti-1', expires_at: NOW })).to.be.rejected;

      await insert(db.driver, 'authn_throttle', throttle());
      await expect(insert(db.driver, 'authn_throttle', throttle({ attempts: 2 }))).to.be.rejected;
    });

    it('authn_mfa refuses a duplicate (identity, step) and keeps other pairs apart', async () => {
      await insert(db.driver, 'authn_mfa', mfa());
      await expect(insert(db.driver, 'authn_mfa', mfa({ key_id: 'k2' }))).to.be.rejected;

      await insert(db.driver, 'authn_mfa', mfa({ step: 'webauthn' }));
      await insert(db.driver, 'authn_mfa', mfa({ identity: 'user:u2' }));
      expect((await db.driver.select().from('authn_mfa')) as any[]).to.have.length(3);
    });

    it('authn_mfa.last_step holds a time step beyond 32 bits', async () => {
      await insert(db.driver, 'authn_mfa', mfa({ identity: 'user:big', last_step: 2 ** 40 }));
      const r = await row(db.driver, 'authn_mfa', { identity: 'user:big' });
      expect(String(r.last_step)).to.eq(String(2 ** 40));
    });

    it('a datetime written as a Date reads back as the same instant', async () => {
      const instants = [new Date('2026-01-15T08:00:15.123Z'), new Date('2026-07-01T23:59:59.999Z'), NOW];

      for (const [i, at] of instants.entries()) {
        await insert(db.driver, 'authn_nonce', { k: `utc-${i}`, expires_at: at });
        const r = await row(db.driver, 'authn_nonce', { k: `utc-${i}` });
        expect(readInstant(r.expires_at)?.toISOString(), `instant ${i}`).to.eq(at.toISOString());
      }
    });

    it(`a UTC wall-clock time in the process zone's spring DST gap reads back as the same instant`, async () => {
      const cases: Array<[string, Date]> = [
        ['Europe/London', new Date('2026-03-29T01:30:00.000Z')],
        ['Europe/Warsaw', new Date('2026-03-29T02:30:00.000Z')],
      ];
      const previous = process.env.TZ;
      const system = Intl.DateTimeFormat().resolvedOptions().timeZone;

      try {
        for (const [zone, at] of cases) {
          process.env.TZ = zone;
          const k = `gap-${zone}`;
          await insert(db.driver, 'authn_nonce', { k, expires_at: at });
          const r = await row(db.driver, 'authn_nonce', { k });
          expect(readInstant(r.expires_at)?.toISOString(), zone).to.eq(at.toISOString());
        }
      } finally {
        // Deleting TZ alone keeps Node in the last zone; setting it back first resets it.
        process.env.TZ = previous ?? system;
        if (previous === undefined) delete process.env.TZ;
      }
    });

    it('down() drops all six tables, and up() restores them', async () => {
      const undone = await db.migrator.Runner.down(MIGRATION);
      expect(undone.map((m) => m.constructor)).to.deep.eq([AuthnInitial_2026_10_02_00_00_00]);

      for (const table of TABLES) {
        expect(await db.driver.schema().tableExists(table), table).to.eq(false);
      }

      await db.migrator.Runner.up(MIGRATION);
      for (const table of TABLES) {
        expect(await db.driver.schema().tableExists(table), table).to.eq(true);
      }
    });
  });

  describe(`${MIGRATION} on a database that 3.x left with authn_audit rows (${kind})`, function () {
    this.timeout(60000);

    let database: string;
    let db: TestDb;

    before(async function () {
      if (kind === 'postgres') {
        await requirePostgres(this);
        database = await createPgDatabase('released');
      } else {
        database = join(tmpdir(), `authn-orm-released-${randomBytes(4).toString('hex')}.sqlite`);
      }

      // What a 3.x app left: the migration recorded as applied, with the checksum of its 3.x source, and its seven
      // tables, authn_audit with rows.
      const released = await bootDb(this, kind, 'released', { database });
      try {
        await released.driver.update().in('spinajs_migration').update({ Checksum: RELEASED_CHECKSUM }).where({ Migration: MIGRATION });
        await createReleasedAuditTable(released.driver);
        await insert(released.driver, 'authn_audit', { id: 'a1', at: NOW, type: 'login', outcome: 'success', identity: 'user:u1', ip: '10.0.0.1' });
        await insert(released.driver, 'authn_audit', { id: 'a2', at: NOW, type: 'login', outcome: 'failure', reason: 'bad_credentials' });
      } finally {
        await released.dispose();
      }

      db = await bootDb(this, kind, 'upgraded', { database });
    });

    after(async () => {
      await db?.dispose();
      if (kind === 'postgres') {
        if (database) await dropPgDatabase(database);
      } else if (database) {
        await rm(database, { force: true });
      }
    });

    it('boots without running the migration again, reports its changed source, and leaves authn_audit, its rows and its indexes in place', async () => {
      const status = (await db.migrator.Runner.status()).filter((s) => s.name === MIGRATION);
      expect(status.map((s) => [s.pending, s.failed, s.checksumMismatch])).to.deep.eq([[false, false, true]]);

      for (const table of TABLES) {
        expect(await db.driver.schema().tableExists(table), table).to.eq(true);
      }
      expect(await auditIds(db.driver)).to.deep.eq(['a1', 'a2']);
      expect(await indexNames(db, 'authn_audit')).to.include.members(['authn_audit_at', 'authn_audit_identity']);
    });

    it('down() drops the six tables the migration owns and leaves authn_audit with its rows', async () => {
      await db.migrator.Runner.down(MIGRATION);

      for (const table of TABLES) {
        expect(await db.driver.schema().tableExists(table), table).to.eq(false);
      }
      expect(await auditIds(db.driver)).to.deep.eq(['a1', 'a2']);

      await db.migrator.Runner.up(MIGRATION);
      expect(await auditIds(db.driver)).to.deep.eq(['a1', 'a2']);
    });

    it("the upgrade note's DROP statement removes authn_audit and its indexes", async () => {
      await rawQuery(db.driver, 'DROP TABLE IF EXISTS "authn_audit"', [], QueryContext.Schema);

      expect(await db.driver.schema().tableExists('authn_audit')).to.eq(false);
      expect(await indexNames(db, 'authn_audit')).to.deep.eq([]);
      for (const table of TABLES) {
        expect(await db.driver.schema().tableExists(table), table).to.eq(true);
      }
    });
  });
}
