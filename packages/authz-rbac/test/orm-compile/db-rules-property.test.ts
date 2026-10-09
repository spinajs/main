import type { Principal, ResourceFilter, RuleDef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP, toSqlForm } from '../../src/index.js';
import { RbacRoleGraphSource, RbacScopeAttributeSource } from '../../src/orm/index.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import type { Kind } from '../orm/root-orm.js';
import { EXPIRY, RULE_SCOPES, ROLE_NAMES, attributesOf, propertyPart, propertyRuns, attributesOfArb, rowsOf, ruleOf, safetyAttributesArb, safetyWhenArb, subjectsArb, whenArb, worldOf } from './rules-arbitraries.js';
import type { Rule, When, WorldSpec } from './rules-arbitraries.js';
import { DAY, LADDERS, RouteWorld, at, registerRouteSources, routeArgs, service, thresholdArgs, user } from './route-world.js';

/*
 * The rules properties with stored rules (DbRuleStore, args v2 `dbRules`, native:rbac.threshold `{ db: true }`):
 * random rules of every kind in the shapes a stored rule takes (one comparison of a scope attribute in `when`,
 * selectors by principal type, refs and rank, type-only scopes, expiry), beside random config rules, their ids
 * interleaved so one id order runs across both stores. For every principal, permission and row: check() = listed
 * through authz-orm = the in-memory list filter. The safety property adds the leaves SQL cannot decide (a string
 * attribute read as a number, an order on a numeric string) to the stored and the config rules: listed ⊆ check(),
 * each route term ⊆ its in-memory term, each threshold term ⊇ its in-memory term.
 *
 * A list with stored rules takes SQLite seconds (the term's WITH is worked out again for every sub-query that
 * reads it; task 9), so SQLite runs a tenth of the runs.
 */

const SEED = 20261005;
const RUNS = propertyRuns('L4B_DB_RULES_RUNS', 100);
const SAFETY_RUNS = propertyRuns('L4B_DB_SAFETY_RUNS', 80);
const runsOn = (kind: Kind, runs: number) => (kind === 'sqlite' ? Math.max(1, Math.ceil(runs / 10)) : runs);

// One comparison of a scope attribute with a literal, as toSqlForm takes it; decided exactly by SQL (or a fault, as in the check).
const storedLeafArb = fc.constantFrom<When>({ attr: 'scope.org.policies.locked', eq: true }, { attr: 'scope.org.policies.locked', ne: false }, { attr: 'scope.org.policies.level', gte: 2 }, { attr: 'scope.org.policies.level', lt: 2 }, { attr: 'scope.org.policies.level', eq: 3 }, { attr: 'scope.org.policies.level', ne: 1 }, { attr: 'scope.org.policies.level', eq: 'x' }, { attr: 'scope.org.policies.max', ne: 'editor' }, { attr: 'scope.org.policies.max', eq: 'viewer' }, { attr: 'scope.org.policies.max', null: true }, { attr: 'scope.project.tier', eq: 'gold' }, { attr: 'scope.project.flag', eq: 1 }, { attr: 'scope.project.flag', eq: true }, { attr: 'scope.$global.mode', eq: 'strict' });
// Leaves the check decides and SQL cannot follow, in a stored rule's form: a numeric string attribute against a number.
const storedInexactLeafArb = fc.constantFrom<When>({ attr: 'scope.org.policies.level', eq: 2 }, { attr: 'scope.org.policies.level', gte: 2 }, { attr: 'scope.org.policies.level', ne: 10 }, { attr: 'scope.org.policies.tag', eq: 1 });
const storedSafetyLeafArb = fc.oneof(storedLeafArb, storedInexactLeafArb);

const STORED_SCOPES = [...RULE_SCOPES, at('org'), at('doc')];
const storedSubjectsArb: fc.Arbitrary<RuleDef['subjects']> = fc
  .tuple(
    subjectsArb,
    fc.option(
      fc.constantFrom(
        [{ type: 'user', id: 'u1' }],
        [
          { type: 'service', id: 's1' },
          { type: 'user', id: 'u2' },
        ],
      ),
      { nil: undefined, freq: 4 },
    ),
  )
  .map(([s, refs]) => (refs ? { ...(s ?? {}), refs } : s));

