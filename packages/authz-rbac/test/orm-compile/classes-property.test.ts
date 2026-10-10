import type { Principal, ResourceRef, RuleDef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { toSqlForm } from '../../src/index.js';
import { RbacRoleGraphSource, RbacScopeAttributeSource } from '../../src/orm/index.js';
import { RootOrm } from '../orm/root-orm.js';
import { rawQuery } from '../support/db.js';
import { NODES, classCount, compareForms, createTables, dropTables, loadRows, tenantLayers } from './classes-world.js';
import type { DocRow } from './classes-world.js';
import { EXPIRY, ROLE_NAMES, RULE_SCOPES, attributesOf, attributesOfArb, propertyPart, propertyRuns, rowsOf, ruleOf, subjectsArb, whenArb, worldOf } from './rules-arbitraries.js';
import type { Rule, When, WorldSpec } from './rules-arbitraries.js';
import { DAY, LADDERS, RouteWorld, at, registerRouteSources, service, user } from './route-world.js';

/*
 * S1 task 2a, differential: on random worlds (assignments, memberships, ceilings, config rules of every kind,
 * stored rules, scope attributes, and a table of rows that share untouched ids, so most classes hold several
 * rows, some of which the adapter cannot find), every route, `threshold(id)` and `thresholdDb` term of every
 * principal's residual gives the same value on every row, three-valued, in the class form as in the per-row form,
 * with each class's representative taken first and last by id. Half the worlds read projects through a host
 * `exists` that also reads the row's tenant and org (r3 N2). The per-row form is the one the L4b properties check
 * against the evaluator.
 */

const SEED = Number(process.env.L4B_SEED ?? 20261010);
const RUNS = propertyRuns('S1_CLASSES_RUNS', 100);
const part = propertyPart(RUNS);

// One comparison of a scope attribute with a literal, as toSqlForm takes it.
const storedLeafArb = fc.constantFrom<When>({ attr: 'scope.org.policies.locked', eq: true }, { attr: 'scope.org.policies.level', gte: 2 }, { attr: 'scope.org.policies.max', ne: 'editor' }, { attr: 'scope.project.tier', eq: 'gold' }, { attr: 'scope.project.flag', eq: 1 }, { attr: 'scope.$global.mode', eq: 'strict' });
const STORED_SCOPES: readonly ResourceRef[] = [...RULE_SCOPES, at('org'), at('doc'), at('project', '12'), at('project', '14'), at('org', 'o3'), at('org', '')];
const storable = (r: Omit<Rule, 'id'>): boolean => {
  try {
    toSqlForm({ id: 'probe', ...r } as Rule, LADDERS);
    return true;
  } catch {
    return false;
  }
};
// Stored thresholds with a resource pattern on a field, or on a path column (r2 C1); some for other types only.
const patternArb = fc.record({
  scope: fc.constantFrom<ResourceRef>(...STORED_SCOPES),
  resource: fc.constantFrom<NonNullable<RuleDef['resource']>>({ attr: 'resource.name', glob: 'tmp*' }, { attr: 'resource.name', wildcard: '*1' }, { attr: 'resource.org_id', glob: 'o*' }, { attr: 'resource.org_id', glob: 'tmp-*' }),
  minRole: fc.constantFrom('commenter', 'editor', 'maintainer'),
  types: fc.constantFrom(['doc'], ['doc', 'project'], ['project']),
});
const storedRuleArb = fc.oneof(
  { weight: 3, arbitrary: fc.tuple(ruleOf(storedLeafArb, subjectsArb, STORED_SCOPES), fc.constantFrom(...EXPIRY), fc.constantFrom(undefined, ['doc'], ['project'])).filter(([r]) => storable(r)) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        patternArb.map((p): Omit<Rule, 'id'> => ({ kind: 'threshold', scope: p.scope, permissions: ['*'], ladder: 'project', minRole: p.minRole, resource: p.resource, resourceTypes: p.types })),
        fc.constantFrom(...EXPIRY),
        fc.constant(undefined),
      )
      .filter(([r]) => storable(r)),
  },
);

