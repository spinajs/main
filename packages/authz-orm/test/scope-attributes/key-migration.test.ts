import * as chai from 'chai';
import 'mocha';
import { createHash } from 'node:crypto';

import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { QueryMiddleware, SelectQueryBuilder, extractMigrationDescriptor } from '@spinajs/orm';
import type { OrmDriver, QueryBuilder } from '@spinajs/orm';

import { AuthzScopeAttributeKey_2026_11_25_00_00_00, AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore, SCOPE_ATTRIBUTE_TABLE, SCOPE_ATTRIBUTE_VERSION_TABLE, scopeAttributeId } from '../../src/index.js';
import { createChangeLogTables, dropChangeLogTables } from '../support/changelog.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

const REBUILT = `${SCOPE_ATTRIBUTE_TABLE}_rebuilt`;
const RESTORED = `${SCOPE_ATTRIBUTE_TABLE}_restored`;
const AT = new Date('2026-11-01T10:00:00.000Z');
const ALICE = { type: 'user', id: 'alice' };
const O1: ResourceRef = { type: 'org', id: 'o1' };
const KEYED_COLUMNS = ['id', 'path', 'scope_id', 'scope_type', 'updated_at', 'updated_by', 'value_json', 'value_num', 'value_text'];
const LEAF_COLUMNS = ['path', 'scope_id', 'scope_type', 'updated_at', 'updated_by', 'value_json', 'value_num', 'value_text'];

type Row = Record<string, unknown>;

/** Rows of the 3.x shape: a $global row with scope_id '', a decimal with six places, a leaf of the full column widths. */
const OLD_ROWS: readonly Row[] = [
  { scope_type: '$global', scope_id: '', path: 'tier', value_json: '"gold"', value_text: 'gold', value_num: null, updated_by: 'user:alice', updated_at: AT },
  { scope_type: 'org', scope_id: 'o1', path: 'limits.max', value_json: '12345678.123456', value_text: '12345678.123456', value_num: 12345678.123456, updated_by: null, updated_at: AT },
  { scope_type: 'org', scope_id: 'o1', path: 'on', value_json: 'true', value_text: 'true', value_num: null, updated_by: 'user:bob', updated_at: AT },
  { scope_type: 't'.repeat(64), scope_id: 'i'.repeat(64), path: 'p'.repeat(160), value_json: '-2.25', value_text: '-2.25', value_num: -2.25, updated_by: null, updated_at: AT },
];

/** Leaves that a case-, accent-, blank- or normalisation-folding collation would make one: each must stay its own row. */
const VARIANTS: readonly (readonly [string, string, string])[] = [
  ['org', 'o1', 'k'],
  ['org', 'O1', 'k'],
  ['org', 'o1 ', 'k'],
  ['org', 'o1', 'k '],
  ['org', 'e', 'k'],
  ['org', 'é', 'k'],
  ['org', 'é', 'k'],
];

const leafOf = (r: Row): string => JSON.stringify([r.scope_type, r.scope_id, r.path]);
const byLeaf = (rows: readonly Row[]): Row[] => [...rows].sort((a, b) => (leafOf(a) < leafOf(b) ? -1 : leafOf(a) > leafOf(b) ? 1 : 0));
const withoutId = (rows: readonly Row[]): Row[] => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id')));
const idOf = (r: Row): string => scopeAttributeId(String(r.scope_type), String(r.scope_id), String(r.path));
const variantRow = ([scope_type, scope_id, path]: readonly [string, string, string], i: number): Row => ({ id: scopeAttributeId(scope_type, scope_id, path), scope_type, scope_id, path, value_json: String(i), value_text: String(i), value_num: i, updated_by: null, updated_at: AT });
const pagedRows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ scope_type: 'org', scope_id: 'o1', path: `k.${i}`, value_json: String(i), value_text: String(i), value_num: i, updated_by: null, updated_at: AT }));

async function failure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a failure');
}

