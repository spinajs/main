import { GLOBAL } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, ResourceRef, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';
import * as fc from 'fast-check';

import { DAY, LADDERS, PERMISSIONS, ROLES, at, team, u } from './route-world.js';

/*
 * The random worlds of the rules properties (rules-property.test.ts, db-rules-property.test.ts): assignments,
 * memberships, ceilings, rules of every kind and scope attributes, over route-world.ts.
 */

export type Rule = Omit<RuleDef, 'source'>;
export type When = NonNullable<RuleDef['when']>;

/** A property's runs one process checks: all of them, or one part (`propertyPart`). */
export interface PropertyPart {
  /** fast-check's `numRuns`: the runs up to the end of the part. */
  readonly numRuns: number;
  /** For test titles and logs, e.g. `300 runs` or `runs 75-99 of 300`. */
  readonly label: string;
  /** A coverage minimum of the whole property; a part asserts none, its logged counts add up to the whole. */
  min(n: number): number;
  /** The property's predicate, skipped for the runs before the part. */
  only<T>(check: (value: T) => Promise<void>): (value: T) => Promise<void>;
}

/**
 * `L4B_PROP_CHUNK=k/n` checks part k (from 0) of n of each property, so a part fits a time limit. Every part draws
 * the whole property's worlds (same seed; run i depends on the seed and i only) and checks its own slice of them,
 * so the n parts together check exactly the worlds of one whole run. Unset: the whole property.
 */
export const propertyPart = (() => {
  const spec = process.env.L4B_PROP_CHUNK;
  const m = spec ? /^(\d+)\/(\d+)$/.exec(spec) : null;
  const [k, n] = m ? [Number(m[1]), Number(m[2])] : [0, 1];
  if ((spec && !m) || n < 1 || k >= n) throw new Error(`L4B_PROP_CHUNK=${spec}: want k/n with 0 <= k < n`);
  return (runs: number): PropertyPart => {
    const size = Math.ceil(runs / n);
    const from = Math.min(runs, k * size);
    const to = Math.min(runs, from + size);
    return {
      numRuns: Math.max(1, to),
      label: n === 1 ? `${runs} runs` : `runs ${from}-${to - 1} of ${runs}`,
      min: (x) => (n === 1 ? x : 0),
      only: (check) => {
        // fast-check calls the predicate once per run, in order (no shrinking: the properties end on failure).
        let i = 0;
        return async (value) => {
          const run = i++;
          if (run >= from && run < to) await check(value);
        };
      },
    };
  };
})();

export const ROLE_NAMES = [...ROLES.map((r) => r.name), 'nope'];
const SUBJECTS: readonly AssignmentSubject[] = [u('u1'), u('u2'), u('u3'), { type: 'service', id: 's1' }, { type: 'service', id: 's2' }, team('t1'), team('t2')];
const SCOPES: readonly ResourceRef[] = [GLOBAL, at('doc'), ...['1', '2', '3', '6', '7', '8'].map((id) => at('doc', id)), ...['10', '11', '12', '13'].map((id) => at('project', id)), ...['o1', 'o2', 'O1', 'o10'].map((id) => at('org', id)), at('team', 't1'), at('team', 't2')];
export const RULE_SCOPES: readonly ResourceRef[] = [GLOBAL, GLOBAL, at('org', 'o1'), at('org', 'o2'), at('org', 'O1'), at('project', '10'), at('project', '11'), at('project', '13'), at('doc', '1'), at('doc', '6')];
export const TAGS = ['inspect', 'review', 'x'];
export const EXPIRY = ['none', 'past', 'future'] as const;
const IMPLYING_BELOW = ['team.lead', 'lead.plus', 'robot'];

const assignmentFields = {
  subject: fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SUBJECTS.slice(0, 3)) }, { weight: 2, arbitrary: fc.constantFrom(...SUBJECTS) }),
  scope: fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SCOPES.filter((s) => s.id !== undefined && s.type !== 'team')) }, { weight: 2, arbitrary: fc.constantFrom(...SCOPES) }),
  tags: fc.subarray(TAGS),
  expiry: fc.constantFrom(...EXPIRY),
};
const membershipArb = fc.record({ user: fc.constantFrom('u1', 'u2', 'u3'), team: fc.constantFrom('t1', 't2'), expiry: fc.constantFrom(...EXPIRY) });

export const ladderRoles = (name: string) => LADDERS.find((l) => l.name === name)!.roles;
const ROLE_VALUES = ['viewer', 'commenter', 'editor', 'maintainer', 'org.guest', 'org.owner', 'nope'];

