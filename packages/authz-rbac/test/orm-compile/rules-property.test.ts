import { GLOBAL } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, Principal, ResourceFilter, ResourceRef, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP } from '../../src/index.js';
import { RbacRoleGraphSource, RbacScopeAttributeSource } from '../../src/orm/index.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { DAY, LADDERS, PERMISSIONS, ROLES, RouteWorld, at, registerRouteSources, routeArgs, service, team, thresholdArgs, u, user } from './route-world.js';

/*
 * The route property with random config rules of every kind: restrict (allow lists, rank selectors, when),
 * cap (constant, ref, null, strip, subject and scope selectors, rank selectors), threshold (constant or ref
 * minRole, ladder/at, permissions, resource patterns, when), over random scope attributes and nodes with
 * missing attributes. For every principal, permission and row: check() = listed through authz-orm = the
 * in-memory list filter. The generator keeps to the shapes the SQL is exact for (see compile/rules.ts).
 *
 * The safety property adds the condition leaves SQL cannot decide (patterns and orders on string attributes,
 * numeric strings, a scope ref against another read) to every rule kind, string values to the attributes, and a
 * role whose implied entry bypasses restrict only. There SQL may refuse more than the check, never less: listed
 * ⊆ check(), each route term's rows ⊆ the in-memory term's, each threshold term's rows ⊇ the in-memory term's.
 */

type Rule = Omit<RuleDef, 'source'>;

const SEED = 20261005;
const RUNS = Number(process.env.L4B_RULES_RUNS ?? 300);
const SAFETY_RUNS = Number(process.env.L4B_SAFETY_RUNS ?? 200);

const ROLE_NAMES = [...ROLES.map((r) => r.name), 'nope'];
const SUBJECTS: readonly AssignmentSubject[] = [u('u1'), u('u2'), u('u3'), { type: 'service', id: 's1' }, { type: 'service', id: 's2' }, team('t1'), team('t2')];
const SCOPES: readonly ResourceRef[] = [GLOBAL, at('doc'), ...['1', '2', '3', '6', '7', '8'].map((id) => at('doc', id)), ...['10', '11', '12', '13'].map((id) => at('project', id)), ...['o1', 'o2', 'O1', 'o10'].map((id) => at('org', id)), at('team', 't1'), at('team', 't2')];
const RULE_SCOPES: readonly ResourceRef[] = [GLOBAL, GLOBAL, at('org', 'o1'), at('org', 'o2'), at('org', 'O1'), at('project', '10'), at('project', '11'), at('project', '13'), at('doc', '1'), at('doc', '6')];
const TAGS = ['inspect', 'review', 'x'];
const EXPIRY = ['none', 'past', 'future'] as const;
const IMPLYING_BELOW = ['team.lead', 'lead.plus', 'robot'];

const assignmentFields = {
  subject: fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SUBJECTS.slice(0, 3)) }, { weight: 2, arbitrary: fc.constantFrom(...SUBJECTS) }),
  scope: fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SCOPES.filter((s) => s.id !== undefined && s.type !== 'team')) }, { weight: 2, arbitrary: fc.constantFrom(...SCOPES) }),
  tags: fc.subarray(TAGS),
  expiry: fc.constantFrom(...EXPIRY),
};
const membershipArb = fc.record({ user: fc.constantFrom('u1', 'u2', 'u3'), team: fc.constantFrom('t1', 't2'), expiry: fc.constantFrom(...EXPIRY) });

const ladderRoles = (name: string) => LADDERS.find((l) => l.name === name)!.roles;
const ROLE_VALUES = ['viewer', 'commenter', 'editor', 'maintainer', 'org.guest', 'org.owner', 'nope'];

