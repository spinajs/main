import { AuthzAdminFailure, AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { Condition, ResourceRef, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { RbacPathSql, RbacScopeDefaults, attr, ident, liveRule, outer, rbacDialectOf, rsql, ruleOnPath, storedListHas, storedPermission, storedResource, storedTypeIn, storedWhen, storedWhenMissing } from '../../src/orm/index.js';
import type { RbacResourceField, RbacScopeLayer, RbacScopePath, RbacSql } from '../../src/orm/index.js';
import { toSqlForm } from '../../src/index.js';
import { DB_KINDS } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { KIT_LADDERS } from '../support/rules.js';
import { NOW, RULE, adapterAncestors, analyze, asThree, bootRulesDb, clear, coreResource, coreWhen, oracle, quoterOf, select, storedRules, three, writeAttributes, writeRules } from './rules-fixture.js';
import type { CoreTruth, Oracle, Row, Three } from './rules-fixture.js';

type Rule = Omit<RuleDef, 'source'>;

const ITEM_PATH: RbacScopePath = {
  type: 'file',
  idColumn: 'id',
  scopes: [
    { column: 'project_id', scopeType: 'project' },
    { column: 'org_id', scopeType: 'org' },
  ],
};

/** `title` is a model property the adapter reads from the `label` column. */
const FIELDS: readonly RbacResourceField[] = [
  { field: 'name', column: 'name' },
  { field: 'label', column: 'label' },
  { field: 'title', column: 'label' },
];

const STORE: Readonly<Record<string, RbacScopeLayer>> = { org: { kind: 'store' }, project: { kind: 'store' }, file: { kind: 'store' } };

const at = (type: string, id: string): ResourceRef => ({ type, id });

const SCHEMAS: ScopeAttributeSchema[] = [
  { scopeType: 'org', schema: {}, defaults: { policies: { locked: false, level: 0, list: [1, 2], nothing: null, obj: {} }, def: 'd', numdef: 2.5, tier: 'free' } },
  { scopeType: 'project', schema: {}, defaults: { level: 5 } },
  { scopeType: '$global', schema: {}, defaults: { mode: 'open' } },
];

const ATTRIBUTES: ReadonlyArray<readonly [ResourceRef, Record<string, unknown>]> = [
  [at('org', 'o1'), { policies: { locked: true, level: 3, tier: 'gold', ratio: 0.1234567, big: 1e15, neg: -2.5, numstr: '3', numstr2: '03', empty: '', uni: 'żółw', small: 1e-7, one: 1, zero: 0 }, flag: false }],
  [at('org', 'o2'), { policies: { locked: false }, tier: 'silver' }],
  [at('org', ''), { policies: { locked: true } }],
  [at('project', 'p1'), { level: 1, owner: 'x' }],
  [GLOBAL, { mode: 'strict', limit: 10 }],
  [at('file', '1'), { hidden: true }],
];

const LONG = 'n'.repeat(5000);

const ITEMS: readonly Row[] = [
  { id: 1, project_id: 'p1', org_id: 'o1', name: 'release/1', label: 'Release/1', size: 1 },
  { id: 2, project_id: 'p2', org_id: 'o2', name: 'release/1/hotfix', label: 'a%b', size: 2 },
  { id: 3, project_id: null, org_id: 'o1', name: 'a_b', label: 'aXb', size: 3 },
  { id: 4, project_id: 'p1', org_id: null, name: 'a\\b', label: null, size: 4 },
  { id: 5, project_id: 'p3', org_id: '', name: 'x*y', label: '[x]?', size: 5 },
  { id: 6, project_id: 'p2', org_id: 'o3', name: 'żółw/ż', label: 'release', size: 6 },
  { id: 7, project_id: '', org_id: 'o9', name: LONG, label: `${LONG.slice(0, 100)}/x`, size: 7 },
  { id: 8, project_id: 'p1', org_id: 'o1', name: null, label: 'release/', size: 8 },
];

const WHEN_PATHS = ['scope.org.policies.locked', 'scope.org.policies.level', 'scope.org.policies.tier', 'scope.org.policies.ratio', 'scope.org.policies.big', 'scope.org.policies.neg', 'scope.org.policies.numstr', 'scope.org.policies.numstr2', 'scope.org.policies.empty', 'scope.org.policies.uni', 'scope.org.policies.small', 'scope.org.policies.one', 'scope.org.policies.zero', 'scope.org.policies', 'scope.org.policies.list', 'scope.org.policies.list.0', 'scope.org.policies.nothing', 'scope.org.policies.obj', 'scope.org.policies.locked.x', 'scope.org.flag', 'scope.org.def', 'scope.org.numdef', 'scope.org.tier', 'scope.org.missing', 'scope.project.level', 'scope.project.owner', 'scope.$global.mode', 'scope.$global.limit', 'scope.file.hidden', 'scope.team.x'];

const LITERALS: readonly (string | number | boolean)[] = [true, false, 0, 1, 3, 2.5, -2.5, 0.123457, 0.1234567, 1e15, 1e-7, 10, 'gold', 'x', '', 'żółw', 'abc', 'strict', 'd', 'free'];
const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;

/** Every (path, op, literal) toSqlForm accepts, as restrict rules at GLOBAL. */
function whenRules(paths: readonly string[], literals: readonly (string | number | boolean)[], prefix = 'w'): Rule[] {
  const out: Rule[] = [];
  let n = 0;
  const add = (when: Condition) => {
    const rule: Rule = { id: `${prefix}${++n}`, kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'alice' }], when };
    try {
      toForm(rule);
      out.push(rule);
    } catch (e) {
      if (!(e instanceof AuthzAdminFailure)) throw e;
    }
  };
  for (const path of paths) {
    for (const op of OPS) for (const literal of literals) add({ attr: path, [op]: literal } as Condition);
    add({ attr: path, null: true } as Condition);
    add({ attr: path, null: false } as Condition);
  }
  return out;
}

