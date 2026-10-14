import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { OrmDriver, QueryContext } from '@spinajs/orm';

import { AuthzRbac_2026_10_01_00_00_00 } from '../../src/index.js';
import { bootDb, DB_KINDS, DbKind, rawQuery, TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const MIGRATION = 'AuthzRbac_2026_10_01_00_00_00';
const TABLES = ['authz_assignment', 'authz_subject_membership', 'authz_rule', 'authz_rule_subject', 'authz_link', 'authz_version'];

type ColumnKind = 'string' | 'text' | 'int' | 'bigint' | 'boolean' | 'datetime';

/** [name, kind, varchar length, nullable] in design §9.1 order. */
type ColumnSpec = [string, ColumnKind, number | null, boolean];

const SCHEMA: Record<string, ColumnSpec[]> = {
  authz_assignment: [
    ['id', 'string', 36, false],
    ['subject_type', 'string', 32, false],
    ['subject_id', 'string', 64, false],
    ['subject_role', 'string', 128, false],
    ['subject_key', 'string', 200, false],
    ['role', 'string', 128, false],
    ['scope_type', 'string', 64, false],
    ['scope_id', 'string', 64, false],
    ['tags', 'string', 512, false],
    ['expires_at', 'datetime', null, true],
    ['granted_by', 'string', 100, true],
    ['source', 'string', 32, false],
    ['created_at', 'datetime', null, false],
  ],
  authz_subject_membership: [
    ['member_key', 'string', 200, false],
    ['set_key', 'string', 200, false],
    ['depth', 'int', null, false],
    ['expires_at', 'datetime', null, true],
  ],
  authz_rule: [
    ['id', 'string', 160, false],
    ['kind', 'string', 16, false],
    ['scope_type', 'string', 64, false],
    ['scope_id', 'string', 64, false],
    ['definition', 'text', null, false],
    ['expires_at', 'datetime', null, true],
    ['created_by', 'string', 100, true],
    ['created_at', 'datetime', null, false],
  ],
  authz_rule_subject: [
    ['rule_id', 'string', 160, false],
    ['list', 'string', 8, false],
    ['subject_type', 'string', 32, false],
    ['subject_id', 'string', 64, false],
    ['subject_role', 'string', 128, false],
  ],
  authz_link: [
    ['id', 'string', 36, false],
    ['token_hash', 'string', 128, false],
    ['scope_type', 'string', 64, false],
    ['scope_id', 'string', 64, false],
    ['attributes', 'text', null, true],
    ['expires_at', 'datetime', null, true],
    ['revoked_at', 'datetime', null, true],
    ['created_by', 'string', 100, true],
    ['created_at', 'datetime', null, false],
  ],
  authz_version: [
    ['domain', 'string', 64, false],
    ['version', 'bigint', null, false],
  ],
};

const PRIMARY_KEYS: Record<string, string[]> = {
  authz_assignment: ['id'],
  authz_subject_membership: ['member_key', 'set_key'],
  authz_rule: ['id'],
  authz_rule_subject: ['rule_id', 'list', 'subject_type', 'subject_id', 'subject_role'],
  authz_link: ['id'],
  authz_version: ['domain'],
};

const NATIVE_TYPES: Record<DbKind, Record<ColumnKind, string>> = {
  sqlite: { string: 'TEXT', text: 'TEXT', int: 'INTEGER', bigint: 'INTEGER', boolean: 'BOOLEAN', datetime: 'TEXT' },
  postgres: { string: 'varchar', text: 'text', int: 'int4', bigint: 'int8', boolean: 'bool', datetime: 'timestamp' },
};

const NOW = new Date('2026-10-01T12:00:00.000Z');

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

async function row(driver: OrmDriver, table: string, where: Record<string, unknown>): Promise<Record<string, any>> {
  const rows = (await driver.select().from(table).where(where)) as any[];
  expect(rows, `${table} ${JSON.stringify(where)}`).to.have.length(1);
  return rows[0] as Record<string, any>;
}

function insert(driver: OrmDriver, table: string, values: Record<string, unknown>) {
  return driver.insert().into(table).values(values);
}

const assignment = (over: Record<string, unknown> = {}) => {
  const r = { id: 'a1', subject_type: 'user', subject_id: 'u1', subject_role: '', role: 'editor', created_at: NOW, ...over };
  return { subject_key: r.subject_role ? `${r.subject_type}:${r.subject_id}#${r.subject_role}` : `${r.subject_type}:${r.subject_id}`, ...r };
};

for (const kind of DB_KINDS) {
  describe(`${MIGRATION} (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'rbac_initial');
    });

    after(async () => {
      await db?.dispose();
    });

    it('is registered from the package root and applied by the boot migration pass', async () => {
      expect(db.orm.Migrations.map((m) => m.type)).to.include(AuthzRbac_2026_10_01_00_00_00);

      const status = (await db.orm.Migration.status()).find((s) => s.name === MIGRATION);
      expect(status, 'status entry').to.not.be.undefined;
      expect(status!.pending).to.eq(false);
      expect(status!.failed).to.eq(false);

      for (const table of TABLES) {
        expect(await db.driver.schema().tableExists(table), table).to.eq(true);
      }
    });

    for (const [table, columns] of Object.entries(SCHEMA)) {
      it(`${table} has the §9.1 columns, types, nullability and primary key`, async () => {
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

    it('creates the §9.1 indexes', async () => {
      const find = async (table: string, name: string) => (await indexes(db, table)).find((i) => i.name === name);

      expect(await find('authz_assignment', 'authz_assignment_uq')).to.deep.eq({ name: 'authz_assignment_uq', unique: true, columns: ['subject_type', 'subject_id', 'subject_role', 'role', 'scope_type', 'scope_id'] });
      expect(await find('authz_assignment', 'authz_assignment_scope')).to.deep.eq({ name: 'authz_assignment_scope', unique: false, columns: ['scope_type', 'scope_id', 'role'] });
      expect(await find('authz_assignment', 'authz_assignment_expires')).to.deep.eq({ name: 'authz_assignment_expires', unique: false, columns: ['expires_at'] });
      expect(await find('authz_assignment', 'authz_assignment_subject')).to.deep.eq({ name: 'authz_assignment_subject', unique: false, columns: ['subject_key', 'role'] });
      expect(await find('authz_subject_membership', 'authz_subject_membership_set')).to.deep.eq({ name: 'authz_subject_membership_set', unique: false, columns: ['set_key'] });
      expect(await find('authz_rule', 'authz_rule_scope')).to.deep.eq({ name: 'authz_rule_scope', unique: false, columns: ['scope_type', 'scope_id', 'kind'] });
      expect(await find('authz_link', 'authz_link_token')).to.deep.eq({ name: 'authz_link_token', unique: true, columns: ['token_hash'] });
    });

    it('authz_assignment fills the defaults of a principal at $global', async () => {
      await insert(db.driver, 'authz_assignment', assignment({ id: 'def-1' }));

      const r = await row(db.driver, 'authz_assignment', { id: 'def-1' });
      expect(r.subject_role).to.eq('');
      expect(r.scope_type).to.eq('$global');
      expect(r.scope_id).to.eq('');
      expect(r.tags).to.eq('');
      expect(r.source).to.eq('db');
      expect(r.expires_at).to.eq(null);
      expect(r.granted_by).to.eq(null);
      expect(r.created_at).to.not.eq(null);
    });

    it('authz_assignment refuses a missing required column', async () => {
      await expect(insert(db.driver, 'authz_assignment', { id: 'nn-1', subject_type: 'user', subject_id: 'u1', created_at: NOW })).to.be.rejected;
    });

    it('authz_assignment refuses a row without subject_key', async () => {
      const { subject_key: _key, ...rest } = assignment({ id: 'nk-1' });
      await expect(insert(db.driver, 'authz_assignment', rest)).to.be.rejected;
    });

    it('authz_assignment_uq refuses a second identical grant and keeps subject sets apart', async () => {
      const grant = { subject_type: 'team', subject_id: 't1', role: 'viewer', scope_type: 'org', scope_id: 'o1' };
      await insert(db.driver, 'authz_assignment', assignment({ ...grant, id: 'uq-1' }));

      await expect(insert(db.driver, 'authz_assignment', assignment({ ...grant, id: 'uq-2' }))).to.be.rejected;

      // same columns except subject_role: holders of 'member' at team t1 are another subject
      await insert(db.driver, 'authz_assignment', assignment({ ...grant, id: 'uq-3', subject_role: 'member' }));
      const rows = (await db.driver.select().from('authz_assignment').where({ subject_type: 'team', subject_id: 't1' })) as any[];
      expect(rows.map((r: any) => r.id).sort()).to.deep.eq(['uq-1', 'uq-3']);
    });

    it('authz_rule defaults the scope to $global', async () => {
      await insert(db.driver, 'authz_rule', { id: 'r1', kind: 'restrict', definition: '{}', created_at: NOW });

      const r = await row(db.driver, 'authz_rule', { id: 'r1' });
      expect(r.scope_type).to.eq('$global');
      expect(r.scope_id).to.eq('');
      expect(r.expires_at).to.eq(null);
      expect(r.created_by).to.eq(null);
    });

    it('authz_rule_subject has a composite primary key and defaults subject_role to a principal', async () => {
      const ref = { rule_id: 'r1', list: 'allow', subject_type: 'user', subject_id: 'u1' };
      await insert(db.driver, 'authz_rule_subject', ref);

      const r = await row(db.driver, 'authz_rule_subject', ref);
      expect(r.subject_role).to.eq('');

      await expect(insert(db.driver, 'authz_rule_subject', ref)).to.be.rejected;

      await insert(db.driver, 'authz_rule_subject', { ...ref, list: 'refs' });
      await insert(db.driver, 'authz_rule_subject', { ...ref, subject_role: 'member' });
      const rows = (await db.driver.select().from('authz_rule_subject').where({ rule_id: 'r1' })) as any[];
      expect(rows).to.have.length(3);
    });

    it('authz_link_token refuses a second link with the same token hash', async () => {
      await insert(db.driver, 'authz_link', { id: 'l1', token_hash: 'h1', scope_type: 'project', scope_id: 'p1', created_at: NOW });

      const r = await row(db.driver, 'authz_link', { id: 'l1' });
      for (const name of ['attributes', 'expires_at', 'revoked_at', 'created_by']) {
        expect(r[name], name).to.eq(null);
      }

      await expect(insert(db.driver, 'authz_link', { id: 'l2', token_hash: 'h1', scope_type: 'project', scope_id: 'p1', created_at: NOW })).to.be.rejected;
      await expect(insert(db.driver, 'authz_link', { id: 'l3', token_hash: 'h3', scope_type: 'project', created_at: NOW }), 'scope_id has no default').to.be.rejected;
    });

    it('authz_version keys one bigint counter per domain', async () => {
      await insert(db.driver, 'authz_version', { domain: 'root', version: 1 });
      await rawQuery(db.driver, 'UPDATE authz_version SET version = version + 1 WHERE domain = ?', ['root'], QueryContext.Update);

      const r = await row(db.driver, 'authz_version', { domain: 'root' });
      expect(String(r.version)).to.eq('2');

      await expect(insert(db.driver, 'authz_version', { domain: 'root', version: 5 })).to.be.rejected;
    });

    it('down() through the migration service drops every table, and up() restores them', async () => {
      const undone = await db.orm.Migration.down(MIGRATION);
      expect(undone.map((m) => m.constructor)).to.deep.eq([AuthzRbac_2026_10_01_00_00_00]);

      for (const table of TABLES) {
        expect(await db.driver.schema().tableExists(table), table).to.eq(false);
      }

      const status = (await db.orm.Migration.status()).find((s) => s.name === MIGRATION);
      expect(status!.pending).to.eq(true);

      await db.orm.Migration.up(MIGRATION);
      for (const table of TABLES) {
        expect(await db.driver.schema().tableExists(table), table).to.eq(true);
      }
    });
  });
}
