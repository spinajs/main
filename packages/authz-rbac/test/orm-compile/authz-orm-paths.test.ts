import { flattenAttributes, resourceKey, unflattenAttributes } from '@spinajs/authz';
import type { EvaluationContext, ResourceRef, ScopeAttributeSchema } from '@spinajs/authz';
import { AccessResource, AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore, ScopeColumn } from '@spinajs/authz-orm';
import { IdentifierQuoter, ModelBase } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

// The engine merges attribute layers with these but does not export them (rules-fixture.ts guards the build's freshness).
import { mergeAttributes, schemaIndex } from '../../../authz/lib/mjs/engine/attributes.js';
// Not a root export of authz-orm; the build the package resolves to, so one copy of the module.
import { OrmResourceAdapter } from '../../../authz-orm/lib/mjs/adapter.js';
import { unregisterResource } from '../../../authz-orm/lib/mjs/registry.js';
import { resourcePath } from '../../src/model/evaluate.js';
import { scopeMatcher } from '../../src/model/native.js';
import { OrmRbacScopePathSource, RbacPathSql, RbacScopeDefaults, TRUE_SQL, attr, ident, notSql, ormRbacScopeLayers, outer, rbacDialectOf, rsql } from '../../src/orm/index.js';
import type { RbacScopePath, RbacSql } from '../../src/orm/index.js';
import { createCaseInsensitiveCollation } from '../orm/orm-world.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import type { Kind, ModelClass } from '../orm/root-orm.js';
import { scopeOf, select } from './fixture.js';
import type { ScopeRow } from './fixture.js';

const SEED = 20261005;
const RUNS = 40;

const adapter = new OrmResourceAdapter();

/** 1, 0 or NULL. */
const three = (block: RbacSql): RbacSql => rsql`CASE WHEN ${block} THEN 1 WHEN NOT (${block}) THEN 0 END`;
const asThree = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) === 1);

/** The evaluator's path of a row: `resourcePath` over the adapter's own `ancestors`; null when the adapter finds no row. */
async function adapterPath(type: string, id: string): Promise<readonly ResourceRef[] | null> {
  const ref = { type, id };
  const ancestors = await adapter.ancestors(ref);
  if (ancestors === null) return null;
  return resourcePath(ref, { ancestors: async () => ancestors } as unknown as EvaluationContext);
}

const pathSqlOf = (model: ModelClass, driver: OrmDriver): RbacPathSql => new RbacPathSql(new OrmRbacScopePathSource().path(model as never)!, driver.Container.resolve(IdentifierQuoter), rbacDialectOf(driver));

/** Scope columns of each mode, two of them for one type (org), a column the orm does not know (ghost_id). */
const LEAF: Record<Kind, { columns: Record<string, string>; scopes: ReadonlyArray<readonly [string, string]> }> = {
  sqlite: {
    columns: { id: 'INT', n_id: 'INT', s_id: 'TEXT', r_id: 'REAL', b_id: 'BLOB' },
    scopes: [
      ['n_id', 'org'],
      ['s_id', 'org'],
      ['r_id', 'team'],
      ['b_id', 'team'],
      ['ghost_id', 'project'],
    ],
  },
  postgres: {
    columns: { id: 'INT', n_id: 'INT', s_id: 'TEXT', r_id: 'DOUBLE PRECISION', b_id: 'BIGINT', u_id: 'UUID', m_id: 'NUMERIC', j_id: 'JSONB' },
    scopes: [
      ['n_id', 'org'],
      ['s_id', 'org'],
      ['r_id', 'team'],
      ['b_id', 'team'],
      ['u_id', 'project'],
      ['m_id', 'project'],
      ['j_id', 'project'],
      ['ghost_id', 'project'],
    ],
  },
};

