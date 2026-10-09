import { AuthzConfigError } from '@spinajs/authz';
import { IdentifierQuoter } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { scopeMatcher } from '../../src/model/native.js';
import { RbacPathSql, ident, outer, rsql } from '../../src/orm/index.js';
import type { RbacScopePath } from '../../src/orm/index.js';
import { DOC_PATH, createSchema as createL2Schema, seed as seedL2 } from '../orm/fixture.js';
import type { BootedDb } from '../orm/fixture.js';
import { CHECK_AT_NODE, CHECK_BELOW, CHECK_NOT_ABOVE, CHECK_ON_PATH, CHECK_ON_PATH_NODE, CHECK_PATH_INDEX, DIALECTS, bootDialect, checkNearestId, evaluatorPath, load, scopeOf, select } from './fixture.js';
import type { BlockCheck, Row, ScopeRow, World } from './fixture.js';

// org → project → file → branch, plus a root org above the org: two org columns give the dedup case.
const BRANCH_PATH: RbacScopePath = {
  type: 'branch',
  idColumn: 'id',
  scopes: [
    { column: 'file_id', scopeType: 'file' },
    { column: 'project_id', scopeType: 'project' },
    { column: 'org_id', scopeType: 'org' },
    { column: 'root_org_id', scopeType: 'org' },
  ],
};

const BRANCHES: readonly Row[] = [
  { id: 1, file_id: 10, project_id: 'p1', org_id: '7', root_org_id: 7 }, // org 7 twice: the nearer column's node wins
  { id: 2, file_id: 11, project_id: 'p1', org_id: '8', root_org_id: 7 },
  { id: 3, file_id: null, project_id: 'p2', org_id: null, root_org_id: 7 }, // NULL columns are no ancestors
  { id: 4, file_id: 12, project_id: '', org_id: '9', root_org_id: null }, // an empty project id
  { id: 5, file_id: 1, project_id: '1', org_id: '1', root_org_id: 1 }, // one value under every type
  { id: 6, file_id: 7, project_id: '7', org_id: '07', root_org_id: 7 }, // '07' is not 7
  { id: 10, file_id: null, project_id: null, org_id: null, root_org_id: null },
  { id: 11, file_id: 110, project_id: 'p11', org_id: '11', root_org_id: 1 }, // ids extending others: 1, 11, 110
  { id: 12, file_id: 12, project_id: 'p1x', org_id: '', root_org_id: 12 },
];

const nodesOf = (row: Row): Array<[string, string]> => [['branch', String(row.id)], ...BRANCH_PATH.scopes.filter((s) => row[s.column] !== null).map((s): [string, string] => [s.scopeType, String(row[s.column])])];

const EXTRA_SCOPES: ReadonlyArray<[string | null, string | null]> = [
  ['$global', ''],
  ['$global', '7'],
  ['branch', ''], // the row type's type-only scope
  ['file', ''],
  ['project', ''],
  ['org', ''],
  ['team', ''],
  ['team', '1'],
  ['file', '999'],
  ['org', '0'],
  ['org', '007'],
  ['project', 'p'],
  ['branch', '01'],
  ['file', '1.0'],
  ['BRANCH', '1'],
  [null, '1'],
  ['org', null],
  ['$global', null],
  [null, null],
];

function scopeRows(): ScopeRow[] {
  const seen = new Set<string>();
  const out: ScopeRow[] = [];
  for (const [type, id] of [...BRANCHES.flatMap(nodesOf), ...EXTRA_SCOPES]) {
    const key = JSON.stringify([type, id]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: out.length + 1, scope_type: type, scope_id: id });
  }
  return out;
}

const BRANCH_WORLD: World = { path: BRANCH_PATH, table: 'branch', scopeTable: 'scope_row', rows: BRANCHES, scopes: scopeRows() };

// Twelve nodes: the index constants reach 10 and 11, where text order ('10' < '9') and integer order differ.
const WIDE_COLUMNS = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10'];

const WIDE_PATH: RbacScopePath = { type: 'leaf', idColumn: 'id', scopes: WIDE_COLUMNS.map((column, i) => ({ column, scopeType: `t${i + 1}` })) };

const wideRow = (id: number, values: ReadonlyArray<number | null>): Row => Object.fromEntries([['id', id], ...WIDE_COLUMNS.map((c, i) => [c, i < 5 ? values[i] : values[i] === null ? null : String(values[i])])]);