const toForm = (r: Rule) => toSqlForm(r, KIT_LADDERS);

/** SQL may answer UNKNOWN where the core decides a string attribute against a number literal (it cannot read a numeric string's canonical form). */
async function exempt(when: Condition, row: Row, o: Oracle): Promise<boolean> {
  const c = when as Record<string, unknown>;
  const op = Object.keys(c).find((k) => k !== 'attr')!;
  if (op === 'null' || typeof c[op] !== 'number') return false;
  const [, type, ...path] = String(c.attr).split('.');
  const node = type === GLOBAL.type ? GLOBAL : adapterAncestors(ITEM_PATH, row).find((x) => x.type === type);
  const attrs = node === undefined ? null : await o.attributes(node);
  let v: unknown = attrs;
  for (const s of path) v = v !== null && typeof v === 'object' && Object.hasOwn(v, s) ? (v as Record<string, unknown>)[s] : undefined;
  return typeof v === 'string';
}

/** Paths below a list default: the SQL reads no list elements and takes them as missing. */
const belowList = (attrPath: string): boolean => attrPath.startsWith('scope.org.policies.list.');

/** SQL must be the core's answer; UNKNOWN or a throw is NULL; `exempt` cases may be NULL instead. */
function expectThree(sql: Three, core: CoreTruth, exemptCase: boolean, where: string): void {
  const want: Three = core === true ? true : core === false ? false : null;
  if (exemptCase && sql === null) return;
  expect(sql, `${where}: core ${String(core)}`).to.equal(want);
}

async function whenTable(driver: TestDb['driver'], block: RbacSql): Promise<Map<string, Three>> {
  const rows = await select(driver, rsql`SELECT ${outer('id')} AS rid, ${ident(RULE, 'id')} AS rule, ${three(block)} AS v FROM ${ident('item')} r, ${ident('authz_rule')} ${ident(RULE)}`);
  return new Map(rows.map((r) => [`${Number(r.rid)}/${String(r.rule)}`, asThree(r.v)]));
}

const RESOURCE_PATTERNS: ReadonlyArray<readonly ['glob' | 'wildcard', string]> = [
  ['glob', 'release/*'],
  ['glob', 'release/**'],
  ['glob', 'Release/*'],
  ['glob', 'release'],
  ['glob', 'release/'],
  ['wildcard', 'rel*'],
  ['wildcard', '*/1'],
  ['wildcard', 'a%b'],
  ['wildcard', 'a_b'],
  ['wildcard', 'a\\b'],
  ['wildcard', 'x*y'],
  ['glob', 'x*'],
  ['wildcard', '*'],
  ['glob', '**'],
  ['glob', '*'],
  ['wildcard', '[x]?'],
  ['wildcard', 'żółw*'],
  ['wildcard', `${'n'.repeat(10)}*`],
  ['glob', 'n*'],
];

const RULE_FIELDS = ['name', 'label', 'title', 'size', 'nope'];

function resourceRules(): Rule[] {
  const out: Rule[] = [];
  let n = 0;
  for (const field of RULE_FIELDS) {
    for (const [op, pattern] of RESOURCE_PATTERNS) out.push({ id: `res${++n}`, kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'alice' }], resource: { attr: `resource.${field}`, [op]: pattern } as Condition });
  }
  out.push({ id: 'res-none', kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'alice' }] });
  return out;
}