const CHANGED_DURING_COPY = `${SCOPE_ATTRIBUTE_TABLE} changed while it was copied: stop every writer, then run npx spinajs migrate-resolve --name AuthzScopeAttributeKey_2026_11_25_00_00_00 --rolled-back and npx spinajs migrate-up`;

// Module state and one class registered once: DI keeps the instance of a middleware class registered again under the same name.
let onQuery: ((query: QueryBuilder) => Promise<void>) | undefined;

class CopyHook extends QueryMiddleware {
  afterQueryCreation(): void {}

  async beforeQueryExecution(query: QueryBuilder): Promise<void> {
    await onQuery?.(query);
  }
}

const isPage = (query: QueryBuilder): boolean => query instanceof SelectQueryBuilder && query.Table === SCOPE_ATTRIBUTE_TABLE;

/** Runs `write` before the `page`-th page of the copy is read, as a process of the old version writing during the copy would. */
function writeBeforePage(page: number, write: () => Promise<unknown>): () => void {
  let pages = 0;
  onQuery = async (query) => {
    if (isPage(query) && ++pages === page) await write();
  };
  return () => {
    onQuery = undefined;
  };
}

/**
 * Before the `page`-th page of the copy a writer bumps the version in a transaction of its own and keeps it open until
 * the migration sends its next statement on the version table: a 3.x write still in flight when the copy ends. It then
 * commits or rolls back.
 */
function openWriterBeforePage(driver: OrmDriver, page: number, outcome: 'commit' | 'rollback'): { undo: () => void; writer: () => Promise<unknown> } {
  let pages = 0;
  let open = false;
  let writer: Promise<unknown> = Promise.resolve();
  let finish = (): void => undefined;
  onQuery = async (query) => {
    if (open && query.Table === SCOPE_ATTRIBUTE_VERSION_TABLE) {
      open = false;
      // The writer ends while that statement runs: an UPDATE waits for the row, a SELECT answers the old value first.
      setTimeout(finish, 200);
    }
    if (!isPage(query) || ++pages !== page) return;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let bumped = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      bumped = resolve;
    });
    writer = driver
      .transaction(async (tx) => {
        await tx.update().in(SCOPE_ATTRIBUTE_VERSION_TABLE).update({ version: 'written by a 3.x process' }).where({ id: 1 });
        bumped();
        await ended;
        if (outcome === 'rollback') throw new Error('the writer rolls back');
      })
      .catch((e: unknown) => {
        if (outcome === 'commit') throw e;
      });
    await Promise.race([ready, writer]);
    open = true;
  };
  return {
    undo: () => {
      onQuery = undefined;
    },
    writer: () => writer,
  };
}