const WIDE_ROWS: readonly Row[] = [wideRow(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), wideRow(2, [1, null, 3, null, 5, null, 7, null, 9, 11]), wideRow(3, [null, null, null, null, null, null, null, null, null, 10])];

function wideScopes(): ScopeRow[] {
  const pairs: Array<[string, string]> = [
    ['$global', ''],
    ['leaf', ''],
    ['t10', ''],
    ['t9', '10'],
    ['t10', '9'],
  ];
  for (const row of WIDE_ROWS) {
    pairs.push(['leaf', String(row.id)]);
    for (const s of WIDE_PATH.scopes) if (row[s.column] !== null) pairs.push([s.scopeType, String(row[s.column])]);
  }
  const unique = [...new Map(pairs.map((x) => [JSON.stringify(x), x])).values()];
  return unique.map(([type, id], i) => ({ id: i + 1, scope_type: type, scope_id: id }));
}

const WIDE_WORLD: World = { path: WIDE_PATH, table: 'wide_row', scopeTable: 'wide_scope', rows: WIDE_ROWS, scopes: wideScopes() };

const NEAREST_TYPES = ['branch', 'file', 'project', 'org', 'team', '$global'];

const CHECKS: readonly BlockCheck[] = [CHECK_AT_NODE, CHECK_PATH_INDEX, CHECK_ON_PATH_NODE, CHECK_ON_PATH, CHECK_BELOW, CHECK_NOT_ABOVE, checkNearestId(NEAREST_TYPES)];

async function createTables(driver: OrmDriver): Promise<void> {
  await driver.schema().createTable('branch', (t) => {
    t.int('id').primaryKey().notNull();
    t.int('file_id');
    t.string('project_id', 64);
    t.string('org_id', 64);
    t.int('root_org_id');
  });
  // Nullable here, unlike §9.1, to show a NULL scope column is in no block.
  await driver.schema().createTable('scope_row', (t) => {
    t.int('id').primaryKey().notNull();
    t.string('scope_type', 64);
    t.string('scope_id', 64);
  });
  await driver.schema().createTable('wide_row', (t) => {
    t.int('id').primaryKey().notNull();
    WIDE_COLUMNS.forEach((c, i) => (i < 5 ? t.int(c) : t.string(c, 16)));
  });
  await driver.schema().createTable('wide_scope', (t) => {
    t.int('id').primaryKey().notNull();
    t.string('scope_type', 16).notNull();
    t.string('scope_id', 16).notNull();
  });
  await driver.schema().createTable('prop_row', (t) => {
    t.int('id').primaryKey().notNull();
    t.int('c1');
    t.string('c2', 16);
    t.string('c3', 16);
    t.int('c4');
  });
  await driver.schema().createTable('prop_scope', (t) => {
    t.int('id').primaryKey().notNull();
    t.string('scope_type', 16).notNull();
    t.string('scope_id', 16).notNull();
  });
}

// ---- property: random paths, rows and scopes ----

const TYPES = ['a', 'b', 'c'] as const;
const INT_IDS = [1, 2, 3, 10, 11] as const;
const TEXT_IDS = ['', '1', '2', '3', '10', '11', '01', 'x'] as const;

const pathArb: fc.Arbitrary<RbacScopePath> = fc
  .record({
    type: fc.constantFrom(...TYPES),
    columns: fc.shuffledSubarray(['c1', 'c2', 'c3', 'c4']),
    types: fc.array(fc.constantFrom(...TYPES), { minLength: 4, maxLength: 4 }),
  })
  .map(({ type, columns, types }) => ({ type, idColumn: 'id', scopes: columns.map((column, i) => ({ column, scopeType: types[i] })) }));

const rowsArb = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 12 }),
    c1: fc.option(fc.constantFrom(...INT_IDS), { nil: null }),
    c2: fc.option(fc.constantFrom(...TEXT_IDS), { nil: null }),
    c3: fc.option(fc.constantFrom(...TEXT_IDS), { nil: null }),
    c4: fc.option(fc.constantFrom(...INT_IDS), { nil: null }),
  }),
  { selector: (r) => r.id, minLength: 1, maxLength: 5 },
);

