import { GLOBAL } from '@spinajs/authz';
import type { Assignment, Condition, Policy, Principal, ResourceRef, ScopeAttributeSchema } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { RbacRoleGraphSource, RbacScopeAttributeSource } from '../../src/orm/index.js';
import { CurrentRoleGraphSource } from '../orm/orm-world.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { propertyPart, propertyRuns } from './rules-arbitraries.js';
import { NODES, PERMISSION, ScopeWorld, ScopeWorldAttributeSource, scopeLeaves } from './scope-world.js';

/*
 * ABAC policies with scope conditions through a real AbacModel with `scopeResiduals` on, alone or beside an RbacModel
 * (before or after it), with or without an unconditional permit, under the three algorithms, over random scope
 * attributes and schema defaults: the type-level residual compiled by authz-orm (one statement, its
 * `native:condition.scope` leaves through ConditionScopeOrmCompiler) against check() of every doc.
 * - exact: leaf-able comparisons over values SQL decides (numbers, plain strings, booleans; missing and null
 *   attributes, missing nodes): listed = allowed;
 * - safety: also long numbers, exponents, numeric strings, strings with escapes, a scalar above the path, patterns
 *   and orders on strings, an adapter attribute (org `tier`), and forms that are no leaf (a scope ref as the
 *   operand): listed ⊆ allowed.
 */

const SEED = 20261010;
const RUNS = propertyRuns('A4_SCOPE_RUNS', 120);
const SAFETY_RUNS = propertyRuns('A4_SCOPE_SAFETY_RUNS', 120);
const [exactPart, safetyPart] = [propertyPart(RUNS), propertyPart(SAFETY_RUNS)];

const TYPES = ['org', 'project', 'team', 'doc'] as const;
const ALGORITHMS = ['deny-overrides', 'permit-overrides', 'first-applicable'] as const;

const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined, freq: 3 });
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const exactValues = { n: fc.integer({ min: 0, max: 3 }), s: fc.constantFrom('gold', 'basic', 'x y'), b: fc.boolean() };
const safetyValues = {
  n: fc.oneof(fc.integer({ min: 0, max: 3 }), fc.constantFrom(1234567890.1234567, 1e21, -0.5, '2', '03')),
  s: fc.oneof(fc.constantFrom('gold', 'basic', 'x y'), fc.constantFrom('a"b', '3', 'g\\x', 'gold\n')),
  b: fc.oneof(fc.boolean(), fc.constantFrom(0, 1)),
};

const nodeArb = (values: typeof exactValues, above: boolean): fc.Arbitrary<Record<string, unknown>> => {
  const node = fc.record({ n: maybe(values.n), s: maybe(values.s), b: maybe(values.b) }).map((p) => ({ p: defined(p) }));
  // A scalar above the path: the engine reads nothing there.
  return above ? fc.oneof({ weight: 6, arbitrary: node }, { weight: 1, arbitrary: fc.constant({ p: 5 }) }) : node;
};

const schemasArb: fc.Arbitrary<ScopeAttributeSchema[]> = fc.record({ org: fc.boolean(), team: fc.boolean(), project: fc.boolean() }).map((d) => [...(d.org ? [{ scopeType: 'org', schema: {}, defaults: { p: { n: 1, s: 'basic' } } }] : []), ...(d.team ? [{ scopeType: 'team', schema: {}, defaults: { p: { b: true } } }] : []), ...(d.project ? [{ scopeType: 'project', schema: {}, defaults: { p: { n: null } } }] : [])]);