const storableRule = (r: Omit<Rule, 'id'>): boolean => {
  try {
    toSqlForm({ id: 'probe', ...r } as Rule, LADDERS);
    return true;
  } catch {
    return false;
  }
};

const storedRuleArb = (leaf: fc.Arbitrary<When>) => fc.tuple(ruleOf(leaf, storedSubjectsArb, STORED_SCOPES), fc.constantFrom(...EXPIRY)).filter(([r]) => storableRule(r));

/** Config rules and stored rules, their ids drawn so that they interleave. */
const rulesArb = (configWhen: fc.Arbitrary<When>, storedLeaf: fc.Arbitrary<When>) => fc.tuple(fc.array(ruleOf(configWhen), { maxLength: 2 }), fc.array(storedRuleArb(storedLeaf), { minLength: 1, maxLength: 3 }), fc.uniqueArray(fc.integer({ min: 10, max: 99 }), { minLength: 5, maxLength: 5 })).map(([config, stored, ids]) => ({ config, stored, ids }));

// The permissions some role of route-world.ts grants on most docs, so most lists carry route terms.
const permissionsArb = fc.subarray(['doc:read', 'doc:comment', 'doc:edit', 'doc:audit', 'doc:inspect'], { minLength: 2, maxLength: 2 });
const worldArb = fc.tuple(
  worldOf(
    fc.constant([]),
    attributesOfArb(fc.integer({ min: 0, max: 3 }), fc.constant(undefined)),
    ROLE_NAMES.filter((r) => r !== 'skipper'),
  ),
  rulesArb(whenArb, storedLeafArb),
  permissionsArb,
);
const safetyWorldArb = fc.tuple(worldOf(fc.constant([]), safetyAttributesArb, ROLE_NAMES), rulesArb(safetyWhenArb, storedSafetyLeafArb), permissionsArb);

type Rules = { config: Omit<Rule, 'id'>[]; stored: [Omit<Rule, 'id'>, (typeof EXPIRY)[number]][]; ids: number[] };

function rulesOf(r: Rules, now: number): { rules: Rule[]; dbRules: Rule[] } {
  let i = 0;
  const rules = r.config.map((x) => ({ id: `r${r.ids[i++]}`, ...x } as Rule));
  const dbRules = r.stored.map(([x, expiry]) => ({ id: `r${r.ids[i++]}`, ...x, ...(expiry === 'none' ? {} : { expiresAt: new Date(now + (expiry === 'past' ? -DAY : DAY)) }) } as Rule));
  return { rules, dbRules };
}

type Case = [WorldSpec, Rules, string[]];
type ExactStats = { lists: number; stored: number; routeTerms: number; thresholdTerms: number; listed: number; refused: number; sqlMs: number };
type SafetyStats = { lists: number; routeTerms: number; thresholdTerms: number; listed: number; allowed: number };
const exactStats = (): ExactStats => ({ lists: 0, stored: 0, routeTerms: 0, thresholdTerms: 0, listed: 0, refused: 0, sqlMs: 0 });
const safetyStats = (): SafetyStats => ({ lists: 0, routeTerms: 0, thresholdTerms: 0, listed: 0, allowed: 0 });