const MODES: Record<Kind, RbacScopePath> = {
  sqlite: {
    type: 'leaf',
    idColumn: 'id',
    idMode: 'number',
    scopes: [
      { column: 'n_id', scopeType: 'org', idMode: 'number' },
      { column: 's_id', scopeType: 'org', idMode: 'string' },
      { column: 'r_id', scopeType: 'team', idMode: 'number' },
      { column: 'b_id', scopeType: 'team', idMode: 'none' },
      { column: 'ghost_id', scopeType: 'project', idMode: 'none' },
    ],
    earlierKeys: [],
  },
  postgres: {
    type: 'leaf',
    idColumn: 'id',
    idMode: 'number',
    scopes: [
      { column: 'n_id', scopeType: 'org', idMode: 'number' },
      { column: 's_id', scopeType: 'org', idMode: 'string' },
      { column: 'r_id', scopeType: 'team', idMode: 'number' },
      { column: 'b_id', scopeType: 'team', idMode: 'text' },
      { column: 'u_id', scopeType: 'project', idMode: 'text' },
      { column: 'm_id', scopeType: 'project', idMode: 'text' },
      { column: 'j_id', scopeType: 'project', idMode: 'none' },
      { column: 'ghost_id', scopeType: 'project', idMode: 'none' },
    ],
    earlierKeys: [],
  },
};

const UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

/** Values per column, as the dialect can store them: text in an integer column, unsafe integers, reals, '', NULL, case variants. */
const VALUES: Record<Kind, Record<string, readonly unknown[]>> = {
  sqlite: {
    n_id: [null, 7, 0, -3, 9007199254740991, 9007199254740992, 1152921504606846976, 1.5, 'abc', '7', '', 'o1'],
    s_id: [null, 'o1', 'O1', '', '7', ' 7', 'ż', 7, 1.5, 'abc'],
    r_id: [null, 1.5, 5, -0, 1e15, 9007199254740992, 'abc', 0.30000000000000004, 7],
    b_id: [null, 'x', 7],
  },
  postgres: {
    n_id: [null, 7, 0, -3, 2147483647],
    s_id: [null, 'o1', 'O1', '', '7', ' 7', 'ż', 'abc', '1.5'],
    r_id: [null, 1.5, 5, -0, 1e15, 9007199254740991, 9007199254740992, 1e300, 'NaN', 'Infinity', 7, 0.30000000000000004],
    b_id: [null, '7', '9007199254740993', '-9223372036854775808', '0'],
    u_id: [null, UUID, '00000000-0000-0000-0000-000000000007'],
    m_id: [null, '1.50', '7', 'NaN', '0.30000000000000004', '-3'],
    j_id: [null, '"7"', '7'],
  },
};

const X_IDS = ['7', '07', '7.0', '5', '5.0', '1.5', '0', '-0', '-3', '1', '2', '3', '1000000000000000', '1e+15', '9007199254740991', '9007199254740992', '9007199254740993', '1152921504606846976', '2147483647', 'abc', 'o1', 'O1', '', ' 7', 'ż', 'x', '0.3', '0.30000000000000004', '1.50', 'NaN', 'Infinity', UUID, UUID.toUpperCase(), '00000000-0000-0000-0000-000000000007', '-9223372036854775808', '"7"'];
const X_TYPES = ['leaf', 'org', 'team', 'project', '$global', 'other'];

function scopeRows(): ScopeRow[] {
  const out: ScopeRow[] = [];
  for (const type of X_TYPES) for (const id of X_IDS) out.push({ id: out.length + 1, scope_type: type, scope_id: id });
  out.push({ id: out.length + 1, scope_type: null, scope_id: '7' }, { id: out.length + 2, scope_type: 'org', scope_id: null });
  return out;
}

/** A finite, safe number that is no integer, in a number-mode column: the SQL names no node by it (documented, narrower). */
const NUMBER_COLUMNS = ['n_id', 'r_id'];
const inexact = (row: Readonly<Record<string, unknown>>): boolean => NUMBER_COLUMNS.some((c) => typeof row[c] === 'number' && Number.isFinite(row[c]) && !Number.isInteger(row[c]));