// Scope ids drawn mostly from the rows' own values, so that most runs put scopes on the paths.
const worldArb = fc.tuple(pathArb, rowsArb).chain(([path, rows]) => {
  const values = [
    ...new Set(
      rows.flatMap((r) =>
        Object.values(r)
          .filter((v) => v !== null)
          .map(String),
      ),
    ),
  ];
  const scope = fc.record({ scope_type: fc.constantFrom<string>(...TYPES, '$global', 'z'), scope_id: fc.oneof({ arbitrary: fc.constantFrom(...values), weight: 3 }, { arbitrary: fc.constantFrom<string>(...TEXT_IDS, '12'), weight: 1 }) });
  const scopes = fc.array(scope, { minLength: 1, maxLength: 10 }).map((s) => s.map((x, i): ScopeRow => ({ id: i + 1, ...x })));
  return scopes.map((s): World => ({ path, table: 'prop_row', scopeTable: 'prop_scope', rows, scopes: s }));
});

const SEED = 20261004;
const RUNS = 200;

for (const dialect of DIALECTS) {
  describe(`authz-rbac orm-compile: path blocks on ${dialect[0]}`, function () {
    this.timeout(300000);

    let db: BootedDb;

    before(async function () {
      db = await bootDialect(this, dialect);
      await createTables(db.driver);
      await createL2Schema(db.driver);
      await seedL2(db.driver);
    });

    after(async () => {
      await db?.close();
    });

    describe('org → project → file → branch', () => {
      before(async () => {
        await load(db.driver, BRANCH_WORLD);
      });

      for (const check of CHECKS) {
        it(check.name, async () => {
          expect(await check.run(db.driver, BRANCH_WORLD), 'tuples the block holds for').to.be.greaterThan(0);
        });
      }

      it('the dedup case: org 7 in both org columns sits at the org_id node', async () => {
        const p = new RbacPathSql(BRANCH_PATH, db.driver.Container.resolve(IdentifierQuoter));
        const rows = await select(db.driver, rsql`SELECT ${outer('id')} AS rid, ${p.pathIndex('x')} AS px FROM ${ident('branch')} r, ${ident('scope_row')} ${ident('x')} WHERE ${ident('x', 'scope_type')} = ${'org'} AND ${ident('x', 'scope_id')} = ${'7'}`);
        const px = new Map(rows.map((r) => [Number(r.rid), r.px === null ? null : Number(r.px)]));
        expect(px.get(1)).to.equal(3);
        expect(px.get(2)).to.equal(4);
        expect(px.get(3)).to.equal(4);
        expect(px.get(6)).to.equal(4);
        expect(px.get(4)).to.equal(null);
      });

      it('a NULL scope_type or scope_id is in no block', async () => {
        const p = new RbacPathSql(BRANCH_PATH, db.driver.Container.resolve(IdentifierQuoter));
        const nulls = rsql`(${ident('x', 'scope_type')} IS NULL OR ${ident('x', 'scope_id')} IS NULL)`;
        for (const block of [p.onPath('x'), p.onPathNode('x'), p.below('x', 'y'), p.below('y', 'x'), p.notAbove('x', 'y'), p.notAbove('y', 'x')]) {
          const rows = await select(db.driver, rsql`SELECT ${ident('x', 'id')} AS xid FROM ${ident('branch')} r, ${ident('scope_row')} ${ident('x')}, ${ident('scope_row')} ${ident('y')} WHERE ${nulls} AND ${block}`);
          expect(rows).to.deep.equal([]);
        }
        expect(BRANCH_WORLD.scopes.filter((x) => scopeOf(x) === null)).to.have.length(4);
      });
    });

    describe('a path of twelve nodes', () => {
      before(async () => {
        await load(db.driver, WIDE_WORLD);
      });

      it('has twelve nodes', () => {
        expect(new RbacPathSql(WIDE_PATH, db.driver.Container.resolve(IdentifierQuoter)).nodes).to.have.length(12);
      });

      for (const check of [CHECK_AT_NODE, CHECK_PATH_INDEX, CHECK_ON_PATH_NODE, CHECK_ON_PATH, CHECK_BELOW, CHECK_NOT_ABOVE]) {
        it(check.name, async () => {
          expect(await check.run(db.driver, WIDE_WORLD), 'tuples the block holds for').to.be.greaterThan(0);
        });
      }
    });

    it(`a fast-check property over random paths, rows and scopes (seed ${SEED}, ${RUNS} runs)`, async () => {
      const held = new Map<string, number>();
      await fc.assert(
        fc.asyncProperty(worldArb, async (world) => {
          await load(db.driver, world);
          for (const check of [CHECK_AT_NODE, CHECK_PATH_INDEX, CHECK_ON_PATH_NODE, CHECK_ON_PATH, CHECK_BELOW, CHECK_NOT_ABOVE, checkNearestId([...TYPES, '$global'])]) {
            held.set(check.name, (held.get(check.name) ?? 0) + (await check.run(db.driver, world)));
          }
        }),
        { seed: SEED, numRuns: RUNS },
      );
      for (const [name, n] of held) expect(n, `tuples ${name} held for`).to.be.greaterThan(RUNS);
    });

    it("onPath lists the (doc, assignment) pairs the evaluator's scopeMatcher accepts on L2's fixture", async () => {
      const driver = db.driver;
      const quoter = driver.Container.resolve(IdentifierQuoter);
      const p = new RbacPathSql(DOC_PATH, quoter);
      const docs = (await select(driver, rsql`SELECT ${ident('d', 'id')} AS id, ${ident('d', 'project_id')} AS project_id, ${ident('d', 'org_id')} AS org_id FROM ${ident('doc')} ${ident('d')}`)) as Row[];
      const assignments = (await select(driver, rsql`SELECT ${ident('a', 'id')} AS id, ${ident('a', 'scope_type')} AS scope_type, ${ident('a', 'scope_id')} AS scope_id FROM ${ident('authz_assignment')} ${ident('a')}`)) as Array<{ id: string; scope_type: string; scope_id: string }>;

      const ours = new Set((await select(driver, rsql`SELECT ${outer('id')} AS rid, ${ident('a', 'id')} AS aid FROM ${ident('doc')} r, ${ident('authz_assignment')} ${ident('a')} WHERE ${p.onPath('a')}`)).map((r) => `${Number(r.rid)}/${String(r.aid)}`));

      const reference = new Set<string>();
      for (const d of docs) {
        const path = await evaluatorPath(DOC_PATH, d);
        const onPath = scopeMatcher(DOC_PATH.type, path);
        for (const a of assignments) {
          const scope = scopeOf({ id: 0, scope_type: a.scope_type, scope_id: a.scope_id });
          if (scope && onPath(scope)) reference.add(`${Number(d.id)}/${a.id}`);
        }
      }

      expect([...ours].sort()).to.deep.equal([...reference].sort());
      expect(ours.size).to.be.greaterThan(docs.length);
    });
  });
}