// Scope reads the SQL decides exactly (or faults on, as the check does).
const leafArb = fc.constantFrom<NonNullable<RuleDef['when']>>({ attr: 'scope.org.policies.locked', eq: true }, { attr: 'scope.org.policies.level', gte: 2 }, { attr: 'scope.org.policies.level', eq: '2' }, { attr: 'scope.org.policies.max', in: ['viewer', 'editor'] }, { attr: 'scope.org.policies.max', ne: 'editor' }, { attr: 'scope.project.tier', eq: 'gold' }, { attr: 'scope.project.flag', eq: 1 }, { attr: 'scope.$global.mode', eq: 'strict' }, { attr: 'principal.attributes.contractor', eq: true });
type When = NonNullable<RuleDef['when']>;
const whenOf = (leaf: fc.Arbitrary<When>): fc.Arbitrary<When> => fc.oneof({ weight: 4, arbitrary: leaf }, { weight: 1, arbitrary: leaf.map((x) => ({ not: x })) }, { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([a, b]) => ({ any: [a, b] })) }, { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([a, b]) => ({ all: [a, b] })) });
const whenArb = whenOf(leafArb);
// Leaves the check decides and SQL cannot: a pattern or an order on a string attribute, a numeric string, a ref.
const inexactLeafArb = fc.constantFrom<When>({ attr: 'scope.org.policies.tag', wildcard: 'a*' }, { attr: 'scope.org.policies.tag', glob: 'z*' }, { attr: 'scope.project.tier', like: 'g%' }, { attr: 'scope.org.policies.max', lt: 'f' }, { attr: 'scope.org.policies.level', gte: '2' }, { attr: 'scope.org.policies.level', eq: 2 }, { attr: 'scope.org.policies.max', eq: { ref: 'scope.project.max' } } as unknown as When);
const safetyWhenArb = whenOf(fc.oneof({ weight: 1, arbitrary: leafArb }, { weight: 1, arbitrary: inexactLeafArb }));
const resourceArb = fc.constantFrom<NonNullable<RuleDef['resource']>>({ attr: 'resource.name', wildcard: 'release/*' }, { attr: 'resource.name', glob: 'release/*' }, { attr: 'resource.name', glob: 'release/**' }, { attr: 'resource.name', wildcard: '*1' });
const rankArb = fc
  .constantFrom('project', 'org')
  .chain((ladder) => fc.record({ ladder: fc.constant(ladder), at: fc.constantFrom('project', 'org'), op: fc.constantFrom('lt', 'eq', 'gte'), role: fc.constantFrom(...ladderRoles(ladder)) }))
  .map(({ ladder, at: node, op, role }) => ({ ladder, at: node, [op]: role } as NonNullable<NonNullable<RuleDef['subjects']>['rank']>));
const subjectsArb = fc.record({ rank: fc.option(rankArb, { nil: undefined }), principalTypes: fc.option(fc.constantFrom(['user'], ['service']), { nil: undefined, freq: 4 }) }).map((s) => (s.rank || s.principalTypes ? { ...(s.rank ? { rank: s.rank } : {}), ...(s.principalTypes ? { principalTypes: s.principalTypes } : {}) } : undefined));

const restrictArb = (when: fc.Arbitrary<When>, subjects: fc.Arbitrary<RuleDef['subjects']> = subjectsArb) =>
  fc.record({
    scope: fc.constantFrom(...RULE_SCOPES),
    allow: fc.subarray<NonNullable<RuleDef['allow']>[number]>([{ type: 'user', id: 'u1' }, { type: 'service', id: 's1' }, { set: { role: 'team.member', scope: at('team', 't1') } }]),
    when: fc.option(when, { nil: undefined }),
    subjects,
  });
const capArb = (when: fc.Arbitrary<When>, subjects: fc.Arbitrary<RuleDef['subjects']>) =>
  fc.record({
    scope: fc.constantFrom(...RULE_SCOPES),
    ladder: fc.constantFrom('project', 'org'),
    max: fc.constantFrom('role', 'role', 'null', 'refOrg', 'refProject', 'strip'),
    roleIndex: fc.nat(3),
    stripTags: fc.boolean(),
    scopeTypes: fc.option(fc.subarray(['org', 'project', 'doc', '$global'], { minLength: 1 }), { nil: undefined }),
    subjectTypes: fc.option(fc.subarray(['user', 'service', 'team'], { minLength: 1 }), { nil: undefined }),
    when: fc.option(when, { nil: undefined }),
    subjects,
  });
const thresholdArb = (when: fc.Arbitrary<When>, subjects: fc.Arbitrary<RuleDef['subjects']>) =>
  fc.record({
    scope: fc.constantFrom(...RULE_SCOPES),
    permissions: fc.oneof({ weight: 2, arbitrary: fc.constant(['*']) }, { weight: 1, arbitrary: fc.subarray([...PERMISSIONS], { minLength: 1, maxLength: 3 }) }),
    ladder: fc.constantFrom('project', 'org'),
    min: fc.constantFrom('role', 'role', 'refOrg'),
    roleIndex: fc.nat(3),
    withLadder: fc.boolean(),
    at: fc.option(fc.constantFrom('org', 'project'), { nil: undefined }),
    when: fc.option(when, { nil: undefined }),
    resource: fc.option(resourceArb, { nil: undefined }),
    subjects,
  });