const attr = (type: string, key: string) => `scope.${type}.p.${key}`;
const typeArb = fc.constantFrom(...TYPES);
const exactLeafArb: fc.Arbitrary<Condition> = fc.oneof(
  fc.tuple(typeArb, fc.constantFrom('eq', 'ne', 'lt', 'lte', 'gt', 'gte'), fc.integer({ min: 0, max: 3 })).map(([t, op, v]) => ({ attr: attr(t, 'n'), [op]: v } as Condition)),
  fc.tuple(typeArb, fc.constantFrom('in', 'nin'), fc.subarray([0, 1, 2, 3], { minLength: 1 })).map(([t, op, v]) => ({ attr: attr(t, 'n'), [op]: v } as Condition)),
  fc.tuple(typeArb, fc.constantFrom('eq', 'ne'), fc.oneof(fc.constantFrom('gold', 'basic'), fc.constant({ ref: 'principal.attributes.team' }))).map(([t, op, v]) => ({ attr: attr(t, 's'), [op]: v } as Condition)),
  fc.tuple(typeArb, fc.constantFrom('in', 'nin'), fc.subarray(['gold', 'basic', 'x y'], { minLength: 1 })).map(([t, op, v]) => ({ attr: attr(t, 's'), [op]: v } as Condition)),
  fc.tuple(typeArb, fc.constantFrom('eq', 'ne'), fc.boolean()).map(([t, op, v]) => ({ attr: attr(t, 'b'), [op]: v } as Condition)),
  fc.tuple(typeArb, fc.constantFrom('n', 's', 'b'), fc.boolean()).map(([t, key, v]) => ({ attr: attr(t, key), null: v } as Condition)),
);
const safetyLeafArb: fc.Arbitrary<Condition> = fc.oneof(
  { weight: 3, arbitrary: exactLeafArb },
  { weight: 1, arbitrary: fc.tuple(typeArb, fc.constantFrom('lt', 'gte', 'like', 'glob', 'wildcard'), fc.constantFrom('g*', 'b%', 'c')).map(([t, op, v]) => ({ attr: attr(t, 's'), [op]: v } as Condition)) },
  { weight: 1, arbitrary: fc.tuple(typeArb, fc.constantFrom('eq', 'ne'), fc.constantFrom(3, 2, '2', 'a"b')).map(([t, op, v]) => ({ attr: attr(t, 's'), [op]: v } as Condition)) },
  { weight: 1, arbitrary: fc.tuple(typeArb, fc.constantFrom('eq', 'gte'), fc.constantFrom('2', 1234567890.1234567, 1e21)).map(([t, op, v]) => ({ attr: attr(t, 'n'), [op]: v } as Condition)) },
  { weight: 1, arbitrary: fc.constantFrom<Condition>({ attr: 'scope.org.tier', eq: 'gold' }, { attr: 'scope.org.tier', null: false }) },
  // No leaf: a scope ref as the operand needs the row (NEEDS_SUBJECT on a list).
  {
    weight: 1,
    arbitrary: fc.constantFrom<Condition>(
      { attr: 'principal.attributes.team', eq: { ref: 'scope.org.p.s' } } as Condition,
      {
        all: [
          { attr: 'principal.id', eq: 'alice' },
          { attr: 'principal.attributes.team', ne: { ref: 'scope.project.p.s' } },
        ],
      } as Condition,
    ),
  },
);

const whenOf = (leaf: fc.Arbitrary<Condition>): fc.Arbitrary<Condition> => fc.oneof({ weight: 4, arbitrary: leaf }, { weight: 1, arbitrary: leaf.map((x) => ({ not: x } as Condition)) }, { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([a, b]) => ({ any: [a, b] } as Condition)) }, { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([a, b]) => ({ all: [a, b] } as Condition)) });

const policyArb = (when: fc.Arbitrary<Condition>) => fc.record({ effect: fc.constantFrom<'permit' | 'deny'>('permit', 'deny'), when, scope: fc.option(fc.constantFrom<ResourceRef>({ type: 'org', id: 'o1' }, { type: 'project', id: '10' }), { nil: undefined, freq: 4 }) });

const RBAC_ROWS: readonly Assignment[] = [
  { id: 'a1', subject: { type: 'user', id: 'alice' }, role: 'viewer', scope: { type: 'org', id: 'o1' }, expiresAt: null, source: 'db' },
  { id: 'a2', subject: { type: 'user', id: 'bob' }, role: 'viewer', scope: { type: 'project', id: '11' }, expiresAt: null, source: 'db' },
  { id: 'a3', subject: { type: 'user', id: 'bob' }, role: 'viewer', scope: GLOBAL, expiresAt: null, source: 'db' },
];

const worldArb = (values: typeof exactValues, above: boolean, leaf: fc.Arbitrary<Condition>) =>
  fc.record({
    nodes: fc.tuple(...NODES.map(() => nodeArb(values, above))),
    schemas: schemasArb,
    policies: fc.array(policyArb(whenOf(leaf)), { minLength: 1, maxLength: 3 }),
    permitAll: fc.boolean(),
    algorithm: fc.constantFrom(...ALGORITHMS),
    rbac: fc.option(fc.record({ first: fc.boolean(), rows: fc.subarray([...RBAC_ROWS], { minLength: 1 }) }), { nil: undefined, freq: 3 }),
  });

type Spec = { nodes: Record<string, unknown>[]; schemas: ScopeAttributeSchema[]; policies: { effect: 'permit' | 'deny'; when: Condition; scope?: ResourceRef }[]; permitAll: boolean; algorithm: (typeof ALGORITHMS)[number]; rbac?: { first: boolean; rows: Assignment[] } };

const PRINCIPALS: readonly Principal[] = [{ type: 'user', id: 'alice', authenticated: true, source: 'session', attributes: { team: 'gold' } } as Principal, { type: 'user', id: 'bob', authenticated: true, source: 'session', attributes: {} } as Principal];

