import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceRef, ScopeAttributeSchema } from '@spinajs/authz';
import { schemaIndex } from '../../../authz/lib/mjs/engine/attributes.js';
import { expect } from 'chai';
import 'mocha';

import { RbacPathSql, RbacScopeDefaults, attr, ident, outer, rbacDialectOf, rsql } from '../../src/orm/index.js';
import type { RbacScopePath } from '../../src/orm/index.js';
import { DB_KINDS } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { adapterAncestors, analyze, bootRulesDb, builtEngineIsFresh, oracle, quoterOf, select, writeAttributes } from './rules-fixture.js';
import type { Row } from './rules-fixture.js';

const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const MISSING = Symbol('missing');

/** The engine's readOwn: own keys only, unsafe segments missing. */
function readOwn(from: unknown, path: readonly string[]): unknown {
  let v = from;
  for (const segment of path) {
    if (UNSAFE.has(segment) || v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return MISSING;
    v = (v as Record<string, unknown>)[segment];
  }
  return v === undefined ? MISSING : v;
}

/** Whether `path` lies strictly below a list in `from` (the SQL reads no list elements). */
function belowList(from: unknown, path: readonly string[]): boolean {
  let v = from;
  for (const segment of path) {
    if (Array.isArray(v)) return true;
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return false;
    v = (v as Record<string, unknown>)[segment];
  }
  return false;
}

const kindOf = (v: unknown): string => (v === MISSING ? 'missing' : v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'object' : `scalar ${JSON.stringify(v)}`);

const entryKind = (e: ReturnType<RbacScopeDefaults['lookup']>): string => (e === undefined ? 'missing' : e.kind === 'scalar' ? `scalar ${e.json}` : e.kind);

class Point {
  constructor(readonly x: number) {}
}

const TRICKY: ScopeAttributeSchema[] = [
  {
    scopeType: 'org',
    schema: {},
    defaults: {
      policies: { locked: false, level: 0, list: [1, 'two', { three: 3 }], nothing: null, obj: {}, deep: { a: { b: 'c' } } },
      when: new Date('2026-01-02T03:04:05.000Z'),
      bad: { nan: Number.NaN, inf: Number.POSITIVE_INFINITY, fn: (() => 1) as unknown, point: new Point(1), badList: [1, undefined], ok: 1 },
      'dotted.key': 1,
      prototype: 2,
      numdef: 2.5,
      neg: -0,
    },
  },
  { scopeType: 'project', schema: {}, defaults: { level: 5 } },
  { scopeType: '$global', schema: {}, defaults: { mode: 'open' } },
];

const PATHS = ['policies', 'policies.locked', 'policies.level', 'policies.list', 'policies.list.0', 'policies.list.2.three', 'policies.nothing', 'policies.obj', 'policies.obj.x', 'policies.deep', 'policies.deep.a', 'policies.deep.a.b', 'policies.deep.a.b.c', 'policies.locked.x', 'when', 'bad', 'bad.nan', 'bad.inf', 'bad.fn', 'bad.point', 'bad.badList', 'bad.ok', 'dotted.key', 'dotted', 'prototype', 'numdef', 'neg', 'level', 'mode', 'missing'];

describe('authz-rbac orm-compile: RbacScopeDefaults', () => {
  it("reads the schema defaults as the engine's schemaIndex merges them", () => {
    const ours = RbacScopeDefaults.of(TRICKY);
    const engine = schemaIndex(TRICKY);
    let compared = 0;
    for (const type of ['org', 'project', '$global', 'team']) {
      for (const path of PATHS) {
        const segments = path.split('.');
        const merged = engine.get(type) ?? {};
        if (belowList(merged, segments)) {
          expect(ours.lookup(type, path), `${type} ${path} lies below a list: read as missing`).to.equal(undefined);
          continue;
        }
        expect(entryKind(ours.lookup(type, path)), `${type} ${path}`).to.equal(kindOf(readOwn(merged, segments)));
        compared++;
      }
    }
    expect(compared).to.be.greaterThan(80);
  });

  it('refuses defaults the engine refuses, and an empty list of schemas gives no defaults', () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 40; i++) cur = cur.k = {} as Record<string, unknown>;
    expect(() => RbacScopeDefaults.of([{ scopeType: 'org', schema: {}, defaults: deep }])).to.throw(AuthzConfigError);
    expect(() => RbacScopeDefaults.of([{ scopeType: 'org', schema: {}, defaults: [] as never }])).to.throw(AuthzConfigError);
    expect(() =>
      RbacScopeDefaults.of([
        { scopeType: 'org', schema: {}, defaults: {} },
        { scopeType: 'org', schema: {}, defaults: {} },
      ]),
    ).to.throw(AuthzConfigError);
    expect(RbacScopeDefaults.of(undefined).lookup('org', 'a')).to.equal(undefined);
  });

  it('takes a layer per scope type; GLOBAL is store unless declared, other types undeclared', () => {
    const d = RbacScopeDefaults.of([], { org: { kind: 'adapter', attributes: ['locked'] }, file: { kind: 'store' } });
    expect(d.layer('$global')).to.deep.equal({ kind: 'store' });
    expect(d.layer('file')).to.deep.equal({ kind: 'store' });
    expect(d.layer('org')).to.deep.equal({ kind: 'adapter', attributes: ['locked'] });
    expect(d.layer('project')).to.equal(undefined);
    expect(() => RbacScopeDefaults.of([], { org: { kind: 'adapter', attributes: [''] } })).to.throw(AuthzConfigError);
    expect(() => RbacScopeDefaults.of([], { org: { kind: 'other' } as never })).to.throw(AuthzConfigError);
  });

  it("the oracle's merge (authz's built attributes.js) is not older than its source", () => {
    const { fresh, built, source } = builtEngineIsFresh();
    expect(fresh, `authz/lib/mjs/engine/attributes.js (${built.toISOString()}) is older than src/engine/attributes.ts (${source.toISOString()}); rebuild authz`).to.equal(true);
  });
});