for (const kind of DB_KINDS) {
  describe(`authz-rbac orm-compile: stored rule blocks on ${kind}`, function () {
    this.timeout(600000);

    let db: TestDb;
    let p: RbacPathSql;
    let o: Oracle;
    const defaults = RbacScopeDefaults.of(SCHEMAS, STORE);
    const items = () => (kind === 'postgres' ? ITEMS : [...ITEMS, { id: 9, project_id: 'p1', org_id: 'o1', name: 'release/1\u0000x', label: 'nul', size: 9 }]);

    before(async function () {
      db = await bootRulesDb(this, kind, 'l4b_rules');
      await db.driver.schema().createTable('item', (t) => {
        t.int('id').primaryKey().notNull();
        t.string('project_id', 64);
        t.string('org_id', 64);
        t.text('name');
        t.text('label');
        t.int('size');
      });
      await db.driver.schema().createTable('probe', (t) => {
        t.int('id').primaryKey().notNull();
        t.string('t', 64);
      });
      await db.driver
        .insert()
        .into('item')
        .values(items().map((r) => ({ ...r })));
      await writeAttributes(db, ATTRIBUTES);
      p = new RbacPathSql(ITEM_PATH, quoterOf(db.driver));
      o = oracle(db, SCHEMAS);
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await clear(db.driver, ['authz_rule_subject', 'authz_rule']);
    });

    describe('storedWhen / storedWhenMissing', () => {
      it('storedWhen is TRUE, FALSE or NULL as the core decides the rule when (UNKNOWN and B39 throws are NULL)', async () => {
        const rules = whenRules(WHEN_PATHS, LITERALS);
        await writeRules(db.driver, rules, KIT_LADDERS);
        await analyze(db.driver, ['item', 'authz_rule', 'authz_scope_attribute']);
        const dialect = rbacDialectOf(db.driver);
        const started = Date.now();
        const got = await whenTable(db.driver, storedWhen(RULE, p, defaults, dialect));
        const elapsed = Date.now() - started;
        const stored = await storedRules(db.driver);
        const counts = { true: 0, false: 0, null: 0, exempt: 0 };
        for (const row of ITEMS) {
          for (const rule of rules) {
            const when = stored.get(rule.id)!.when!;
            const core = await coreWhen(when, ITEM_PATH, row, o);
            const sql = got.get(`${row.id}/${rule.id}`)!;
            const ex = (await exempt(when, row, o)) || belowList(String((when as { attr: string }).attr));
            if (ex && sql === null && core !== 'unknown' && core !== 'throw') counts.exempt++;
            expectThree(sql, core, ex, `${JSON.stringify(when)} on row ${row.id}`);
            counts[String(sql) as 'true' | 'false' | 'null']++;
          }
        }
        console.log(`      storedWhen: ${rules.length} rules x ${ITEMS.length} rows in ${elapsed} ms; ${JSON.stringify(counts)}`);
        expect(counts.true).to.be.greaterThan(200);
        expect(counts.false).to.be.greaterThan(200);
        expect(counts.null).to.be.greaterThan(200);
      });

      it('a rule without when is TRUE, and its storedWhenMissing FALSE', async () => {
        await writeRules(db.driver, [{ id: 'plain', kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'alice' }] }]);
        const dialect = rbacDialectOf(db.driver);
        expect([...(await whenTable(db.driver, storedWhen(RULE, p, defaults, dialect))).values()]).to.deep.equal(ITEMS.map(() => true).concat(kind === 'postgres' ? [] : [true]));
        expect([...(await whenTable(db.driver, storedWhenMissing(RULE, p, defaults, dialect))).values()].every((v) => v === false)).to.equal(true);
      });

      it('storedWhenMissing is two-valued and TRUE exactly where the core throws (B39: no node, no row and no default, JSON null)', async () => {
        const rules = whenRules(WHEN_PATHS, [true, 3]);
        await writeRules(db.driver, rules, KIT_LADDERS);
        const got = await whenTable(db.driver, storedWhenMissing(RULE, p, defaults, rbacDialectOf(db.driver)));
        const stored = await storedRules(db.driver);
        let missing = 0;
        for (const row of ITEMS) {
          for (const rule of rules) {
            const when = stored.get(rule.id)!.when!;
            const sql = got.get(`${row.id}/${rule.id}`);
            expect(sql, 'two-valued').to.not.equal(null);
            const core = await coreWhen(when, ITEM_PATH, row, o);
            if (belowList(String((when as { attr: string }).attr))) {
              expect(sql, `${JSON.stringify(when)} on row ${row.id}: below a list counts as missing`).to.equal(true);
              continue;
            }
            expect(sql, `${JSON.stringify(when)} on row ${row.id}: core ${String(core)}`).to.equal(core === 'throw');
            if (sql) missing++;
          }
        }
        expect(missing).to.be.greaterThan(50);
      });
    });

    describe('storedResource', () => {
      it('matches the rule resource pattern on the column resource_field names as the core does; NULL where the core is UNKNOWN', async () => {
        const rules = resourceRules();
        await writeRules(db.driver, rules);
        await analyze(db.driver, ['item', 'authz_rule']);
        const rows = await select(db.driver, rsql`SELECT ${outer('id')} AS rid, ${ident(RULE, 'id')} AS rule, ${three(storedResource(RULE, FIELDS, rbacDialectOf(db.driver)))} AS v FROM ${ident('item')} r, ${ident('authz_rule')} ${ident(RULE)}`);
        const got = new Map(rows.map((r) => [`${Number(r.rid)}/${String(r.rule)}`, asThree(r.v)]));
        const stored = await storedRules(db.driver);
        const counts = { true: 0, false: 0, null: 0 };
        for (const row of items()) {
          for (const rule of rules) {
            const sql = got.get(`${row.id}/${rule.id}`)!;
            const resource = stored.get(rule.id)!.resource;
            if (resource === undefined) {
              expect(sql, rule.id).to.equal(true);
              continue;
            }
            const core = await coreResource(resource, ITEM_PATH, row, FIELDS, o);
            // SQLite's GLOB stops at NUL (F3): NULL there.
            const ex = String(row.name).includes('\u0000');
            expectThree(sql, core, ex, `${JSON.stringify(resource)} on row ${row.id} (${JSON.stringify(row.name)}, ${JSON.stringify(row.label)})`);
            counts[String(sql) as 'true' | 'false' | 'null']++;
          }
        }
        expect(counts.true).to.be.greaterThan(20);
        expect(counts.false).to.be.greaterThan(100);
        expect(counts.null).to.be.greaterThan(50);
      });

      it('refuses a field without a name, and rule aliases the blocks use inside, in any letter case', () => {
        const dialect = rbacDialectOf(db.driver);
        expect(() => storedResource(RULE, [{ field: '', column: 'name' }], dialect)).to.throw(AuthzConfigError);
        for (const alias of ['authz_w', 'AUTHZ_T', 'authz_sa', 'Authz_X']) expect(() => storedWhen(alias, p, defaults, dialect), alias).to.throw(AuthzConfigError);
      });

      it('answers NULL past the core work cap and decides just under the SQL bound', async () => {
        await db.driver.schema().createTable('big', (t) => {
          t.int('id').primaryKey().notNull();
          t.string('project_id', 64);
          t.string('org_id', 64);
          t.text('name');
          t.text('label');
        });
        // The pattern takes 11 UTF-16 units: 11 * 500 000 passes the core's 4e6 cap; LIKE 'nnnnnnnnnn%' gives the SQL bound 1e6 / 12.
        const rows: Row[] = [
          { id: 1, project_id: 'p1', org_id: 'o1', name: 'n'.repeat(500_000), label: null },
          { id: 2, project_id: 'p1', org_id: 'o1', name: 'n'.repeat(83_000), label: null },
        ];
        await db.driver
          .insert()
          .into('big')
          .values(rows.map((r) => ({ ...r })));
        const rule: Rule = { id: 'cap', kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'alice' }], resource: { attr: 'resource.name', wildcard: 'nnnnnnnnnn*' } as Condition };
        await writeRules(db.driver, [rule]);
        const got = await select(db.driver, rsql`SELECT ${outer('id')} AS rid, ${three(storedResource(RULE, FIELDS, rbacDialectOf(db.driver)))} AS v FROM ${ident('big')} r, ${ident('authz_rule')} ${ident(RULE)} ORDER BY ${outer('id')}`);
        const resource = (await storedRules(db.driver)).get('cap')!.resource!;
        expect(await coreResource(resource, ITEM_PATH, rows[0], FIELDS, o)).to.equal('unknown');
        expect(await coreResource(resource, ITEM_PATH, rows[1], FIELDS, o)).to.equal(true);
        expect(got.map((r) => asThree(r.v))).to.deep.equal([null, true]);
      });
    });

    describe('lists, permissions, expiry and path', () => {
      const listRule = (id: string, over: Partial<Rule>): Rule => ({ id, kind: 'threshold', scope: GLOBAL, minRole: 'viewer', ...over });

      it('storedPermission: a threshold names the permission or *; no list matches nothing (L1b: permissions ?? [])', async () => {
        const rules: Rule[] = [listRule('none', {}), listRule('empty', { permissions: [] }), listRule('exact', { permissions: ['file:read'] }), listRule('under', { permissions: ['file_read'] }), listRule('star', { permissions: ['*'] }), listRule('two', { permissions: ['a', 'file:read'] }), listRule('pct', { permissions: ['file%read'] })];
        await writeRules(db.driver, rules, KIT_LADDERS);
        const dialect = rbacDialectOf(db.driver);
        for (const permission of ['file:read', 'file_read', 'fileXread', 'file%read', 'a', 'file', 'a,file:read', '']) {
          const rows = await select(db.driver, rsql`SELECT ${ident(RULE, 'id')} AS rule, ${three(storedPermission(RULE, permission, dialect))} AS v FROM ${ident('authz_rule')} ${ident(RULE)}`);
          const got = Object.fromEntries(rows.map((r) => [String(r.rule), asThree(r.v)]));
          for (const rule of rules) {
            const list = rule.permissions;
            expect(got[rule.id], `${rule.id} / ${JSON.stringify(permission)}`).to.equal(list !== undefined && (list.includes(permission) || list.includes('*')));
          }
        }
      });

      it('storedListHas and storedTypeIn: NULL is no filter, an empty list matches nothing, entries match whole and case-sensitively', async () => {
        const lists: ReadonlyArray<readonly string[] | undefined> = [undefined, [], ['org'], ['org', 'project'], ['o_g'], ['Org'], ['org%']];
        const rules = lists.map((l, i) => listRule(`l${i}`, { ...(l === undefined ? {} : { resourceTypes: l }) }));
        await writeRules(db.driver, rules, KIT_LADDERS);
        const probes = ['org', 'project', 'ORG', 'o_g', 'oxg', 'org%', 'or', 'org,project', '', null];
        await clear(db.driver, ['probe']);
        await db.driver
          .insert()
          .into('probe')
          .values(probes.map((t, i) => ({ id: i + 1, t })));
        const dialect = rbacDialectOf(db.driver);
        const column = rsql`${ident(RULE, 'resource_types')}`;
        const expected = (list: readonly string[] | undefined, value: string | null) => list === undefined || (value !== null && list.includes(value));
        for (const value of probes) {
          if (value === null) continue;
          const rows = await select(db.driver, rsql`SELECT ${ident(RULE, 'id')} AS rule, ${three(storedListHas(column, value, dialect))} AS v FROM ${ident('authz_rule')} ${ident(RULE)}`);
          for (const r of rows) expect(asThree(r.v), `${String(r.rule)} has ${JSON.stringify(value)}`).to.equal(expected(lists[Number(String(r.rule).slice(1))], value));
        }
        const rows = await select(db.driver, rsql`SELECT ${ident(RULE, 'id')} AS rule, ${ident('authz_p', 't')} AS t, ${three(storedTypeIn(column, rsql`${ident('authz_p', 't')}`, dialect))} AS v FROM ${ident('authz_rule')} ${ident(RULE)}, ${ident('probe')} ${ident('authz_p')}`);
        expect(rows).to.have.length(rules.length * probes.length);
        for (const r of rows) expect(asThree(r.v), `${String(r.rule)} in ${JSON.stringify(r.t)}`).to.equal(expected(lists[Number(String(r.rule).slice(1))], (r.t as string | null) ?? null));
      });

      it('liveRule: no expiry or an expiry after now; now itself has expired', async () => {
        const rules: Rule[] = [listRule('never', {}), listRule('before', { expiresAt: new Date(NOW.getTime() - 1) }), listRule('now', { expiresAt: NOW }), listRule('after', { expiresAt: new Date(NOW.getTime() + 1) }), listRule('later', { expiresAt: new Date(NOW.getTime() + 3600000) })];
        await writeRules(db.driver, rules, KIT_LADDERS);
        const rows = await select(db.driver, rsql`SELECT ${ident(RULE, 'id')} AS rule, ${three(liveRule(RULE, NOW))} AS v FROM ${ident('authz_rule')} ${ident(RULE)}`);
        expect(Object.fromEntries(rows.map((r) => [String(r.rule), asThree(r.v)]))).to.deep.equal({ never: true, before: false, now: false, after: true, later: true });
      });

      it("ruleOnPath: a rule at a node of the row's path; a type-only scope is no node", async () => {
        const scopes: ResourceRef[] = [GLOBAL, at('org', 'o1'), at('org', 'o2'), { type: 'org' }, { type: 'file' }, at('file', '1'), at('project', 'p1'), at('project', ''), at('team', 't1')];
        await writeRules(
          db.driver,
          scopes.map((scope, i) => listRule(`s${i}`, { scope })),
          KIT_LADDERS,
        );
        const rows = await select(db.driver, rsql`SELECT ${outer('id')} AS rid, ${ident(RULE, 'id')} AS rule, ${three(ruleOnPath(RULE, p))} AS v FROM ${ident('item')} r, ${ident('authz_rule')} ${ident(RULE)}`);
        for (const r of rows) {
          const row = ITEMS.find((x) => x.id === Number(r.rid));
          if (!row) continue;
          const scope = scopes[Number(String(r.rule).slice(1))];
          const nodes = adapterAncestors(ITEM_PATH, row);
          const want = scope.type === GLOBAL.type || (scope.id !== undefined && scope.id !== '' && nodes.some((n) => n.type === scope.type && n.id === scope.id));
          expect(asThree(r.v), `${JSON.stringify(scope)} on row ${row.id}`).to.equal(want);
        }
      });
    });

    describe('types holding a dot', () => {
      // Row type 'a.b' under a scope column of type 'a': the core reads 'scope.a.b.x' as type 'a', path 'b.x'.
      const DOTTED_PATH: RbacScopePath = { type: 'a.b', idColumn: 'id', scopes: [{ column: 'a_id', scopeType: 'a' }] };
      const DOTTED: readonly Row[] = [
        { id: 1, a_id: 'x1' },
        { id: 2, a_id: null },
        { id: 3, a_id: 'x3' },
      ];

      it("read 'scope.a.b.x' as the core does, never as node 'a.b'", async () => {
        await db.driver.schema().createTable('dotted', (t) => {
          t.int('id').primaryKey().notNull();
          t.string('a_id', 64);
        });
        await db.driver
          .insert()
          .into('dotted')
          .values(DOTTED.map((r) => ({ ...r })));
        await writeAttributes(db, [
          [at('a', 'x1'), { b: { x: 'A' } }],
          [at('a.b', '1'), { x: 'B' }],
          [at('a.b', '2'), { x: 'B' }],
          [at('a.b', '3'), { x: 'B' }],
        ]);
        const literals = ['A', 'B'];
        const rules: Rule[] = [...literals.map((v, i) => ({ id: `d${i}`, kind: 'restrict' as const, scope: GLOBAL, allow: [{ type: 'user', id: 'alice' }], when: { attr: 'scope.a.b.x', eq: v } as Condition })), { id: 'dn', kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'alice' }], when: { attr: 'scope.a.b.x', null: false } as Condition }];
        await writeRules(db.driver, rules);
        const dp = new RbacPathSql(DOTTED_PATH, quoterOf(db.driver));
        const layered = RbacScopeDefaults.of([], { a: { kind: 'store' }, 'a.b': { kind: 'store' } });
        const dialect = rbacDialectOf(db.driver);
        const read = async (block: RbacSql) => new Map((await select(db.driver, rsql`SELECT ${outer('id')} AS rid, ${ident(RULE, 'id')} AS rule, ${three(block)} AS v FROM ${ident('dotted')} r, ${ident('authz_rule')} ${ident(RULE)}`)).map((r) => [`${Number(r.rid)}/${String(r.rule)}`, asThree(r.v)]));
        const got = await read(storedWhen(RULE, dp, layered, dialect));
        const missing = await read(storedWhenMissing(RULE, dp, layered, dialect));
        const dottedOracle = oracle(db, []);
        const stored = await storedRules(db.driver);
        for (const row of DOTTED) {
          for (const rule of rules) {
            const core = await coreWhen(stored.get(rule.id)!.when!, DOTTED_PATH, row, dottedOracle);
            expectThree(got.get(`${row.id}/${rule.id}`)!, core, false, `${rule.id} on row ${row.id}`);
            expect(missing.get(`${row.id}/${rule.id}`), `${rule.id} on row ${row.id}: missing`).to.equal(core === 'throw');
          }
        }
        expect(got.get('1/d0')).to.equal(true);
        expect(got.get('1/d1')).to.equal(false);
        expect(got.get('2/d1')).to.equal(null);
        expect(() => attr(dp, 'a.b', 'x', layered, dialect)).to.throw(AuthzConfigError);
      });
    });

    describe('attribute layers', () => {
      // meta: an adapter attribute whose default is an object; metaX and lockedX: names an adapter name only starts.
      const ORG_SCHEMAS: ScopeAttributeSchema[] = [{ scopeType: 'org', schema: {}, defaults: { locked: false, tier: 'free', meta: { a: 1 }, metaX: 'mx', lockedX: 'lx' } }];
      const ORG_ROWS = [
        { id: 'o1', locked: true, meta: { a: 2 } },
        { id: 'o2', locked: false, meta: null },
      ];
      const exists = (id: RbacSql): RbacSql => rsql`EXISTS (SELECT 1 FROM ${ident('org_row')} ${ident('authz_o')} WHERE ${ident('authz_o', 'id')} = ${id})`;
      const LAYERS: Readonly<Record<string, RbacScopeLayer>> = { org: { kind: 'adapter', attributes: ['locked', 'meta'], exists }, file: { kind: 'store' } };
      const paths = ['scope.org.locked', 'scope.org.tier', 'scope.org.meta', 'scope.org.meta.a', 'scope.org.metaX', 'scope.org.lockedX', 'scope.org.policies.locked', 'scope.org.policies.tier', 'scope.project.level', 'scope.$global.mode', 'scope.file.hidden'];

      /** The reads the SQL refuses by its layers: an adapter attribute or a path below one, or a type with no declared layer. */
      const layerFault = (when: string) => ['scope.org.locked', 'scope.org.meta'].some((name) => when === name || when.startsWith(`${name}.`)) || when.startsWith('scope.project.');

      it('fault where the adapter layer or an undeclared type would be read, read defaults ⊕ store elsewhere, fault for a missing node row', async () => {
        await db.driver.schema().createTable('org_row', (t) => {
          t.string('id', 64).primaryKey().notNull();
          t.boolean('locked');
        });
        await db.driver
          .insert()
          .into('org_row')
          .values(ORG_ROWS.map(({ id, locked }) => ({ id, locked })));
        const rules = whenRules(paths, [true, false, 1, 2, 'free', 'gold', 'strict', 'mx', 'lx'], 'lay');
        await writeRules(db.driver, rules, KIT_LADDERS);
        const dialect = rbacDialectOf(db.driver);
        const layered = RbacScopeDefaults.of(ORG_SCHEMAS, LAYERS);
        const got = await whenTable(db.driver, storedWhen(RULE, p, layered, dialect));
        const missing = await whenTable(db.driver, storedWhenMissing(RULE, p, layered, dialect));
        const adapterOracle = oracle(db, ORG_SCHEMAS, {
          org: async (node) => {
            const row = ORG_ROWS.find((r) => r.id === node.id);
            return row ? { locked: row.locked, meta: row.meta } : null;
          },
        });
        const stored = await storedRules(db.driver);
        let decided = 0;
        for (const row of ITEMS) {
          for (const rule of rules) {
            const when = stored.get(rule.id)!.when!;
            const attrText = String((when as { attr: string }).attr);
            const core = await coreWhen(when, ITEM_PATH, row, adapterOracle);
            const key = `${row.id}/${rule.id}`;
            if (layerFault(attrText)) {
              expect(got.get(key), `${JSON.stringify(when)} on row ${row.id}: a layer fault`).to.equal(null);
              expect(missing.get(key), `${JSON.stringify(when)} on row ${row.id}: a layer fault`).to.equal(true);
              continue;
            }
            expectThree(got.get(key)!, core, await exempt(when, row, adapterOracle), `${JSON.stringify(when)} on row ${row.id}`);
            expect(missing.get(key), `${JSON.stringify(when)} on row ${row.id}: missing`).to.equal(core === 'throw');
            if (got.get(key) !== null) decided++;
          }
        }
        expect(decided).to.be.greaterThan(20);

        // The reviewer's case: org o1's row says locked, the default says not; the core denies, the SQL faults.
        const locked = rules.find((r) => JSON.stringify(r.when) === JSON.stringify({ attr: 'scope.org.locked', eq: true }))!;
        expect(await coreWhen(stored.get(locked.id)!.when!, ITEM_PATH, ITEMS[0], adapterOracle)).to.equal(true);
        expect(got.get(`1/${locked.id}`)).to.equal(null);
        // Row 6 is under org o3, which has no org_row: the core faults on any org read, and so does the SQL.
        const tier = rules.find((r) => JSON.stringify(r.when) === JSON.stringify({ attr: 'scope.org.tier', eq: 'free' }))!;
        expect(await coreWhen(stored.get(tier.id)!.when!, ITEM_PATH, ITEMS[5], adapterOracle)).to.equal('throw');
        expect(missing.get(`6/${tier.id}`)).to.equal(true);
        expect(got.get(`1/${tier.id}`)).to.equal(true);

        // Below an adapter attribute: the adapter's meta.a is 2, the default 1. The core reads 2; the SQL faults rather than read the default.
        const metaA = rules.find((r) => JSON.stringify(r.when) === JSON.stringify({ attr: 'scope.org.meta.a', eq: 2 }))!;
        expect(await coreWhen(stored.get(metaA.id)!.when!, ITEM_PATH, ITEMS[0], adapterOracle)).to.equal(true);
        expect(got.get(`1/${metaA.id}`)).to.equal(null);
        expect(missing.get(`1/${metaA.id}`)).to.equal(true);
        // A name an adapter name only starts is no adapter attribute: decided from the default.
        for (const [path, literal] of [
          ['scope.org.lockedX', 'lx'],
          ['scope.org.metaX', 'mx'],
        ] as const) {
          const rule = rules.find((r) => JSON.stringify(r.when) === JSON.stringify({ attr: path, eq: literal }))!;
          expect(await coreWhen(stored.get(rule.id)!.when!, ITEM_PATH, ITEMS[0], adapterOracle), path).to.equal(true);
          expect(got.get(`1/${rule.id}`), path).to.equal(true);
          expect(missing.get(`1/${rule.id}`), path).to.equal(false);
        }

        // Without `exists` an adapter-backed type cannot be read at all.
        const blind = await whenTable(db.driver, storedWhenMissing(RULE, p, RbacScopeDefaults.of(ORG_SCHEMAS, { org: { kind: 'adapter', attributes: ['locked'] } }), dialect));
        expect(blind.get(`1/${tier.id}`)).to.equal(true);
      });
    });

    describe('fast-check properties (seed 4242)', () => {
      const PATH_POOL = ['scope.org.a', 'scope.org.a.b', 'scope.org.c', 'scope.project.a', 'scope.$global.a', 'scope.file.a', 'scope.team.a'];
      const leaf = fc.oneof(fc.constantFrom<unknown>(true, false, 0, 1, -1, 3, 2.5, 0.1234567, 1e15, '', 'a', 'A', '3', 'x y', 'ż'), fc.integer({ min: -5, max: 5 }), fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }));
      const nodeAttrs = fc.record({ a: fc.option(fc.oneof(leaf, fc.record({ b: leaf })), { nil: undefined }), c: fc.option(leaf, { nil: undefined }) }).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as Record<string, unknown>);
      const defaultsArb = fc.record({ a: fc.option(fc.oneof(leaf, fc.constant(null), fc.constant([1]), fc.record({ b: fc.oneof(leaf, fc.constant(null)) })), { nil: undefined }) }).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as Record<string, unknown>);
      const ruleArb = fc.record({ path: fc.constantFrom(...PATH_POOL), op: fc.constantFrom('eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'null'), literal: fc.oneof(leaf, fc.constant(true)) });

      it('storedWhen agrees with the core for random attributes, defaults and rules (100 runs)', async () => {
        const dialect = rbacDialectOf(db.driver);
        let decided = 0;
        await fc.assert(
          fc.asyncProperty(nodeAttrs, nodeAttrs, nodeAttrs, defaultsArb, fc.array(ruleArb, { minLength: 1, maxLength: 8 }), async (orgAttrs, projectAttrs, globalAttrs, orgDefaults, specs) => {
            const schemas: ScopeAttributeSchema[] = [{ scopeType: 'org', schema: {}, defaults: orgDefaults }];
            await clear(db.driver, ['authz_rule_subject', 'authz_rule']);
            await writeAttributes(db, [
              [at('org', 'o1'), orgAttrs],
              [at('org', 'o2'), {}],
              [at('project', 'p1'), projectAttrs],
              [GLOBAL, globalAttrs],
            ]);
            const rules: Rule[] = [];
            specs.forEach((s, i) => {
              const when = (s.op === 'null' ? { attr: s.path, null: s.literal === true } : { attr: s.path, [s.op]: s.literal }) as Condition;
              const rule: Rule = { id: `p${i}`, kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'alice' }], when };
              try {
                toForm(rule);
                rules.push(rule);
              } catch (e) {
                if (!(e instanceof AuthzAdminFailure)) throw e;
              }
            });
            if (rules.length === 0) return;
            await writeRules(db.driver, rules, KIT_LADDERS);
            const got = await whenTable(db.driver, storedWhen(RULE, p, RbacScopeDefaults.of(schemas, STORE), dialect));
            const missing = await whenTable(db.driver, storedWhenMissing(RULE, p, RbacScopeDefaults.of(schemas, STORE), dialect));
            const po = oracle(db, schemas);
            const stored = await storedRules(db.driver);
            for (const row of ITEMS) {
              for (const rule of rules) {
                const when = stored.get(rule.id)!.when!;
                const core = await coreWhen(when, ITEM_PATH, row, po);
                const key = `${row.id}/${rule.id}`;
                const sql = got.get(key)!;
                const below = Array.isArray(orgDefaults.a) && String((when as { attr: string }).attr) === 'scope.org.a.b';
                expectThree(sql, core, (await exemptFor(when, row, po)) || below, `${JSON.stringify(when)} on row ${row.id} (defaults ${JSON.stringify(orgDefaults)})`);
                if (!below) expect(missing.get(key), `missing ${JSON.stringify(when)} on row ${row.id}`).to.equal(core === 'throw');
                if (sql !== null) decided++;
              }
            }
          }),
          { seed: 4242, numRuns: 100 },
        );
        expect(decided).to.be.greaterThan(150);
      });

      const nameArb = fc.stringMatching(/^[ab/%_\\*?[\]A.]{0,8}$/);
      const patternArb = fc.record({ op: fc.constantFrom<'glob' | 'wildcard'>('glob', 'wildcard'), pattern: fc.stringMatching(/^[ab/%_\\[?A.]{0,5}(\*|\*\*)?$/), mid: fc.boolean() });

      it('storedResource agrees with the core for random names and patterns (100 runs)', async () => {
        const dialect = rbacDialectOf(db.driver);
        let decided = 0;
        await fc.assert(
          fc.asyncProperty(fc.array(nameArb, { minLength: 1, maxLength: 6 }), fc.array(patternArb, { minLength: 1, maxLength: 6 }), async (names, specs) => {
            await clear(db.driver, ['authz_rule_subject', 'authz_rule', 'item']);
            const rows: Row[] = names.map((name, i) => ({ id: 100 + i, project_id: 'p1', org_id: 'o1', name, label: null, size: i }));
            await db.driver
              .insert()
              .into('item')
              .values(rows.map((r) => ({ ...r })));
            const rules: Rule[] = [];
            specs.forEach((s, i) => {
              const pattern = s.op === 'wildcard' && s.mid ? `${s.pattern}*a` : s.pattern;
              const rule: Rule = { id: `q${i}`, kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'alice' }], resource: { attr: 'resource.name', [s.op]: pattern } as Condition };
              try {
                toForm(rule);
                rules.push(rule);
              } catch (e) {
                if (!(e instanceof AuthzAdminFailure)) throw e;
              }
            });
            if (rules.length === 0) return;
            await writeRules(db.driver, rules);
            const sqlRows = await select(db.driver, rsql`SELECT ${outer('id')} AS rid, ${ident(RULE, 'id')} AS rule, ${three(storedResource(RULE, FIELDS, dialect))} AS v FROM ${ident('item')} r, ${ident('authz_rule')} ${ident(RULE)}`);
            const got = new Map(sqlRows.map((r) => [`${Number(r.rid)}/${String(r.rule)}`, asThree(r.v)]));
            const stored = await storedRules(db.driver);
            for (const row of rows) {
              for (const rule of rules) {
                const core = await coreResource(stored.get(rule.id)!.resource!, ITEM_PATH, row, FIELDS, o);
                const sql = got.get(`${row.id}/${rule.id}`)!;
                expectThree(sql, core, false, `${JSON.stringify(stored.get(rule.id)!.resource)} on ${JSON.stringify(row.name)}`);
                if (sql !== null) decided++;
              }
            }
          }),
          { seed: 4242, numRuns: 100 },
        );
        await clear(db.driver, ['item']);
        await db.driver
          .insert()
          .into('item')
          .values(items().map((r) => ({ ...r })));
        expect(decided).to.be.greaterThan(300);
      });
    });
  });
}

/** As `exempt`, for the property's oracle. */
async function exemptFor(when: Condition, row: Row, o: Oracle): Promise<boolean> {
  return exempt(when, row, o);
}
