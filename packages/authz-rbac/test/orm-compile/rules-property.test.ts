import { GLOBAL } from '@spinajs/authz';
import type { Principal, ResourceFilter, RuleDef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP } from '../../src/index.js';
import { RbacRoleGraphSource, RbacScopeAttributeSource } from '../../src/orm/index.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { EXPIRY, ROLE_NAMES, TAGS, asRestrict, propertyPart, attributesOf, attributesOfArb, inexactLeafArb, rankArb, restrictArb, rowsOf, ruleOf, safetyAttributesArb, safetyWhenArb, subjectsArb, whenArb, worldOf } from './rules-arbitraries.js';
import type { Rule, When } from './rules-arbitraries.js';
import { RouteWorld, at, registerRouteSources, routeArgs, service, thresholdArgs, u, user } from './route-world.js';
/*
 * The route property with random config rules of every kind: restrict (allow lists, rank selectors, when),
 * cap (constant, ref, null, strip, subject and scope selectors, rank selectors), threshold (constant or ref
 * minRole, ladder/at, permissions, resource patterns, when), over random scope attributes and nodes with
 * missing attributes. For every principal, permission and row: check() = listed through authz-orm = the
 * in-memory list filter. The generator keeps to the shapes the SQL is exact for (see compile/rules.ts).
 *
 * The safety property adds the condition leaves SQL cannot decide (patterns and orders on string attributes,
 * numeric strings, a scope ref against another read; also under ne and nin) to every rule kind, string values to the attributes, and a
 * role whose implied entry bypasses restrict only. There SQL may refuse more than the check, never less: listed
 * ⊆ check(), each route term's rows ⊆ the in-memory term's, each threshold term's rows ⊇ the in-memory term's.
 */

const SEED = 20261005;
const RUNS = Number(process.env.L4B_RULES_RUNS ?? 300);
const SAFETY_RUNS = Number(process.env.L4B_SAFETY_RUNS ?? 200);
const [exactPart, safetyPart] = [propertyPart(RUNS), propertyPart(SAFETY_RUNS)];

// The exact property's shapes as before the safety property: no string levels or tags, and no 'skipper'.
const worldArb = worldOf(
  fc.array(ruleOf(whenArb), { minLength: 1, maxLength: 4 }),
  attributesOfArb(fc.integer({ min: 0, max: 3 }), fc.constant(undefined)),
  ROLE_NAMES.filter((r) => r !== 'skipper'),
);
// Each world starts with a restrict whose when holds such a leaf: its effect on rank selectors and missing-node
// rules after it is where SQL would list too much.
// The rules after it select by rank more often, so a contribution the restrict drops above its node matters.
const safetySubjectsArb: fc.Arbitrary<RuleDef['subjects']> = fc.oneof({ weight: 3, arbitrary: rankArb.map((rank) => ({ rank })) }, { weight: 1, arbitrary: subjectsArb });
const safetyRulesArb = fc
  .tuple(
    restrictArb(fc.oneof({ weight: 3, arbitrary: inexactLeafArb }, { weight: 1, arbitrary: safetyWhenArb }), fc.constant(undefined)).map((r) => asRestrict({ ...r, when: r.when ?? { attr: 'scope.org.policies.tag', glob: 'z*' } })),
    fc.array(ruleOf(safetyWhenArb, safetySubjectsArb), { minLength: 1, maxLength: 3 }),
  )
  .map(([first, rest]) => [first, ...rest]);
const broadSafetyWorldArb = worldOf(safetyRulesArb, safetyAttributesArb, ROLE_NAMES);