const asRestrict = (r: { scope: ResourceRef; allow: NonNullable<RuleDef['allow']>; when?: When; subjects?: RuleDef['subjects'] }): Omit<Rule, 'id'> => ({ kind: 'restrict' as const, scope: r.scope, allow: r.allow, ...(r.when ? { when: r.when } : {}), ...(r.subjects ? { subjects: r.subjects } : {}) });
const ruleOf = (when: fc.Arbitrary<When>, subjects: fc.Arbitrary<RuleDef['subjects']> = subjectsArb): fc.Arbitrary<Omit<Rule, 'id'>> =>
  fc.oneof(
    restrictArb(when, subjects).map(asRestrict),
    capArb(when, subjects).map((r) => {
      const roles = ladderRoles(r.ladder);
      const maxRole = r.max === 'role' ? roles[r.roleIndex % roles.length] : r.max === 'null' ? null : r.max === 'refOrg' ? { ref: 'scope.org.policies.max' } : r.max === 'refProject' ? { ref: 'scope.project.max' } : undefined;
      const assignments = r.scopeTypes || r.subjectTypes ? { ...(r.scopeTypes ? { scopeTypes: r.scopeTypes } : {}), ...(r.subjectTypes ? { subjectTypes: r.subjectTypes } : {}) } : undefined;
      return {
        kind: 'cap' as const,
        scope: r.scope,
        ...(maxRole !== undefined ? { ladder: r.ladder, maxRole } : {}),
        ...(maxRole === undefined || r.stripTags ? { stripTags: true } : {}),
        ...(assignments ? { assignments } : {}),
        ...(r.when ? { when: r.when } : {}),
        ...(r.subjects ? { subjects: r.subjects } : {}),
      };
    }),
    thresholdArb(when, subjects).map((r) => {
      const roles = ladderRoles(r.ladder);
      const minRole = r.min === 'role' ? roles[r.roleIndex % roles.length] : { ref: 'scope.org.policies.min' };
      // `at` needs `ladder`; a ref minRole names a role of the ladder when one is given.
      const withLadder = r.withLadder || r.at !== undefined;
      return {
        kind: 'threshold' as const,
        scope: r.scope,
        permissions: r.permissions,
        minRole,
        ...(withLadder ? { ladder: r.ladder } : {}),
        ...(withLadder && r.at ? { at: r.at } : {}),
        ...(r.when ? { when: r.when } : {}),
        ...(r.resource ? { resource: r.resource } : {}),
        ...(r.subjects ? { subjects: r.subjects } : {}),
      };
    }),
  );

const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined, freq: 4 });
const policiesOf = (level: fc.Arbitrary<number | string>, tag: fc.Arbitrary<string | undefined>) => fc.record({ locked: maybe(fc.boolean()), level: maybe(level), max: maybe(fc.constantFrom(...ROLE_VALUES)), min: maybe(fc.constantFrom(...ROLE_VALUES)), tag });
const attributesOfArb = (level: fc.Arbitrary<number | string>, tag: fc.Arbitrary<string | undefined>) =>
  fc.record({
    o1: policiesOf(level, tag),
    o2: policiesOf(level, tag),
    projects: fc.tuple(...['10', '11', '12', '13'].map(() => fc.record({ tier: maybe(fc.constantFrom('gold', 'basic')), flag: maybe(fc.constantFrom(0, 1, true)), max: maybe(fc.constantFrom(...ROLE_VALUES)) }))),
    mode: maybe(fc.constantFrom('strict', 'lax')),
    orgDefaults: fc.boolean(),
    projectDefaults: fc.boolean(),
  });

const worldOf = (rules: fc.Arbitrary<Omit<Rule, 'id'>[]>, attributes: ReturnType<typeof attributesOfArb>, roleNames: readonly string[]) =>
  fc.record({
    assignments: fc.array(fc.record({ subject: assignmentFields.subject, role: fc.oneof({ weight: 1, arbitrary: fc.constantFrom(...IMPLYING_BELOW) }, { weight: 4, arbitrary: fc.constantFrom(...roleNames) }), scope: assignmentFields.scope, tags: assignmentFields.tags, expiry: assignmentFields.expiry }), { minLength: 1, maxLength: 10 }),
    memberships: fc.array(membershipArb, { maxLength: 2 }),
    ceilings: fc.tuple(fc.option(fc.subarray([...roleNames]), { nil: undefined, freq: 4 }), fc.option(fc.subarray([...roleNames]), { nil: undefined, freq: 4 })),
    rules,
    attributes,
    permissions: fc.subarray([...PERMISSIONS], { minLength: 2, maxLength: 2 }),
  });

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
const safetyAttributesArb = attributesOfArb(fc.oneof(fc.integer({ min: 0, max: 3 }), fc.constantFrom('2', '10', 'x')), fc.constantFrom('a', 'zz1', 'b'));
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