describe('AuthzScopeAttributeKey_2026_11_25_00_00_00', function () {
  this.timeout(240000);
  let db: TestDb;
  const reachable = new Set<Dialect>(['sqlite', 'pglite']);
  const key = new AuthzScopeAttributeKey_2026_11_25_00_00_00();

  before(async () => {
    if (await TestDb.postgresReachable()) reachable.add('postgres');
    if (await TestDb.mysqlReachable()) reachable.add('mysql');
    db = await TestDb.open({ postgres: reachable.has('postgres'), pglite: true, mysql: reachable.has('mysql') });
    DI.register(CopyHook).as(QueryMiddleware);
    DI.uncache(Array.ofType(QueryMiddleware));
  });

  after(async () => {
    onQuery = undefined;
    DI.unregister(CopyHook);
    DI.uncache(Array.ofType(QueryMiddleware));
    await db?.close();
  });

  it('is registered on the authz connection', () => {
    expect(DI.getRegisteredTypes('__migrations__')).to.include(AuthzScopeAttributeKey_2026_11_25_00_00_00);
    expect(extractMigrationDescriptor(AuthzScopeAttributeKey_2026_11_25_00_00_00)?.Connection).to.equal('authz');
  });

  it('scopeAttributeId is the SHA-256 hex of the JSON array of the three columns', () => {
    expect(scopeAttributeId('org', 'o1', 'a.b')).to.equal(createHash('sha256').update('["org","o1","a.b"]').digest('hex'));
    expect(scopeAttributeId('$global', '', 'tier')).to.match(/^[0-9a-f]{64}$/);
  });

  it('scopeAttributeId gives two different leaves two different ids, whatever their text holds', () => {
    const leaves: readonly (readonly [string, string, string])[] = [
      ['org', 'o1', 'a'],
      ['org', 'o', '1a'],
      ['org', 'o1a', ''],
      ['org', 'o1","a', 'b'],
      ['org', 'o1', 'a","b'],
      ['org', 'o1\u0000', 'a'],
      ['org', 'o1', '\u0000a'],
      ['org', 'o1\\', 'a'],
      ['org', 'o1', '\\a'],
      ['org', '\ud800', 'a'],
      ['org', '\udbff', 'a'],
      ['org', '�', 'a'],
      ...VARIANTS,
    ];
    expect(new Set(leaves.map(([t, i, p]) => scopeAttributeId(t, i, p))).size).to.equal(leaves.length);
  });

  for (const dialect of ['sqlite', 'pglite', 'postgres', 'mysql'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let driver: OrmDriver;

      const dropAll = async (): Promise<void> => {
        for (const t of [SCOPE_ATTRIBUTE_VERSION_TABLE, SCOPE_ATTRIBUTE_TABLE, REBUILT, RESTORED]) await driver.schema().dropTable(t).ifExists();
      };
      const stored = async (): Promise<Row[]> => byLeaf((await driver.select().from(SCOPE_ATTRIBUTE_TABLE)) as Row[]);
      const shape = async (): Promise<{ names: string[]; key: string[] }> => {
        const info = await driver.tableInfo(SCOPE_ATTRIBUTE_TABLE, driver.Options.Database);
        return { names: info.map((c) => c.Name).sort(), key: info.filter((c) => c.PrimaryKey).map((c) => c.Name).sort() };
      };
      /** The table as the 3.x migration leaves it, holding `rows`; resolves with the rows as the driver reads them back. */
      const oldTable = async (rows: readonly Row[] = OLD_ROWS): Promise<Row[]> => {
        await new AuthzScopeAttribute_2026_10_02_00_00_00().up(driver);
        if (rows.length > 0) await driver.insert().into(SCOPE_ATTRIBUTE_TABLE).values([...rows]);
        return await stored();
      };
      const expectKeyed = async (before: readonly Row[]): Promise<void> => {
        expect(await shape()).to.deep.equal({ names: KEYED_COLUMNS, key: ['id'] });
        const after = await stored();
        expect(withoutId(after)).to.deep.equal(before);
        for (const r of after) expect(r.id, leafOf(r)).to.equal(idOf(r));
        for (const t of [REBUILT, RESTORED]) expect(await driver.schema().tableExists(t), t).to.equal(false);
      };

      before(function () {
        if (!reachable.has(dialect)) return this.skip();
        driver = db.driver(dialect);
      });

      beforeEach(dropAll);
      afterEach(dropAll);

      it('gives the table the key id and keeps every row and value', async () => {
        const before = await oldTable();
        await key.up(driver);
        await expectKeyed(before);
        expect((await stored()).find((r) => r.scope_type === '$global')).to.include({ scope_id: '', id: scopeAttributeId('$global', '', 'tier') });
      });

      it('keeps one row per leaf', async () => {
        await oldTable();
        await key.up(driver);
        const twin = { ...OLD_ROWS[2], id: 'f'.repeat(64) };
        expect(
          await failure(async () => {
            await driver.insert().into(SCOPE_ATTRIBUTE_TABLE).values(twin);
          }),
        ).to.be.instanceOf(Error);
        // What a process of the old version sends after the swap: a row without id. It must be refused, not stored.
        expect(
          await failure(async () => {
            await driver.insert().into(SCOPE_ATTRIBUTE_TABLE).values({ ...OLD_ROWS[2], path: 'written.by.3x' });
          }),
          'an insert without id',
        ).to.be.instanceOf(Error);
        expect(await stored()).to.have.length(OLD_ROWS.length);
      });

      it('compares the leaf columns exactly: leaves that differ by case, accent, a trailing blank or normal form stay apart', async () => {
        await oldTable([]);
        await key.up(driver);
        await driver.insert().into(SCOPE_ATTRIBUTE_TABLE).values(VARIANTS.map(variantRow));
        for (const [i, leaf] of VARIANTS.entries()) {
          const [scope_type, scope_id, path] = leaf;
          const rows = (await driver.select().from(SCOPE_ATTRIBUTE_TABLE).where({ scope_type, scope_id, path })) as Row[];
          expect(rows.map((r) => r.id), JSON.stringify(scope_id + '/' + path)).to.deep.equal([variantRow(leaf, i).id]);
        }
      });

      it('down stops before it drops the keyed table when the 3.x key would fold two leaves into one', async () => {
        await oldTable([]);
        await key.up(driver);
        await driver.insert().into(SCOPE_ATTRIBUTE_TABLE).values(VARIANTS.map(variantRow));
        const before = await stored();
        if (dialect !== 'mysql') {
          await key.down(driver);
          expect(withoutId(await stored())).to.deep.equal(withoutId(before));
          return;
        }
        expect(await failure(() => key.down(driver))).to.be.instanceOf(Error);
        expect(await shape()).to.deep.equal({ names: KEYED_COLUMNS, key: ['id'] });
        expect(await stored()).to.deep.equal(before);
      });

      it('copies a table of more rows than one page', async () => {
        const rows = Array.from({ length: 1203 }, (_, i) => ({ scope_type: 'org', scope_id: `o${i % 7}`, path: `k.${i}`, value_json: String(i), value_text: String(i), value_num: i, updated_by: null, updated_at: AT }));
        const before = await oldTable(rows);
        const started = Date.now();
        await key.up(driver);
        console.log(`      ${dialect}: 1203 rows rebuilt in ${Date.now() - started} ms`);
        await expectKeyed(before);
        expect(new Set((await stored()).map((r) => r.id)).size).to.equal(1203);
      });

      it('throws before it drops the old table when a writer changed it during the copy, and the next run completes', async () => {
        const before = await oldTable(pagedRows(501));
        // What DbScopeAttributeStore.bump() does first, in 3.x too.
        const undo = writeBeforePage(2, async () => {
          await driver.update().in(SCOPE_ATTRIBUTE_VERSION_TABLE).update({ version: 'written by a 3.x process' }).where({ id: 1 });
        });
        let error: unknown;
        try {
          error = await failure(() => key.up(driver));
        } finally {
          undo();
        }
        expect(error).to.be.instanceOf(AuthzConfigError).with.property('message', CHANGED_DURING_COPY);
        expect(await shape()).to.deep.equal({ names: LEAF_COLUMNS, key: ['path', 'scope_id', 'scope_type'] });
        expect(await stored()).to.deep.equal(before);
        await key.up(driver);
        await expectKeyed(before);
      });

      for (const outcome of ['commit', 'rollback'] as const) {
        it(`a writer still in its transaction when the copy ends: exactly one of it and the migration wins (writer ${outcome === 'commit' ? 'commits' : 'rolls back'})`, async function () {
          // SQLite and PGlite give a driver one session: the open transaction would hold the copy's own statements back.
          if (dialect === 'sqlite' || dialect === 'pglite') return this.skip();
          const before = await oldTable(pagedRows(501));
          const writer = openWriterBeforePage(driver, 2, outcome);
          let error: unknown;
          try {
            await key.up(driver);
          } catch (e) {
            error = e;
          } finally {
            writer.undo();
            await writer.writer();
          }
          const [version] = (await driver.select().from(SCOPE_ATTRIBUTE_VERSION_TABLE).where({ id: 1 })) as Row[];
          if (outcome === 'commit') {
            expect(error).to.be.instanceOf(AuthzConfigError).with.property('message', CHANGED_DURING_COPY);
            expect(version.version).to.equal('written by a 3.x process');
            expect(await shape()).to.deep.equal({ names: LEAF_COLUMNS, key: ['path', 'scope_id', 'scope_type'] });
            expect(await stored()).to.deep.equal(before);
          } else {
            expect(error).to.equal(undefined);
            expect(version.version).to.match(/^[0-9a-f-]{36}$/);
            await expectKeyed(before);
          }
        });
      }

      it('a second run changes nothing', async () => {
        const before = await oldTable();
        await key.up(driver);
        await key.up(driver);
        await expectKeyed(before);
      });

      it('completes a run that stopped before the old table was dropped', async () => {
        const before = await oldTable();
        await driver.schema().createTable(REBUILT, (table) => {
          table.string('id', 64).notNull().primaryKey();
        });
        await driver.insert().into(REBUILT).values({ id: 'left over' });
        await key.up(driver);
        await expectKeyed(before);
      });

      it('completes a run that stopped after the old table was dropped', async () => {
        const before = await oldTable();
        await key.up(driver);
        await driver.schema().alterTable(SCOPE_ATTRIBUTE_TABLE, (table) => {
          table.rename(REBUILT);
        });
        expect(await driver.schema().tableExists(SCOPE_ATTRIBUTE_TABLE)).to.equal(false);
        await key.up(driver);
        await expectKeyed(before);
      });

      it('down restores the three-column key with every row, and up runs again', async () => {
        const before = await oldTable();
        await key.up(driver);
        await key.down(driver);
        expect(await shape()).to.deep.equal({ names: LEAF_COLUMNS, key: ['path', 'scope_id', 'scope_type'] });
        expect(await stored()).to.deep.equal(before);
        await key.up(driver);
        await expectKeyed(before);
      });

      it('a store write after the migration replaces migrated leaves under their ids', async () => {
        const store = new DbScopeAttributeStore();
        await oldTable();
        await key.up(driver);
        await createChangeLogTables(db, dialect);
        try {
          await driver.transaction((d) => store.write(GLOBAL, { set: { tier: 'silver' }, remove: [] }, ALICE, { driver: d }));
          await driver.transaction((d) => store.write(O1, { set: { 'limits.max': 20, fresh: 'x' }, remove: ['on'] }, ALICE, { driver: d }));
          const rows = await stored();
          expect(Object.fromEntries(rows.map((r) => [leafOf(r), r.value_json]))).to.deep.equal({
            [leafOf({ scope_type: '$global', scope_id: '', path: 'tier' })]: '"silver"',
            [leafOf({ scope_type: 'org', scope_id: 'o1', path: 'limits.max' })]: '20',
            [leafOf({ scope_type: 'org', scope_id: 'o1', path: 'fresh' })]: '"x"',
            [leafOf(OLD_ROWS[3])]: '-2.25',
          });
          for (const r of rows) expect(r.id, leafOf(r)).to.equal(idOf(r));
          expect(await store.get(GLOBAL)).to.deep.equal({ tier: 'silver' });
        } finally {
          await dropChangeLogTables(db, dialect);
        }
      });

      it('the store keeps scopes apart that differ only by case, accent, a trailing blank or normal form', async () => {
        const store = new DbScopeAttributeStore();
        const scopes = [...new Set(VARIANTS.map(([, scopeId]) => scopeId))].map((id): ResourceRef => ({ type: 'org', id }));
        await oldTable([]);
        await key.up(driver);
        await createChangeLogTables(db, dialect);
        try {
          for (const [i, scope] of scopes.entries()) await driver.transaction((d) => store.write(scope, { set: { k: i, [`only.${i}`]: true }, remove: [] }, ALICE, { driver: d }));
          for (const [i, scope] of scopes.entries()) expect(await store.get(scope), JSON.stringify(scope.id)).to.deep.equal({ k: i, only: { [i]: true } });
          await driver.transaction((d) => store.forget(scopes[1], { driver: d }));
          expect(await store.get(scopes[0])).to.deep.equal({ k: 0, only: { 0: true } });
        } finally {
          await dropChangeLogTables(db, dialect);
        }
      });
    });
  }
});