// Half the worlds stay near the shapes where it went wrong (review probes A-D): project-ladder roles held above
// and below an org, an inexact restrict at the org or above, then caps and thresholds selecting by project rank
// and rules reading scope.project.* (no project node at doc 4).
const projectRankArb = fc.record({ op: fc.constantFrom('gte', 'eq'), role: fc.constantFrom('commenter', 'editor', 'maintainer'), at: fc.constantFrom('project', 'org') }).map((r) => ({ rank: { ladder: 'project', at: r.at, [r.op]: r.role } as NonNullable<NonNullable<RuleDef['subjects']>['rank']> }));
const focusScopes = [GLOBAL, at('org', 'o1'), at('org', 'o2')];
const projectRead: When = { attr: 'scope.project.tier', eq: 'gold' };
const focusedRuleArb: fc.Arbitrary<Omit<Rule, 'id'>> = fc.oneof(
  fc.record({ scope: fc.constantFrom(...focusScopes), maxRole: fc.constantFrom('viewer', 'commenter'), subjects: fc.option(projectRankArb, { nil: undefined, freq: 4 }), when: fc.option(fc.oneof(fc.constant(projectRead), safetyWhenArb), { nil: undefined }), global: fc.boolean() }).map((r) => ({ kind: 'cap' as const, scope: r.scope, ladder: 'project', maxRole: r.maxRole, ...(r.subjects ? { subjects: r.subjects } : {}), ...(r.when ? { when: r.when } : {}), ...(r.global ? { assignments: { scopeTypes: ['$global'] } } : {}) })),
  fc.record({ scope: fc.constantFrom(...focusScopes), minRole: fc.constantFrom('editor', 'maintainer'), subjects: projectRankArb, when: fc.option(safetyWhenArb, { nil: undefined }) }).map((r) => ({ kind: 'threshold' as const, scope: r.scope, permissions: ['*'], minRole: r.minRole, subjects: r.subjects, ...(r.when ? { when: r.when } : {}) })),
  fc.record({ scope: fc.constantFrom(...focusScopes), when: fc.oneof(fc.constant(projectRead), safetyWhenArb) }).map((r) => asRestrict({ scope: r.scope, allow: [], when: r.when })),
);
const focusedSafetyWorldArb = fc.record({
  assignments: fc.array(
    fc.record({
      subject: fc.constantFrom(u('u1'), u('u2')),
      role: fc.constantFrom('viewer', 'commenter', 'editor', 'maintainer', 'skipper', 'support', 'team.lead', 'org.owner'),
      scope: fc.constantFrom(GLOBAL, at('org', 'o1'), at('org', 'o2'), at('project', '10'), at('project', '11'), at('doc', '1'), at('doc', '4')),
      tags: fc.subarray(TAGS),
      expiry: fc.constant<(typeof EXPIRY)[number]>('none'),
    }),
    { minLength: 1, maxLength: 5 },
  ),
  memberships: fc.constant([]),
  ceilings: fc.constant<[string[] | undefined, string[] | undefined]>([undefined, undefined]),
  rules: fc
    .tuple(
      fc.record({ scope: fc.constantFrom(...focusScopes, at('project', '10')), when: inexactLeafArb }).map((r) => asRestrict({ scope: r.scope, allow: [], when: r.when })),
      fc.array(focusedRuleArb, { minLength: 1, maxLength: 3 }),
    )
    .map(([first, rest]) => [first, ...rest]),
  attributes: safetyAttributesArb,
  permissions: fc.subarray(['doc:read', 'doc:comment', 'doc:edit'], { minLength: 2, maxLength: 2 }),
});
const safetyWorldArb = fc.oneof(broadSafetyWorldArb, focusedSafetyWorldArb as unknown as typeof broadSafetyWorldArb);