const ITEM_PATH: RbacScopePath = {
  type: 'file',
  idColumn: 'id',
  scopes: [
    { column: 'project_id', scopeType: 'project' },
    { column: 'org_id', scopeType: 'org' },
  ],
};

const ITEMS: readonly Row[] = [
  { id: 1, project_id: 'p1', org_id: 'o1' },
  { id: 2, project_id: 'p2', org_id: 'o2' },
  { id: 3, project_id: null, org_id: 'o1' },
  { id: 4, project_id: 'p1', org_id: null },
  { id: 5, project_id: 'p3', org_id: '' }, // an empty org id: no node holds attributes there
  { id: 6, project_id: 'p2', org_id: 'o3' }, // an org without rows: defaults only
];

const at = (type: string, id: string): ResourceRef => ({ type, id });

const ATTRIBUTES: ReadonlyArray<readonly [ResourceRef, Record<string, unknown>]> = [
  [at('org', 'o1'), { policies: { locked: true, level: 3, ratio: 0.1234567, big: 1e15, small: 1e-7, list: { replaced: 1 } }, when: 'now', numstr: '3' }],
  [at('org', 'o2'), { policies: 'flat', bad: { ok: 7 } }],
  [at('org', ''), { policies: { locked: true } }], // the type-only scope's key: never read for a row
  [at('project', 'p1'), { level: 1 }],
  [GLOBAL, { mode: 'strict', limit: 10 }],
  [at('file', '1'), { hidden: true }],
];

const ATTR_PATHS: ReadonlyArray<readonly [string, string]> = [...PATHS.map((p) => ['org', p] as const), ['org', 'policies.ratio'], ['org', 'policies.big'], ['org', 'policies.small'], ['org', 'policies.list.replaced'], ['org', 'numstr'], ['project', 'level'], ['project', 'missing'], ['$global', 'mode'], ['$global', 'limit'], ['file', 'hidden'], ['team', 'x']];

for (const kind of DB_KINDS) {
  describe(`authz-rbac orm-compile: attr() on ${kind}`, function () {
    this.timeout(120000);

    let db: TestDb;

    before(async function () {
      db = await bootRulesDb(this, kind, 'l4b_attr');
      await db.driver.schema().createTable('item', (t) => {
        t.int('id').primaryKey().notNull();
        t.string('project_id', 64);
        t.string('org_id', 64);
      });
      await db.driver
        .insert()
        .into('item')
        .values(ITEMS.map((r) => ({ ...r })));
      await writeAttributes(db, ATTRIBUTES);
      await analyze(db.driver, ['item', 'authz_scope_attribute']);
    });

    after(async () => {
      await db?.dispose();
    });

    it("gives each row the value the engine reads at the row's nearest node of the type: present, JSON and number", async () => {
      const p = new RbacPathSql(ITEM_PATH, quoterOf(db.driver));
      const defaults = RbacScopeDefaults.of(TRICKY, { org: { kind: 'store' }, project: { kind: 'store' }, file: { kind: 'store' } });
      const dialect = rbacDialectOf(db.driver);
      const o = oracle(db, TRICKY);
      let present = 0;
      for (const [type, path] of ATTR_PATHS) {
        const a = attr(p, type, path, defaults, dialect);
        const rows = await select(db.driver, rsql`SELECT ${outer('id')} AS rid, CASE WHEN ${a.present} THEN 1 ELSE 0 END AS present, ${a.json} AS json, ${a.num} AS num FROM ${ident('item')} r`);
        const got = new Map(rows.map((r) => [Number(r.rid), r]));
        for (const row of ITEMS) {
          const node = type === GLOBAL.type ? GLOBAL : adapterAncestors(ITEM_PATH, row).find((n) => n.type === type);
          const attrs = node === undefined ? null : await o.attributes(node);
          const segments = path.split('.');
          const value = attrs === null ? MISSING : readOwn(attrs, segments);
          const where = `${type}.${path} on row ${row.id}: engine ${kindOf(value)}`;
          const r = got.get(Number(row.id))!;
          if (attrs !== null && belowList(attrs, segments)) {
            expect(Number(r.present), `${where} (below a list: read as missing)`).to.equal(0);
            continue;
          }
          const isPresent = value !== MISSING && value !== null;
          expect(Number(r.present), where).to.equal(isPresent ? 1 : 0);
          const scalar = isPresent && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
          expect(r.json ?? null, where).to.equal(scalar ? JSON.stringify(value) : null);
          expect(r.num === null || r.num === undefined ? null : Number(r.num), where).to.equal(typeof value === 'number' && isPresent ? value : null);
          if (isPresent) present++;
        }
      }
      expect(present).to.be.greaterThan(40);
    });
  });
}