describe('authz-rbac orm-compile: paths and attribute layers from authz-orm', function () {
  this.timeout(600000);

  let db: RootOrm;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_paths');
  });

  after(async () => {
    await db?.close();
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      const driver = () => db.driver(kind);

      describe('id modes', () => {
        let Leaf: ModelClass;
        const scopes = scopeRows();

        before(async () => {
          Leaf = await db.define(
            {
              name: 'Leaf',
              columns: LEAF[kind].columns,
              decorate: (cls, proto) => {
                AccessResource('leaf')(cls);
                for (const [column, type] of LEAF[kind].scopes) ScopeColumn(column, type)(proto, column === 'ghost_id' ? 'ghost' : column);
              },
            },
            kind,
          );
          await driver()
            .schema()
            .createTable('id_scope', (t) => {
              t.int('id').primaryKey().notNull();
              t.string('scope_type', 64);
              t.string('scope_id', 64);
            });
          await driver()
            .insert()
            .into('id_scope')
            .values(scopes.map((s) => ({ ...s })));
        });

        after(async () => {
          await db.clear();
          await db.raw(kind, 'DROP TABLE IF EXISTS "id_scope"');
        });

        it('the default path source reads each column id mode', () => {
          expect(new OrmRbacScopePathSource().path(Leaf as never)).to.deep.equal(MODES[kind]);
        });

        it(`onPathNode, onPath and nearestId match the adapter's ancestors() for random column values (fast-check, seed ${SEED}, ${RUNS} runs)`, async () => {
          const p = pathSqlOf(Leaf, driver());
          const table = db.table(Leaf);
          const columns = Object.keys(VALUES[kind]);
          const rowArb = fc.record(Object.fromEntries(columns.map((c) => [c, fc.constantFrom(...VALUES[kind][c])])) as Record<string, fc.Arbitrary<unknown>>);
          const types = ['leaf', 'org', 'team', 'project'];
          let held = 0;
          let exactRows = 0;
          await fc.assert(
            fc.asyncProperty(fc.array(rowArb, { minLength: 3, maxLength: 3 }), async (values) => {
              await db.clearRows(Leaf);
              const rows = values.map((v, i) => ({ id: i + 1, ...v }));
              await db.insert(Leaf, rows);
              const pairs = await select(driver(), rsql`SELECT ${outer('id')} AS rid, ${ident('x', 'id')} AS xid, ${three(p.onPathNode('x'))} AS node, ${three(p.onPath('x'))} AS onpath, ${three(p.whenFound(p.onPath('x')))} AS guarded, ${three(notSql(p.whenFound(p.onPath('x'))))} AS negated FROM ${ident(table)} r, ${ident('id_scope')} ${ident('x')}`);
              const nearest = await select(driver(), rsql`SELECT ${outer('id')} AS rid, ${rsql`${joinColumns(types.map((t, i) => rsql`${p.nearestId(t)} AS ${ident(`n${i}`)}`))}`} FROM ${ident(table)} r`);
              for (const row of rows) {
                const path = await adapterPath('leaf', String(row.id));
                expect(path, `the adapter finds row ${row.id}`).to.not.equal(null);
                const keys = new Set(path!.map(resourceKey));
                const matcher = scopeMatcher('leaf', path!);
                const exact = !inexact(row);
                if (exact) exactRows++;
                for (const x of scopes) {
                  const got = pairs.find((r) => Number(r.rid) === row.id && Number(r.xid) === x.id)!;
                  const scope = scopeOf(x);
                  const want = { node: scope !== null && keys.has(resourceKey(scope)), onpath: scope !== null && matcher(scope) };
                  const at = `${kind} row ${JSON.stringify(row)} x ${JSON.stringify(x)}`;
                  for (const block of ['node', 'onpath'] as const) {
                    const sql = asThree(got[block]);
                    expect(sql, `${block} is two-valued: ${at}`).to.not.equal(null);
                    if (sql) expect(want[block], `${block} lists no scope the adapter does not: ${at}`).to.equal(true);
                    if (exact) expect(sql, `${block}: ${at}`).to.equal(want[block]);
                    if (sql) held++;
                  }
                  // The term's three values: exact for a row whenFound lets through, UNKNOWN under NOT as well otherwise.
                  expect(asThree(got.guarded), `whenFound(onPath): ${at}`).to.equal(exact ? want.onpath : null);
                  expect(asThree(got.negated), `NOT whenFound(onPath): ${at}`).to.equal(exact ? !want.onpath : null);
                }
                const got = nearest.find((r) => Number(r.rid) === row.id)!;
                types.forEach((t, i) => {
                  const want = path!.find((n) => n.type === t && n.id != null)?.id ?? null;
                  const sql = got[`n${i}`] ?? null;
                  if (exact || sql !== null) expect(sql, `nearestId(${t}) ${kind} ${JSON.stringify(row)}`).to.equal(want);
                });
              }
            }),
            { seed: SEED, numRuns: RUNS },
          );
          expect(held, 'tuples the blocks hold for').to.be.greaterThan(RUNS * 3 * 4);
          expect(exactRows, 'rows without an inexact number').to.be.greaterThan(RUNS);
        });

        it('whenFound: UNKNOWN exactly where the adapter cannot find the row by its id', async () => {
          const Odd = await db.define(
            {
              name: 'Odd',
              columns: { id: kind === 'sqlite' ? 'INT' : 'NUMERIC', o_id: 'TEXT' },
              rows: (kind === 'sqlite' ? [1, 'abc', 1.5, 9007199254740992, -0, ''] : ['1.50', 'NaN', '7', '-0.5', 'Infinity']).map((id) => ({ id, o_id: 'o1' })),
              decorate: (cls, proto) => {
                AccessResource('odd')(cls);
                ScopeColumn('o_id', 'org')(proto, 'o_id');
              },
            },
            kind,
          );
          const p = pathSqlOf(Odd, driver());
          const rows = await select(driver(), rsql`SELECT ${outer('id')} AS rid, ${three(p.whenFound(TRUE_SQL))} AS found FROM ${ident(db.table(Odd))} r`);
          let unknown = 0;
          for (const r of rows) {
            const path = await adapterPath('odd', String(r.rid));
            const found = asThree(r.found);
            // A non-integer key the adapter finds is UNKNOWN too: no block names it.
            const nonInteger = typeof r.rid === 'number' && !Number.isInteger(r.rid);
            expect(found, `${kind} id ${JSON.stringify(r.rid)}`).to.equal(path === null || nonInteger ? null : true);
            if (found === null) unknown++;
          }
          expect(unknown).to.be.at.least(2);

          // A later model of the type: findRow takes Odd's row for an id Odd holds, so that row is UNKNOWN here.
          const Later = await db.define(
            {
              name: 'OddLater',
              columns: { id: kind === 'sqlite' ? 'INT' : 'NUMERIC', o_id: 'TEXT' },
              rows: (kind === 'sqlite' ? [1, 50, 2.5] : ['7', '8']).map((id) => ({ id, o_id: 'o1' })),
              decorate: (cls, proto) => {
                AccessResource('odd')(cls);
                ScopeColumn('o_id', 'org')(proto, 'o_id');
              },
            },
            kind,
          );
          const oddIds = new Set<string>();
          for (const r of await select(driver(), rsql`SELECT ${outer('id')} AS rid FROM ${ident(db.table(Odd))} r`)) if ((await adapterPath('odd', String(r.rid))) !== null) oddIds.add(String(r.rid));
          const later = pathSqlOf(Later, driver());
          expect(later.path.earlierKeys).to.have.length(1);
          const laterRows = await select(driver(), rsql`SELECT ${outer('id')} AS rid, ${three(later.whenFound(TRUE_SQL))} AS found FROM ${ident(db.table(Later))} r`);
          const got = new Map(laterRows.map((r) => [String(r.rid), asThree(r.found)]));
          expect(Object.fromEntries(got)).to.deep.equal(kind === 'sqlite' ? { '1': null, '50': true, '2.5': null } : { '7': null, '8': true });
          for (const [id, found] of got) if (oddIds.has(id)) expect(found, `${kind} ${id} is Odd's`).to.equal(null);
          // An earlier model this connection cannot read makes every row UNKNOWN.
          const blind = new RbacPathSql({ ...later.path, earlierKeys: [null] }, driver().Container.resolve(IdentifierQuoter), rbacDialectOf(driver()));
          const blindRows = await select(driver(), rsql`SELECT ${three(blind.whenFound(TRUE_SQL))} AS found FROM ${ident(db.table(Later))} r`);
          expect(blindRows.map((r) => asThree(r.found))).to.deep.equal(blindRows.map(() => null));
        });
      });

      describe('attribute layers', () => {
        const SCHEMAS: ScopeAttributeSchema[] = [
          { scopeType: 'org', schema: {}, defaults: { locked: false, tier: 'free', meta: { a: 1 }, metaX: 'mx', lockedX: 'lx' } },
          { scopeType: 'team', schema: {}, defaults: { x: 'dx', y: 'dy' } },
          { scopeType: 'zone', schema: {}, defaults: { z: 1 } },
        ];
        const READS: ReadonlyArray<readonly [string, string]> = [...['locked', 'locked.x', 'lockedX', 'meta', 'meta.a', 'meta.b', 'metaX', 'tier', 'missing'].map((path) => ['org', path] as const), ['team', 'x'], ['team', 'y'], ['zone', 'z']];
        /** Reads the SQL refuses by the layers authz-orm gives: an adapter attribute, a type of two models, a type no model serves. */
        const layerFault = (type: string, path: string): boolean => type === 'team' || type === 'zone' || ['locked', 'meta'].some((name) => path === name || path.startsWith(`${name}.`));
        let Item: ModelClass;
        let store: DbScopeAttributeStore;

        before(async () => {
          await new AuthzScopeAttribute_2026_10_02_00_00_00().up(driver());
          const ci = kind === 'postgres' ? await createCaseInsensitiveCollation(driver()) : '';
          await db.define(
            {
              name: 'Org',
              // A case-insensitive key: findRow finds 'o1' for 'O1', then refuses it (idText differs).
              columns: { id: kind === 'sqlite' ? 'TEXT COLLATE NOCASE' : `TEXT COLLATE ${ci}`, locked: 'INT', meta: kind === 'sqlite' ? 'JSON' : 'JSONB' },
              rows: [
                { id: 'o1', locked: 1, meta: '{"a":2}' },
                { id: 'o2', locked: 0, meta: null },
              ],
              decorate: (cls) => AccessResource('org', { attributes: ['locked', 'meta'] })(cls),
            },
            kind,
          );
          await db.define({ name: 'TeamA', columns: { id: 'TEXT', x: 'TEXT' }, rows: [{ id: 't1', x: 'one' }], decorate: (cls) => AccessResource('team', { attributes: ['x'] })(cls) }, kind);
          await db.define({ name: 'TeamB', columns: { id: 'TEXT', x: 'TEXT' }, rows: [{ id: 't2', x: 'two' }], decorate: (cls) => AccessResource('team', { attributes: ['x'] })(cls) }, kind);
          Item = await db.define(
            {
              name: 'Item',
              columns: { id: 'INT', org_id: 'TEXT', team_id: 'TEXT', zone_id: 'TEXT' },
              rows: [
                { id: 1, org_id: 'o1', team_id: 't1', zone_id: 'z1' },
                { id: 2, org_id: 'o2', team_id: 't2', zone_id: null },
                { id: 3, org_id: 'o3', team_id: null, zone_id: 'z1' }, // no row for org o3
                { id: 4, org_id: null, team_id: 't1', zone_id: 'z1' },
                { id: 5, org_id: '', team_id: '', zone_id: '' },
                { id: 6, org_id: 'O1', team_id: null, zone_id: null }, // org 'o1' only in another case
              ],
              decorate: (cls, proto) => {
                AccessResource('item')(cls);
                ScopeColumn('org_id', 'org')(proto, 'org_id');
                ScopeColumn('team_id', 'team')(proto, 'team_id');
                ScopeColumn('zone_id', 'zone')(proto, 'zone_id');
              },
            },
            kind,
          );
          store = new DbScopeAttributeStore({ connection: RootOrm.connectionOf(kind) });
          await driver().transaction(async (tx: OrmDriver) => {
            for (const [ref, attributes] of [
              [
                { type: 'org', id: 'o1' },
                { tier: 'gold', meta: { b: 3 } },
              ],
              [{ type: 'org', id: 'o2' }, { metaX: 'stored' }],
              [{ type: 'team', id: 't1' }, { y: 'stored' }],
              [{ type: 'zone', id: 'z1' }, { z: 5 }],
            ] as const) {
              await store.write(ref, { set: flattenAttributes(attributes).set, remove: [] }, { type: 'user', id: 'root' }, { driver: tx });
            }
          });
        });

        after(async () => {
          await db.clear();
          await new AuthzScopeAttribute_2026_10_02_00_00_00().down(driver());
        });

        it('a type of one model reads with an exists test, one of several models and an unserved type fault', () => {
          const layers = ormRbacScopeLayers(driver());
          expect(layers.org).to.include({ kind: 'adapter' });
          expect((layers.org as { attributes: readonly string[] }).attributes).to.deep.equal(['locked', 'meta']);
          expect((layers.org as { exists?: unknown }).exists).to.be.a('function');
          expect(layers.team).to.deep.equal({ kind: 'adapter', attributes: ['x'] });
          expect(layers.item).to.include({ kind: 'adapter' });
          expect(Object.hasOwn(layers, 'zone')).to.equal(false);
          // A model whose table or key cannot be read leaves its type out, and only its type.
          class NoTable extends ModelBase {}
          AccessResource('broken')(NoTable);
          try {
            const withBroken = ormRbacScopeLayers(driver());
            expect(Object.hasOwn(withBroken, 'broken')).to.equal(false);
            expect(Object.keys(withBroken).sort()).to.deep.equal(Object.keys(layers).sort());
          } finally {
            unregisterResource(NoTable);
          }
          // A model on another connection gets no exists test either.
          expect((ormRbacScopeLayers(db.driver(kind === 'sqlite' ? 'postgres' : 'sqlite')).org as { exists?: unknown }).exists).to.equal(undefined);
        });

        it("attr() gives the engine's value (defaults ⊕ adapter ⊕ store) or a fault where the layer is not readable in SQL", async () => {
          const p = pathSqlOf(Item, driver());
          const defaults = RbacScopeDefaults.of(SCHEMAS, ormRbacScopeLayers(driver()));
          const index = schemaIndex(SCHEMAS);
          let decided = 0;
          for (const [type, path] of READS) {
            const a = attr(p, type, path, defaults, rbacDialectOf(driver()));
            const rows = await select(driver(), rsql`SELECT ${outer('id')} AS rid, ${three(a.present)} AS present, ${a.json} AS json FROM ${ident(db.table(Item))} r`);
            for (const r of rows) {
              const at = `${kind} item ${String(r.rid)} scope.${type}.${path}`;
              const present = asThree(r.present);
              expect(present, `present is two-valued: ${at}`).to.not.equal(null);
              const node = (await adapterPath('item', String(r.rid)))!.find((n) => n.type === type && n.id != null);
              const engine = node === undefined ? undefined : await engineValue(node, path);
              if (layerFault(type, path)) {
                expect(present, `a layer fault: ${at}`).to.equal(false);
                continue;
              }
              const has = engine !== undefined && engine !== null && engine !== FAULT;
              expect(present, `${at}: engine ${JSON.stringify(engine)}`).to.equal(has);
              const scalar = has && (typeof engine === 'string' || typeof engine === 'number' || typeof engine === 'boolean');
              expect(r.json ?? null, at).to.equal(scalar ? JSON.stringify(engine) : null);
              if (has) decided++;
            }
          }
          expect(decided).to.be.at.least(6);

          async function engineValue(node: ResourceRef, path: string): Promise<unknown> {
            const own = adapter.types.includes(node.type) ? await adapter.scopeAttributes(node) : {};
            if (own === null) return FAULT;
            let v: unknown = mergeAttributes([index.get(node.type) ?? {}, own, unflattenAttributes(await store.rows(node))]);
            for (const s of path.split('.')) v = v !== null && typeof v === 'object' && Object.hasOwn(v, s) ? (v as Record<string, unknown>)[s] : undefined;
            return v;
          }
        });

        it('reads the engine refuses or cannot reach stay faults: below an adapter attribute, a missing node row, an empty id', async () => {
          const p = pathSqlOf(Item, driver());
          const defaults = RbacScopeDefaults.of(SCHEMAS, ormRbacScopeLayers(driver()));
          const read = async (path: string) => {
            const a = attr(p, 'org', path, defaults, rbacDialectOf(driver()));
            const rows = await select(driver(), rsql`SELECT ${outer('id')} AS rid, ${three(a.present)} AS present, ${a.json} AS json FROM ${ident(db.table(Item))} r`);
            return new Map(rows.map((r) => [Number(r.rid), { present: asThree(r.present), json: r.json ?? null }]));
          };
          // The adapter's meta is { a: 2 }, the default { a: 1 }: reading the default would be wrong.
          expect((await read('meta.a')).get(1)).to.deep.equal({ present: false, json: null });
          expect((await read('lockedX')).get(1)).to.deep.equal({ present: true, json: '"lx"' });
          expect((await read('metaX')).get(2)).to.deep.equal({ present: true, json: '"stored"' });
          expect((await read('tier')).get(1)).to.deep.equal({ present: true, json: '"gold"' });
          for (const id of [3, 4, 5, 6]) expect((await read('tier')).get(id), `item ${id}`).to.deep.equal({ present: false, json: null });
        });
      });
    });
  }
});

const FAULT = Symbol('fault');

function joinColumns(parts: readonly RbacSql[]): RbacSql {
  return parts.slice(1).reduce((acc, part) => rsql`${acc}, ${part}`, parts[0]);
}