// Counterexamples of a full run, as fast-check printed them (the generators have changed since, so a seed and path replay draws other worlds).
const EXACT_PATH_3 = [
  {
    assignments: [
      { subject: { type: 'user', id: 'u1' }, role: 'lead.plus', scope: { type: 'project', id: '11' }, tags: ['review'], expiry: 'future' },
      { subject: { type: 'user', id: 'u3' }, role: 'robot', scope: { type: 'org', id: 'o2' }, tags: ['inspect'], expiry: 'past' },
    ],
    memberships: [{ user: 'u1', team: 't2', expiry: 'past' }],
    ceilings: [[], ['auditor']],
    rules: [],
    attributes: {
      o1: { locked: false, level: undefined, max: 'nope', min: 'org.guest', tag: undefined },
      o2: { locked: undefined, level: undefined, max: 'org.owner', min: 'org.guest', tag: undefined },
      projects: [
        { tier: 'basic', flag: true, max: 'editor' },
        { tier: undefined, flag: 0, max: undefined },
        { tier: 'basic', flag: true, max: 'org.owner' },
        { tier: undefined, flag: 0, max: undefined },
      ],
      mode: 'strict',
      orgDefaults: true,
      projectDefaults: false,
    },
    permissions: ['doc:read', 'doc:export'],
  },
  {
    config: [{ kind: 'cap', scope: { type: 'org', id: 'o1' }, ladder: 'project', maxRole: { ref: 'scope.project.max' }, assignments: { scopeTypes: ['doc', '$global'], subjectTypes: ['user', 'service', 'team'] }, subjects: { principalTypes: ['service'] } }],
    stored: [
      [
        {
          kind: 'cap',
          scope: { type: '$global' },
          ladder: 'org',
          maxRole: null,
          assignments: { scopeTypes: ['org', 'project', '$global'], subjectTypes: ['user', 'service', 'team'] },
          subjects: {
            rank: { ladder: 'org', at: 'org', gte: 'org.owner' },
            principalTypes: ['user'],
            refs: [
              { type: 'service', id: 's1' },
              { type: 'user', id: 'u2' },
            ],
          },
        },
        'future',
      ],
      [{ kind: 'restrict', scope: { type: 'doc', id: '1' }, allow: [{ type: 'user', id: 'u1' }, { type: 'service', id: 's1' }, { set: { role: 'team.member', scope: { type: 'team', id: 't1' } } }], when: { attr: 'scope.project.flag', eq: 1 }, subjects: { principalTypes: ['user'] } }, 'future'],
    ],
    ids: [11, 10, 16, 95, 14],
  },
  ['doc:read', 'doc:comment'],
] as unknown as Case;
const SAFETY_PATH_34 = [
  {
    assignments: [
      { subject: { type: 'user', id: 'u1' }, role: 'viewer', scope: { type: 'doc', id: '3' }, tags: [], expiry: 'none' },
      { subject: { type: 'service', id: 's2' }, role: 'team.member', scope: { type: 'org', id: 'O1' }, tags: [], expiry: 'none' },
      { subject: { type: 'user', id: 'u3' }, role: 'projectOnly', scope: { type: 'project', id: '13' }, tags: ['inspect', 'review', 'x'], expiry: 'none' },
      { subject: { type: 'user', id: 'u2' }, role: 'maintainer', scope: { type: 'doc', id: '7' }, tags: ['inspect', 'x'], expiry: 'none' },
      { subject: { type: 'user', id: 'u2' }, role: 'robot', scope: { type: 'project', id: '13' }, tags: ['inspect', 'x'], expiry: 'future' },
      { subject: { type: 'service', id: 's1' }, role: 'lead.plus', scope: { type: 'project', id: '13' }, tags: ['inspect', 'x'], expiry: 'past' },
    ],
    memberships: [{ user: 'u2', team: 't2', expiry: 'none' }],
    ceilings: [['editor', 'team.lead'], undefined],
    rules: [],
    attributes: {
      o1: { locked: undefined, level: undefined, max: undefined, min: 'editor', tag: 'zz1' },
      o2: { locked: true, level: undefined, max: 'org.owner', min: undefined, tag: 'zz1' },
      projects: [
        { tier: 'basic', flag: 0, max: undefined },
        { tier: undefined, flag: undefined, max: undefined },
        { tier: 'gold', flag: 1, max: 'commenter' },
        { tier: 'gold', flag: true, max: 'org.owner' },
      ],
      mode: 'strict',
      orgDefaults: true,
      projectDefaults: true,
    },
    permissions: ['doc:read', 'doc:org'],
  },
  {
    config: [
      { kind: 'threshold', scope: { type: 'project', id: '13' }, permissions: ['doc:audit'], minRole: 'editor', ladder: 'project', at: 'project', resource: { attr: 'resource.name', wildcard: '*1' }, subjects: { rank: { ladder: 'org', at: 'project', lt: 'org.guest' }, principalTypes: ['user'] } },
      { kind: 'restrict', scope: { type: 'project', id: '11' }, allow: [], when: { attr: 'scope.org.policies.tag', ne: 1 }, subjects: { rank: { ladder: 'project', at: 'project', lt: 'editor' }, principalTypes: ['service'] } },
    ],
    stored: [
      [
        {
          kind: 'threshold',
          scope: { type: 'org' },
          permissions: ['*'],
          minRole: { ref: 'scope.org.policies.min' },
          when: { attr: 'scope.org.policies.level', eq: 2 },
          resource: { attr: 'resource.name', glob: 'release/*' },
          subjects: {
            principalTypes: ['user'],
            refs: [
              { type: 'service', id: 's1' },
              { type: 'user', id: 'u2' },
            ],
          },
        },
        'past',
      ],
      [{ kind: 'threshold', scope: { type: 'org', id: 'o1' }, permissions: ['*'], minRole: 'org.guest', ladder: 'org', at: 'project', when: { attr: 'scope.org.policies.level', ne: 10 }, resource: { attr: 'resource.name', wildcard: '*1' }, subjects: { rank: { ladder: 'org', at: 'project', gte: 'org.admin' }, refs: [{ type: 'user', id: 'u1' }] } }, 'future'],
      [{ kind: 'threshold', scope: { type: 'doc', id: '1' }, permissions: ['*'], minRole: 'viewer', ladder: 'project', at: 'project', when: { attr: 'scope.project.flag', eq: 1 }, resource: { attr: 'resource.name', glob: 'release/*' }, subjects: { rank: { ladder: 'org', at: 'project', gte: 'org.guest' }, principalTypes: ['user'] } }, 'past'],
    ],
    ids: [61, 93, 25, 47, 72],
  },
  ['doc:read', 'doc:comment'],
] as unknown as Case;