// Scope reads the SQL decides exactly (or faults on, as the check does). A level other than 0/1 against a boolean is UNKNOWN.
export const leafArb = fc.constantFrom<When>({ attr: 'scope.org.policies.locked', eq: true }, { attr: 'scope.org.policies.level', gte: 2 }, { attr: 'scope.org.policies.level', eq: '2' }, { attr: 'scope.org.policies.level', eq: true }, { attr: 'scope.org.policies.level', ne: false }, { attr: 'scope.org.policies.max', in: ['viewer', 'editor'] }, { attr: 'scope.org.policies.max', ne: 'editor' }, { attr: 'scope.project.tier', eq: 'gold' }, { attr: 'scope.project.flag', eq: 1 }, { attr: 'scope.$global.mode', eq: 'strict' }, { attr: 'principal.attributes.contractor', eq: true });
export const whenOf = (leaf: fc.Arbitrary<When>): fc.Arbitrary<When> => fc.oneof({ weight: 4, arbitrary: leaf }, { weight: 1, arbitrary: leaf.map((x) => ({ not: x })) }, { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([a, b]) => ({ any: [a, b] })) }, { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([a, b]) => ({ all: [a, b] })) });
export const whenArb = whenOf(leafArb);
// Leaves the check decides and SQL cannot: a pattern or an order on a string attribute, a numeric string, a ref; under ne and nin too.
export const inexactLeafArb = fc.constantFrom<When>({ attr: 'scope.org.policies.tag', wildcard: 'a*' }, { attr: 'scope.org.policies.tag', glob: 'z*' }, { attr: 'scope.project.tier', like: 'g%' }, { attr: 'scope.org.policies.max', lt: 'f' }, { attr: 'scope.org.policies.level', gte: '2' }, { attr: 'scope.org.policies.level', eq: 2 }, { attr: 'scope.org.policies.max', eq: { ref: 'scope.project.max' } } as unknown as When, { attr: 'scope.org.policies.tag', ne: 1 }, { attr: 'scope.org.policies.tag', nin: [1, 'zz'] });
export const safetyWhenArb = whenOf(fc.oneof({ weight: 1, arbitrary: leafArb }, { weight: 1, arbitrary: inexactLeafArb }));
export const resourceArb = fc.constantFrom<NonNullable<RuleDef['resource']>>({ attr: 'resource.name', wildcard: 'release/*' }, { attr: 'resource.name', glob: 'release/*' }, { attr: 'resource.name', glob: 'release/**' }, { attr: 'resource.name', wildcard: '*1' });
export const rankArb = fc
  .constantFrom('project', 'org')
  .chain((ladder) => fc.record({ ladder: fc.constant(ladder), at: fc.constantFrom('project', 'org'), op: fc.constantFrom('lt', 'eq', 'gte'), role: fc.constantFrom(...ladderRoles(ladder)) }))
  .map(({ ladder, at: node, op, role }) => ({ ladder, at: node, [op]: role } as NonNullable<NonNullable<RuleDef['subjects']>['rank']>));
export const subjectsArb = fc.record({ rank: fc.option(rankArb, { nil: undefined }), principalTypes: fc.option(fc.constantFrom(['user'], ['service']), { nil: undefined, freq: 4 }) }).map((s) => (s.rank || s.principalTypes ? { ...(s.rank ? { rank: s.rank } : {}), ...(s.principalTypes ? { principalTypes: s.principalTypes } : {}) } : undefined));

export const restrictArb = (when: fc.Arbitrary<When>, subjects: fc.Arbitrary<RuleDef['subjects']> = subjectsArb, scopes: readonly ResourceRef[] = RULE_SCOPES) =>
  fc.record({
    scope: fc.constantFrom(...scopes),
    allow: fc.subarray<NonNullable<RuleDef['allow']>[number]>([{ type: 'user', id: 'u1' }, { type: 'service', id: 's1' }, { set: { role: 'team.member', scope: at('team', 't1') } }]),
    when: fc.option(when, { nil: undefined }),
    subjects,
  });
const capArb = (when: fc.Arbitrary<When>, subjects: fc.Arbitrary<RuleDef['subjects']>, scopes: readonly ResourceRef[]) =>
  fc.record({
    scope: fc.constantFrom(...scopes),
    ladder: fc.constantFrom('project', 'org'),
    max: fc.constantFrom('role', 'role', 'null', 'refOrg', 'refProject', 'strip'),
    roleIndex: fc.nat(3),
    stripTags: fc.boolean(),
    scopeTypes: fc.option(fc.subarray(['org', 'project', 'doc', '$global'], { minLength: 1 }), { nil: undefined }),
    subjectTypes: fc.option(fc.subarray(['user', 'service', 'team'], { minLength: 1 }), { nil: undefined }),
    when: fc.option(when, { nil: undefined }),
    subjects,
  });