describe('authz-rbac orm-compile: RbacPathSql', () => {
  const quoter = { quote: (n: string) => `"${n}"` } as unknown as IdentifierQuoter;

  it('lists the nodes nearest first: the row, its scope columns, GLOBAL', () => {
    expect(new RbacPathSql(BRANCH_PATH, quoter).nodes).to.deep.equal([{ type: 'branch', column: 'id' }, { type: 'file', column: 'file_id' }, { type: 'project', column: 'project_id' }, { type: 'org', column: 'org_id' }, { type: 'org', column: 'root_org_id' }, { type: '$global' }]);
  });

  it('refuses a path of $global, a scope column of $global and empty names', () => {
    expect(() => new RbacPathSql({ ...BRANCH_PATH, type: '$global' }, quoter)).to.throw(AuthzConfigError);
    expect(() => new RbacPathSql({ ...BRANCH_PATH, scopes: [{ column: 'g', scopeType: '$global' }] }, quoter)).to.throw(AuthzConfigError);
    expect(() => new RbacPathSql({ ...BRANCH_PATH, idColumn: '' }, quoter)).to.throw(AuthzConfigError);
    expect(() => new RbacPathSql({ ...BRANCH_PATH, scopes: [{ column: '', scopeType: 'org' }] }, quoter)).to.throw(AuthzConfigError);
    expect(() => new RbacPathSql({ ...BRANCH_PATH, scopes: [{ column: 'org_id', scopeType: '' }] }, quoter)).to.throw(AuthzConfigError);
  });

  it('refuses an empty alias and a node index off the path', () => {
    const p = new RbacPathSql(BRANCH_PATH, quoter);
    expect(() => p.onPath('')).to.throw(AuthzConfigError);
    expect(() => p.atNode('x', -1)).to.throw(AuthzConfigError);
    expect(() => p.atNode('x', 6)).to.throw(AuthzConfigError);
    expect(() => p.atNode('x', 1.5)).to.throw(AuthzConfigError);
  });
});