// 10.5 and an id ending in .5: rows the adapter cannot find, UNKNOWN in every term.
const docArb = fc.record({
  project: fc.constantFrom<number | null>(10, 11, 12, 13, 14, 15, 10.5, null),
  org: fc.constantFrom<string | null>('o1', 'o2', 'O1', 'o10', '', 'o3', 'tmp-1', null),
  name: fc.constantFrom<string | null>('release/1', 'notes', 'tmp1', 'tmp2', null),
  tenant: fc.constantFrom('t1', 't2'),
  halfId: fc.constantFrom(false, false, false, false, false, false, false, true),
});

// More thresholds than ruleOf gives, and fewer with a resource.* condition (their terms keep the per-row form).
const configRuleArb = fc.tuple(fc.oneof({ weight: 2, arbitrary: ruleOf(whenArb) }, { weight: 1, arbitrary: ruleOf(whenArb).filter((r) => r.kind === 'threshold') }), fc.nat(2)).map(([r, keep]): Omit<Rule, 'id'> => {
  if (r.kind !== 'threshold' || r.resource === undefined || keep === 0) return r;
  const rest = { ...r };
  delete rest.resource;
  delete rest.resourceTypes;
  return rest;
});

type TermKind = 'route' | 'threshold' | 'thresholdDb';
const kindOf = (name: string): TermKind => (name.startsWith('route') ? 'route' : name === 'threshold db' ? 'thresholdDb' : 'threshold');

const caseArb = fc.record({
  world: worldOf(
    fc.array(configRuleArb, { maxLength: 3 }),
    attributesOfArb(fc.integer({ min: 0, max: 3 }), fc.constant(undefined)),
    ROLE_NAMES.filter((r) => r !== 'skipper'),
  ),
  stored: fc.option(fc.array(storedRuleArb, { maxLength: 3 }), { nil: undefined, freq: 3 }),
  ids: fc.uniqueArray(fc.integer({ min: 10, max: 99 }), { minLength: 6, maxLength: 6 }),
  docs: fc.array(docArb, { minLength: 24, maxLength: 40 }),
  tenants: fc.tuple(fc.constantFrom('t1', 't2'), fc.constantFrom('t1', 't2'), fc.constantFrom('o1', 'o2')),
  hostExists: fc.boolean(),
});