describe('authz-rbac orm-compile: rules in SQL, check ⇔ listed (property)', function () {
  this.timeout(3600000);

  let db: RootOrm;
  let undoSources: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_rules_prop');
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

      it(`for every principal and row, check() allows exactly the rows authz-orm lists and the in-memory list filter keeps (seed ${SEED}, ${exactPart.label})`, async () => {
        const stats = { withRules: 0, thresholds: 0, terms: 0, listed: 0, refused: 0, sqlMs: 0 };
        const started = Date.now();
        await fc.assert(
          fc.asyncProperty(
            worldArb,
            exactPart.only(async (spec) => {
              const rules = spec.rules.map((r, i) => ({ id: `r${i}`, ...r } as Rule));
              await world.configure({ rules, ...attributesOf(spec) });
              await world.assign(rowsOf(spec, Date.now()));
              const principals: Principal[] = [user('u1', spec.ceilings[0]), { ...user('u2'), attributes: { contractor: false } } as Principal, { ...user('u3'), attributes: { contractor: true } } as Principal, service('s1', spec.ceilings[1]), service('s2')];
              for (const p of principals) {
                for (const permission of spec.permissions) {
                  const residual = await world.residual(p, permission);
                  stats.terms++;
                  if (routeArgs(residual).some((a) => (a.rules as unknown[]).length > 0)) stats.withRules++;
                  stats.thresholds += thresholdArgs(residual).length;
                  const allowed = await world.allowed(p, permission);
                  const t0 = Date.now();
                  const listed = await world.listed(p, permission);
                  stats.sqlMs += Date.now() - t0;
                  stats.listed += listed.length;
                  stats.refused += 8 - listed.length;
                  const why = `${kind} ${p.type}:${p.id} ceiling ${JSON.stringify(p.ceiling?.roles)} ${permission} rules ${JSON.stringify(rules)} attributes ${JSON.stringify(attributesOf(spec))}: ${JSON.stringify(residual)}`;
                  expect(listed, `listed, ${why}`).to.deep.equal(allowed);
                  expect(await world.inMemory(residual, p), `in memory, ${why}`).to.deep.equal(allowed);
                }
              }
            }),
          ),
          { seed: SEED, numRuns: exactPart.numRuns, endOnFailure: true },
        );
        console.log(`      ${kind}: ${exactPart.label} in ${Date.now() - started} ms (SQL ${stats.sqlMs} ms over ${stats.terms} lists); ${stats.withRules} lists with rule terms, ${stats.thresholds} threshold terms, ${stats.listed} rows listed, ${stats.refused} not`);
        expect(stats.withRules, 'lists with rule terms').to.be.at.least(exactPart.min(RUNS));
        expect(stats.thresholds, 'threshold terms').to.be.at.least(exactPart.min(RUNS / 2));
        expect(stats.listed, 'rows listed').to.be.at.least(exactPart.min(RUNS));
      });

      it(`safety: with condition leaves SQL cannot decide in every rule kind, SQL never lists a row check() refuses (seed ${SEED}, ${safetyPart.label})`, async () => {
        const stats = { terms: 0, routeTerms: 0, thresholdTerms: 0, listed: 0, allowed: 0, gap: 0 };
        const started = Date.now();
        const within = (sub: readonly string[], sup: readonly string[]) => sub.filter((id) => !sup.includes(id));
        await fc.assert(
          fc.asyncProperty(
            safetyWorldArb,
            safetyPart.only(async (spec) => {
              const rules = spec.rules.map((r, i) => ({ id: `r${i}`, ...r } as Rule));
              await world.configure({ rules, ...attributesOf(spec) });
              await world.assign(rowsOf(spec, Date.now()));
              const principals: Principal[] = [user('u1', spec.ceilings[0]), { ...user('u2'), attributes: { contractor: false } } as Principal, { ...user('u3'), attributes: { contractor: true } } as Principal, service('s1', spec.ceilings[1]), service('s2')];
              for (const p of principals) {
                for (const permission of spec.permissions) {
                  const residual = await world.residual(p, permission);
                  stats.terms++;
                  const allowed = await world.allowed(p, permission);
                  const listed = await world.listed(p, permission);
                  stats.listed += listed.length;
                  stats.allowed += allowed.length;
                  stats.gap += allowed.length - listed.length;
                  const why = `${kind} ${p.type}:${p.id} ceiling ${JSON.stringify(p.ceiling?.roles)} ${permission} rules ${JSON.stringify(rules)} attributes ${JSON.stringify(attributesOf(spec))}: ${JSON.stringify(residual)}`;
                  expect(within(listed, allowed), `listed but refused by check(), ${why}`).to.deep.equal([]);
                  expect(await world.inMemory(residual, p), `in memory, ${why}`).to.deep.equal(allowed);
                  for (const args of routeArgs(residual).filter((a) => (a.rules as unknown[]).length > 0)) {
                    stats.routeTerms++;
                    const term = { op: RBAC_ASSIGNMENT_OP, args } as unknown as ResourceFilter;
                    expect(within(await world.compiled(term, p), await world.inMemory(term, p)), `route term rows the evaluator refuses, ${why}`).to.deep.equal([]);
                  }
                  for (const args of thresholdArgs(residual)) {
                    stats.thresholdTerms++;
                    const term = { op: RBAC_THRESHOLD_OP, args } as unknown as ResourceFilter;
                    const denied = await world.compiled(term, p);
                    const missed = within(await world.inMemory(term, p), denied);
                    expect(missed, `threshold denials SQL misses, ${why}`).to.deep.equal([]);
                  }
                }
              }
            }),
          ),
          { seed: SEED, numRuns: safetyPart.numRuns, endOnFailure: true },
        );
        console.log(`      ${kind}: safety ${safetyPart.label} in ${Date.now() - started} ms over ${stats.terms} lists; ${stats.routeTerms} route and ${stats.thresholdTerms} threshold terms; ${stats.listed} rows listed of ${stats.allowed} check() allows (${stats.gap} refused by SQL only)`);
        expect(stats.routeTerms, 'route terms with rules').to.be.at.least(safetyPart.min(SAFETY_RUNS));
        expect(stats.thresholdTerms, 'threshold terms').to.be.at.least(safetyPart.min(SAFETY_RUNS / 2));
        expect(stats.listed, 'rows listed').to.be.at.least(safetyPart.min(SAFETY_RUNS));
      });
    });
  }
});