const policiesOf = (spec: Spec): Policy[] => [...spec.policies.map((p, i): Policy => ({ id: `p${i}`, effect: p.effect, permissions: [PERMISSION], when: p.when, ...(p.scope ? { scope: p.scope } : {}), source: 'test' })), ...(spec.permitAll ? [{ id: 'all', effect: 'permit' as const, permissions: [PERMISSION], source: 'test' }] : [])];

describe('authz-rbac orm-compile: ABAC scope conditions listed through authz-orm, check ⇔ listed (property)', function () {
  this.timeout(3600000);

  let db: RootOrm;
  const undo: (() => void)[] = [];

  before(async function () {
    db = await RootOrm.open(this, 'a4_scope_prop');
    await (await testHost.domains()).service('root');
    undo.push(testHost.registerInRoot(RbacScopeAttributeSource, testHost.instance(new ScopeWorldAttributeSource())));
    undo.push(testHost.registerInRoot(RbacRoleGraphSource, testHost.instance(new CurrentRoleGraphSource())));
  });

  after(async () => {
    for (const u of undo.splice(0)) u();
    DI.uncache(RbacScopeAttributeSource);
    DI.uncache(RbacRoleGraphSource);
    await db?.close();
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      let world: ScopeWorld;

      before(async () => {
        world = await ScopeWorld.open(db, kind, false);
      });

      after(async () => {
        await world?.close();
      });

      async function run(spec: Spec, stats: { leaves: number; listed: number; allowed: number; gap: number; runs: number }, exact: boolean): Promise<void> {
        await world.attributes(
          NODES.map((n, i) => [n, spec.nodes[i]] as const),
          spec.schemas,
        );
        const policies = policiesOf(spec);
        const service = await world.domain({ policies, algorithm: spec.algorithm, ...(spec.rbac ? { rbac: { first: spec.rbac.first, assignments: spec.rbac.rows } } : {}) });
        stats.runs++;
        for (const p of PRINCIPALS) {
          const residual = await service.filter(p, PERMISSION, 'doc');
          stats.leaves += scopeLeaves(residual).length;
          const allowed = await world.allowed(p);
          const listed = await world.sql(residual, p);
          stats.listed += listed.length;
          stats.allowed += allowed.length;
          stats.gap += allowed.length - listed.length;
          const why = `${kind} ${p.id} ${spec.algorithm} policies ${JSON.stringify(policies)} rbac ${JSON.stringify(spec.rbac)} nodes ${JSON.stringify(spec.nodes)} schemas ${JSON.stringify(spec.schemas)}: ${JSON.stringify(residual)}`;
          if (exact) expect(listed, `listed, ${why}`).to.deep.equal(allowed);
          else
            expect(
              listed.filter((id) => !allowed.includes(id)),
              `listed but refused by check(), ${why}`,
            ).to.deep.equal([]);
        }
      }

      it(`exact: leaf-able scope conditions over values SQL decides list exactly the rows check() allows (seed ${SEED}, ${exactPart.label})`, async () => {
        const stats = { leaves: 0, listed: 0, allowed: 0, gap: 0, runs: 0 };
        const started = Date.now();
        await fc.assert(
          fc.asyncProperty(
            worldArb(exactValues, false, exactLeafArb),
            exactPart.only((spec) => run(spec as Spec, stats, true)),
          ),
          { seed: SEED, numRuns: exactPart.numRuns, endOnFailure: true },
        );
        console.log(`      ${kind}: exact ${exactPart.label} in ${Date.now() - started} ms; ${JSON.stringify(stats)}`);
        expect(stats.leaves, 'scope leaves in residuals').to.be.at.least(exactPart.min(RUNS));
        expect(stats.listed, 'rows listed').to.be.at.least(exactPart.min(RUNS));
      });

      it(`safety: with values SQL cannot decide, unreadable layers and forms that are no leaf, SQL never lists a row check() refuses (seed ${SEED + 1}, ${safetyPart.label})`, async () => {
        const stats = { leaves: 0, listed: 0, allowed: 0, gap: 0, runs: 0 };
        const started = Date.now();
        await fc.assert(
          fc.asyncProperty(
            worldArb(safetyValues as unknown as typeof exactValues, true, safetyLeafArb),
            safetyPart.only((spec) => run(spec as Spec, stats, false)),
          ),
          { seed: SEED + 1, numRuns: safetyPart.numRuns, endOnFailure: true },
        );
        console.log(`      ${kind}: safety ${safetyPart.label} in ${Date.now() - started} ms; ${JSON.stringify(stats)}`);
        expect(stats.leaves, 'scope leaves in residuals').to.be.at.least(safetyPart.min(SAFETY_RUNS));
        expect(stats.listed, 'rows listed').to.be.at.least(safetyPart.min(SAFETY_RUNS / 2));
        expect(stats.gap, 'rows only SQL refuses').to.be.at.least(safetyPart.min(1));
      });
    });
  }
});