describe('authz-rbac orm-compile: class form = per-row form on random worlds (S1, property)', function () {
  this.timeout(3600000);

  let db: RootOrm;
  let undoSources: (() => void) | undefined;
  let world: RouteWorld;
  let driver: OrmDriver;

  before(async function () {
    db = await RootOrm.open(this, 's1_classes_prop');
    await (await testHost.domains()).service('root');
    undoSources = registerRouteSources();
    world = await RouteWorld.open(db, 'postgres');
    driver = db.driver('postgres');
    await createTables(driver, 'DOUBLE PRECISION');
  });

  after(async () => {
    if (driver) await dropTables(driver);
    await world?.close();
    undoSources?.();
    DI.uncache(RbacRoleGraphSource);
    DI.uncache(RbacScopeAttributeSource);
    await db?.close();
  });

  it(`postgres: every term, every row, ASC and DESC representatives (seed ${SEED}, ${part.label})`, async () => {
    const stats = { runs: 0, terms: 0, classForms: 0, perRow: 0, rows: 0, classes: 0, multi: 0, stored: 0, hostExists: 0, unknown: 0, pruned: 0, prunedMixed: 0, configRoutes: 0 };
    const byKind: Record<TermKind, { terms: number; classForms: number; multi: number }> = { route: { terms: 0, classForms: 0, multi: 0 }, threshold: { terms: 0, classForms: 0, multi: 0 }, thresholdDb: { terms: 0, classForms: 0, multi: 0 } };
    const started = Date.now();
    await fc.assert(
      fc.asyncProperty(
        caseArb,
        part.only(async (c) => {
          stats.runs++;
          const now = Date.now();
          let i = 0;
          const rules = c.world.rules.map((r) => ({ id: `r${c.ids[i++]}`, ...r } as Rule));
          const dbRules = c.stored?.map(([r, expiry, types]) => ({ id: `r${c.ids[i++]}`, ...r, ...(types && r.resourceTypes === undefined ? { resourceTypes: types } : {}), ...(expiry === 'none' ? {} : { expiresAt: new Date(now + (expiry === 'past' ? -DAY : DAY)) }) } as Rule));
          await world.configure({ rules, ...attributesOf(c.world as WorldSpec), ...(dbRules ? { dbRules } : {}) });
          await world.assign(rowsOf(c.world as WorldSpec, now));
          const docs: DocRow[] = c.docs.map((d, n) => [n + (d.halfId ? 1.5 : 1), d.project, d.org, d.name, d.tenant]);
          await loadRows(driver, docs);
          await rawQuery(driver, `DELETE FROM "${NODES}"`, [], QueryContext.Delete);
          await rawQuery(driver, `INSERT INTO "${NODES}" ("id", "org_id", "tenant") VALUES (10, 'o1', '${c.tenants[0]}'), (11, '${c.tenants[2]}', '${c.tenants[1]}'), (12, 'o2', 't1')`, [], QueryContext.Insert);
          if (dbRules) stats.stored++;
          if (c.hostExists) stats.hostExists++;
          const options = c.hostExists ? { layers: tenantLayers(driver) } : {};
          const principals: Principal[] = [user('u1', c.world.ceilings[0]), { ...user('u2'), attributes: { contractor: false } } as Principal, { ...user('u3'), attributes: { contractor: true } } as Principal, service('s1', c.world.ceilings[1]), service('s2')];
          for (const p of principals) {
            for (const permission of c.world.permissions) {
              const why = `rules ${JSON.stringify(rules)} stored ${JSON.stringify(dbRules)} attributes ${JSON.stringify(attributesOf(c.world as WorldSpec))} docs ${JSON.stringify(docs)} host exists ${c.hostExists} (seed ${SEED})`;
              for (const t of await compareForms(world, driver, p, permission, options, why)) {
                const kind = byKind[kindOf(t.term.name)];
                stats.terms++;
                kind.terms++;
                if (t.keys === undefined) {
                  stats.perRow++;
                  continue;
                }
                stats.classForms++;
                kind.classForms++;
                stats.rows += docs.length;
                stats.unknown += [...t.rows.values()].filter((v) => v === null).length;
                if (kindOf(t.term.name) === 'route') {
                  const values = new Set(t.rows.values());
                  if (t.term.args.config.length > 0) stats.configRoutes++;
                  else {
                    stats.pruned++;
                    if (values.has(true) && values.has(false)) stats.prunedMixed++;
                  }
                }
                const n = classCount(t.keys);
                stats.classes += n;
                if (n < docs.length) {
                  stats.multi++;
                  kind.multi++;
                }
              }
            }
          }
        }),
      ),
      { seed: SEED, numRuns: part.numRuns, endOnFailure: true },
    );
    console.log(`      postgres: ${part.label} in ${Date.now() - started} ms; ${stats.terms} terms (${stats.classForms} class forms, ${stats.perRow} per row), ${stats.classes} classes over ${stats.rows} rows, ${stats.multi} terms with a class of several rows, ${stats.unknown} UNKNOWN values in class forms; route terms: ${stats.pruned} pruned (${stats.prunedMixed} listing some rows and not others), ${stats.configRoutes} with config roles; by kind ${JSON.stringify(byKind)}; ${stats.stored} runs with stored rules, ${stats.hostExists} with a host exists`);
    expect(stats.classForms, 'class forms compared').to.be.at.least(part.min(RUNS * 2));
    // Classes of several rows, where a missing key part would show (I8).
    expect(stats.multi, 'terms whose classes hold several rows').to.be.at.least(part.min(stats.classForms / 2));
    expect(stats.classes, 'and not all rows in one class').to.be.at.least(part.min(stats.classForms * 2));
    expect(stats.stored, 'runs with stored rules').to.be.at.least(part.min(RUNS / 2));
    expect(stats.unknown, 'rows the adapter cannot find').to.be.at.least(part.min(RUNS));
    // Route terms without config roles take only candidate rows as representatives (pruning), the others all.
    expect(stats.pruned, 'pruned route terms').to.be.at.least(part.min(RUNS / 2));
    expect(stats.prunedMixed, 'pruned route terms that list some rows').to.be.at.least(part.min(RUNS / 5));
    expect(stats.configRoutes, 'route terms with config roles').to.be.at.least(part.min(RUNS / 5));
    for (const [name, k] of Object.entries(byKind)) {
      expect(k.classForms, `${name}: class forms compared`).to.be.at.least(part.min(RUNS / 5));
      expect(k.multi, `${name}: terms whose classes hold several rows`).to.be.at.least(part.min(RUNS / 5));
    }
  });
});