type WorldSpec = typeof worldArb extends fc.Arbitrary<infer T> ? T : never;

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function rowsOf(spec: WorldSpec, now: number): Assignment[] {
  const expiresAt = (e: (typeof EXPIRY)[number]) => (e === 'none' ? null : new Date(now + (e === 'past' ? -DAY : DAY)));
  let n = 0;
  return [...spec.assignments.map((a): Assignment => ({ id: `q${++n}`, subject: a.subject, role: a.role, scope: a.scope, tags: [...a.tags], expiresAt: expiresAt(a.expiry), source: 'db' })), ...spec.memberships.map((m): Assignment => ({ id: `q${++n}`, subject: u(m.user), role: 'team.member', scope: at('team', m.team), expiresAt: expiresAt(m.expiry), source: 'db' }))];
}

function attributesOf(spec: WorldSpec): { schemas: ScopeAttributeSchema[]; attributes: [ResourceRef, Record<string, unknown>][] } {
  const a = spec.attributes;
  const schemas: ScopeAttributeSchema[] = [...(a.orgDefaults ? [{ scopeType: 'org', schema: {}, defaults: { policies: { locked: false, level: 1, min: 'viewer' } } }] : []), ...(a.projectDefaults ? [{ scopeType: 'project', schema: {}, defaults: { tier: 'basic' } }] : [])];
  const attributes: [ResourceRef, Record<string, unknown>][] = [[at('org', 'o1'), { policies: defined(a.o1) }], [at('org', 'o2'), { policies: defined(a.o2) }], ...a.projects.map((p, i): [ResourceRef, Record<string, unknown>] => [at('project', ['10', '11', '12', '13'][i]), defined(p)]), ...(a.mode ? [[GLOBAL, { mode: a.mode }] as [ResourceRef, Record<string, unknown>]] : [])];
  return { schemas, attributes: attributes.filter(([, v]) => Object.keys(v).length > 0 && JSON.stringify(v) !== '{"policies":{}}') };
}

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

      it(`for every principal and row, check() allows exactly the rows authz-orm lists and the in-memory list filter keeps (seed ${SEED}, ${RUNS} runs)`, async () => {
        const stats = { withRules: 0, thresholds: 0, terms: 0, listed: 0, refused: 0, sqlMs: 0 };
        const started = Date.now();
        await fc.assert(
          fc.asyncProperty(worldArb, async (spec) => {
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
          { seed: SEED, numRuns: RUNS, endOnFailure: true },
        );
        console.log(`      ${kind}: ${RUNS} runs in ${Date.now() - started} ms (SQL ${stats.sqlMs} ms over ${stats.terms} lists); ${stats.withRules} lists with rule terms, ${stats.thresholds} threshold terms, ${stats.listed} rows listed, ${stats.refused} not`);
        expect(stats.withRules, 'lists with rule terms').to.be.at.least(RUNS);
        expect(stats.thresholds, 'threshold terms').to.be.at.least(RUNS / 2);
        expect(stats.listed, 'rows listed').to.be.at.least(RUNS);
      });

      it(`safety: with condition leaves SQL cannot decide in every rule kind, SQL never lists a row check() refuses (seed ${SEED}, ${SAFETY_RUNS} runs)`, async () => {
        const stats = { terms: 0, routeTerms: 0, thresholdTerms: 0, listed: 0, allowed: 0, gap: 0 };
        const started = Date.now();
        const within = (sub: readonly string[], sup: readonly string[]) => sub.filter((id) => !sup.includes(id));
        await fc.assert(
          fc.asyncProperty(safetyWorldArb, async (spec) => {
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
          { seed: SEED, numRuns: SAFETY_RUNS, endOnFailure: true },
        );
        console.log(`      ${kind}: ${SAFETY_RUNS} safety runs in ${Date.now() - started} ms over ${stats.terms} lists; ${stats.routeTerms} route and ${stats.thresholdTerms} threshold terms; ${stats.listed} rows listed of ${stats.allowed} check() allows (${stats.gap} refused by SQL only)`);
        expect(stats.routeTerms, 'route terms with rules').to.be.at.least(SAFETY_RUNS);
        expect(stats.thresholdTerms, 'threshold terms').to.be.at.least(SAFETY_RUNS / 2);
        expect(stats.listed, 'rows listed').to.be.at.least(SAFETY_RUNS);
      });
    });
  }
});