const thresholdArb = (when: fc.Arbitrary<When>, subjects: fc.Arbitrary<RuleDef['subjects']>, scopes: readonly ResourceRef[]) =>
  fc.record({
    scope: fc.constantFrom(...scopes),
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

export const asRestrict = (r: { scope: ResourceRef; allow: NonNullable<RuleDef['allow']>; when?: When; subjects?: RuleDef['subjects'] }): Omit<Rule, 'id'> => ({ kind: 'restrict' as const, scope: r.scope, allow: r.allow, ...(r.when ? { when: r.when } : {}), ...(r.subjects ? { subjects: r.subjects } : {}) });
export const ruleOf = (when: fc.Arbitrary<When>, subjects: fc.Arbitrary<RuleDef['subjects']> = subjectsArb, scopes: readonly ResourceRef[] = RULE_SCOPES): fc.Arbitrary<Omit<Rule, 'id'>> =>
  fc.oneof(
    restrictArb(when, subjects, scopes).map(asRestrict),
    capArb(when, subjects, scopes).map((r) => {
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
    thresholdArb(when, subjects, scopes).map((r) => {
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
export const attributesOfArb = (level: fc.Arbitrary<number | string>, tag: fc.Arbitrary<string | undefined>) =>
  fc.record({
    o1: policiesOf(level, tag),
    o2: policiesOf(level, tag),
    projects: fc.tuple(...['10', '11', '12', '13'].map(() => fc.record({ tier: maybe(fc.constantFrom('gold', 'basic')), flag: maybe(fc.constantFrom(0, 1, true)), max: maybe(fc.constantFrom(...ROLE_VALUES)) }))),
    mode: maybe(fc.constantFrom('strict', 'lax')),
    orgDefaults: fc.boolean(),
    projectDefaults: fc.boolean(),
  });

export const worldOf = (rules: fc.Arbitrary<Omit<Rule, 'id'>[]>, attributes: ReturnType<typeof attributesOfArb>, roleNames: readonly string[]) =>
  fc.record({
    assignments: fc.array(fc.record({ subject: assignmentFields.subject, role: fc.oneof({ weight: 1, arbitrary: fc.constantFrom(...IMPLYING_BELOW) }, { weight: 4, arbitrary: fc.constantFrom(...roleNames) }), scope: assignmentFields.scope, tags: assignmentFields.tags, expiry: assignmentFields.expiry }), { minLength: 1, maxLength: 10 }),
    memberships: fc.array(membershipArb, { maxLength: 2 }),
    ceilings: fc.tuple(fc.option(fc.subarray([...roleNames]), { nil: undefined, freq: 4 }), fc.option(fc.subarray([...roleNames]), { nil: undefined, freq: 4 })),
    rules,
    attributes,
    permissions: fc.subarray([...PERMISSIONS], { minLength: 2, maxLength: 2 }),
  });

export const safetyAttributesArb = attributesOfArb(fc.oneof(fc.integer({ min: 0, max: 3 }), fc.constantFrom('2', '10', 'x')), fc.constantFrom('a', 'zz1', 'b'));

export type WorldSpec = { readonly assignments: readonly { subject: AssignmentSubject; role: string; scope: ResourceRef; tags: string[]; expiry: (typeof EXPIRY)[number] }[]; readonly memberships: readonly { user: string; team: string; expiry: (typeof EXPIRY)[number] }[]; readonly ceilings: readonly [string[] | undefined, string[] | undefined]; readonly attributes: { o1: Record<string, unknown>; o2: Record<string, unknown>; projects: Record<string, unknown>[]; mode?: string; orgDefaults: boolean; projectDefaults: boolean }; readonly permissions: string[] };

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function rowsOf(spec: WorldSpec, now: number): Assignment[] {
  const expiresAt = (e: (typeof EXPIRY)[number]) => (e === 'none' ? null : new Date(now + (e === 'past' ? -DAY : DAY)));
  let n = 0;
  return [...spec.assignments.map((a): Assignment => ({ id: `q${++n}`, subject: a.subject, role: a.role, scope: a.scope, tags: [...a.tags], expiresAt: expiresAt(a.expiry), source: 'db' })), ...spec.memberships.map((m): Assignment => ({ id: `q${++n}`, subject: u(m.user), role: 'team.member', scope: at('team', m.team), expiresAt: expiresAt(m.expiry), source: 'db' }))];
}

export function attributesOf(spec: WorldSpec): { schemas: ScopeAttributeSchema[]; attributes: [ResourceRef, Record<string, unknown>][] } {
  const a = spec.attributes;
  const schemas: ScopeAttributeSchema[] = [...(a.orgDefaults ? [{ scopeType: 'org', schema: {}, defaults: { policies: { locked: false, level: 1, min: 'viewer' } } }] : []), ...(a.projectDefaults ? [{ scopeType: 'project', schema: {}, defaults: { tier: 'basic' } }] : [])];
  const attributes: [ResourceRef, Record<string, unknown>][] = [[at('org', 'o1'), { policies: defined(a.o1) }], [at('org', 'o2'), { policies: defined(a.o2) }], ...a.projects.map((p, i): [ResourceRef, Record<string, unknown>] => [at('project', ['10', '11', '12', '13'][i]), defined(p)]), ...(a.mode ? [[GLOBAL, { mode: a.mode }] as [ResourceRef, Record<string, unknown>]] : [])];
  return { schemas, attributes: attributes.filter(([, v]) => Object.keys(v).length > 0 && JSON.stringify(v) !== '{"policies":{}}') };
}