describe('authz-rbac orm-compile: stored rules in SQL, check ⇔ listed (property)', function () {
  this.timeout(3600000);

  let db: RootOrm;
  let undoSources: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_db_rules_prop');
    await (await testHost.domains()).service('root');
    undoSources = registerRouteSources();
  });

  after(async () => {
    undoSources?.();
    DI.uncache(RbacRoleGraphSource);
    DI.uncache(RbacScopeAttributeSource);
    await db?.close();
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      let world: RouteWorld;

      before(async () => {
        world = await RouteWorld.open(db, kind);
      });

      after(async () => {
        await world?.close();
      });

      const principalsOf = (ceilings: readonly (string[] | undefined)[]): Principal[] => [user('u1', ceilings[0]), { ...user('u2'), attributes: { contractor: false } } as Principal, { ...user('u3'), attributes: { contractor: true } } as Principal, service('s1', ceilings[1]), service('s2')];

      const exactCase = async ([spec, r, permissions]: Case, stats: ExactStats) => {
        const now = Date.now();
        const { rules, dbRules } = rulesOf(r, now);
        stats.stored += dbRules.length;
        await world.configure({ rules, dbRules, ...attributesOf(spec) });
        await world.assign(rowsOf(spec, now));
        for (const p of principalsOf(spec.ceilings)) {
          for (const permission of permissions) {
            const residual = await world.residual(p, permission);
            stats.lists++;
            stats.routeTerms += routeArgs(residual).length;
            stats.thresholdTerms += thresholdArgs(residual).filter((a) => JSON.stringify(a.threshold) === '{"db":true}').length;
            const allowed = await world.allowed(p, permission);
            const t0 = Date.now();
            const listed = await world.listed(p, permission);
            stats.sqlMs += Date.now() - t0;
            stats.listed += listed.length;
            stats.refused += 8 - listed.length;
            const why = `${kind} ${p.type}:${p.id} ceiling ${JSON.stringify(p.ceiling?.roles)} ${permission} rules ${JSON.stringify(rules)} stored ${JSON.stringify(dbRules)} attributes ${JSON.stringify(attributesOf(spec))}: ${JSON.stringify(residual)}`;
            expect(listed, `listed, ${why}`).to.deep.equal(allowed);
            expect(await world.inMemory(residual, p), `in memory, ${why}`).to.deep.equal(allowed);
          }
        }
      };

      const safetyCase = async ([spec, r, permissions]: Case, stats: SafetyStats) => {
        const within = (sub: readonly string[], sup: readonly string[]) => sub.filter((id) => !sup.includes(id));
        const now = Date.now();
        const { rules, dbRules } = rulesOf(r, now);
        await world.configure({ rules, dbRules, ...attributesOf(spec) });
        await world.assign(rowsOf(spec, now));
        for (const p of principalsOf(spec.ceilings)) {
          for (const permission of permissions) {
            const residual = await world.residual(p, permission);
            stats.lists++;
            const allowed = await world.allowed(p, permission);
            const listed = await world.listed(p, permission);
            stats.listed += listed.length;
            stats.allowed += allowed.length;
            const why = `${kind} ${p.type}:${p.id} ceiling ${JSON.stringify(p.ceiling?.roles)} ${permission} rules ${JSON.stringify(rules)} stored ${JSON.stringify(dbRules)} attributes ${JSON.stringify(attributesOf(spec))}: ${JSON.stringify(residual)}`;
            expect(within(listed, allowed), `listed but refused by check(), ${why}`).to.deep.equal([]);
            expect(await world.inMemory(residual, p), `in memory, ${why}`).to.deep.equal(allowed);
            for (const args of routeArgs(residual)) {
              stats.routeTerms++;
              const term = { op: RBAC_ASSIGNMENT_OP, args } as unknown as ResourceFilter;
              expect(within(await world.compiled(term, p), await world.inMemory(term, p)), `route term rows the evaluator refuses, ${why}`).to.deep.equal([]);
            }
            for (const args of thresholdArgs(residual)) {
              stats.thresholdTerms++;
              const term = { op: RBAC_THRESHOLD_OP, args } as unknown as ResourceFilter;
              expect(within(await world.inMemory(term, p), await world.compiled(term, p)), `threshold denials SQL misses, ${why}`).to.deep.equal([]);
            }
          }
        }
      };

      const [exactPart, safetyPart] = [propertyPart(runsOn(kind, RUNS)), propertyPart(runsOn(kind, SAFETY_RUNS))];

      it(`for every principal and row, check() allows exactly the rows authz-orm lists and the in-memory list filter keeps (seed ${SEED}, ${exactPart.label})`, async () => {
        const runs = runsOn(kind, RUNS);
        const stats = exactStats();
        const started = Date.now();
        await fc.assert(
          fc.asyncProperty(
            worldArb,
            exactPart.only((value) => exactCase(value, stats)),
          ),
          { seed: SEED, numRuns: exactPart.numRuns, endOnFailure: true },
        );
        console.log(`      ${kind}: ${exactPart.label} in ${Date.now() - started} ms (SQL ${stats.sqlMs} ms over ${stats.lists} lists); ${stats.stored} stored rules, ${stats.routeTerms} route and ${stats.thresholdTerms} { db: true } terms, ${stats.listed} rows listed, ${stats.refused} not`);
        expect(stats.routeTerms, 'route terms').to.be.at.least(exactPart.min(runs));
        expect(stats.thresholdTerms, '{ db: true } terms').to.be.at.least(exactPart.min(runs));
        expect(stats.listed, 'rows listed').to.be.at.least(exactPart.min(runs));
      });

      it(`safety: with leaves SQL cannot decide in stored and config rules, SQL never lists a row check() refuses (seed ${SEED}, ${safetyPart.label})`, async () => {
        const runs = runsOn(kind, SAFETY_RUNS);
        const stats = safetyStats();
        const started = Date.now();
        await fc.assert(
          fc.asyncProperty(
            safetyWorldArb,
            safetyPart.only((value) => safetyCase(value, stats)),
          ),
          { seed: SEED, numRuns: safetyPart.numRuns, endOnFailure: true },
        );
        console.log(`      ${kind}: safety ${safetyPart.label} in ${Date.now() - started} ms over ${stats.lists} lists; ${stats.routeTerms} route and ${stats.thresholdTerms} threshold terms; ${stats.listed} rows listed of ${stats.allowed} check() allows`);
        expect(stats.routeTerms, 'route terms').to.be.at.least(safetyPart.min(runs));
        expect(stats.thresholdTerms, 'threshold terms').to.be.at.least(safetyPart.min(runs));
      });

      it('counterexample of the exact property (seed 20261005, path "3"): service s2 under a config cap with a { ref } maxRole on doc and $global assignments', async () => {
        await exactCase(EXACT_PATH_3, exactStats());
      });

      it('counterexample of the safety property (seed 20261005, path "34"): service s2 with a config threshold at project 13 and a restrict with an inexact when', async () => {
        await safetyCase(SAFETY_PATH_34, safetyStats());
      });
    });
  }
});
