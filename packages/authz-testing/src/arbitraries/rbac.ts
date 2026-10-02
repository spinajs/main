import * as fc from 'fast-check';

import type { Assignment, AssignmentSubject, FieldSet, PrincipalRef, ResourceRef, ResourceType, RuleDef } from '@spinajs/authz';

import { DEFAULT_FIELDS, DEFAULT_PERMISSIONS, DEFAULT_ROLES, DEFAULT_TYPES, dateInRange, fromPool, idOf, optional, scopeRef, sparse, subset, word } from './common.js';
import type { NowOption, RefOptions } from './common.js';
import { permissionGlob, permissionName } from './permissions.js';
import { principalRef } from './principals.js';

// Structural copies of the authz-rbac contracts (GrantDef, RoleDef, LadderDef, ImpliedRole): the kit
// cannot depend on authz-rbac, which pulls in the ORM. The real types accept these as they are.
export interface TestGrantDef {
  readonly permission: string;
  readonly relation?: string | readonly string[];
  readonly on?: readonly { readonly type: ResourceType; readonly id?: string }[];
  readonly fields?: FieldSet;
  readonly requiresTag?: string;
  readonly grantedAt?: readonly ResourceType[];
}

export interface TestImpliedRole {
  readonly role: string;
  readonly at: 'self-and-descendants' | 'descendants';
  readonly tags?: readonly string[];
  readonly bypass?: readonly ('restrict' | 'cap')[];
}

export interface TestRoleDef {
  readonly name: string;
  readonly ladder?: string;
  readonly extends: readonly string[];
  readonly grants: readonly TestGrantDef[];
  readonly implies?: readonly TestImpliedRole[];
  readonly subjectSet?: boolean;
  readonly assignable: boolean;
  readonly scopeTypes?: readonly ResourceType[];
  readonly description?: string;
  readonly source: string;
}

export interface TestLadderDef {
  readonly name: string;
  readonly roles: readonly string[];
  readonly resourceTypes?: readonly ResourceType[];
}

export interface GrantOptions {
  /** Permission pool; `[]` means no grants. */
  readonly permissions?: readonly string[];
  /** Resource types for `on` and `grantedAt`; `[]` leaves them out. */
  readonly types?: readonly ResourceType[];
  readonly maxGrants?: number;
  /** Default true: about one grant in five names a permission glob instead of a permission. */
  readonly globs?: boolean;
}

const ID_PATTERNS = ['a', 'a*', '*', '{principal.id}', '{principal.attributes.pool}-*'];

function grants(opts: GrantOptions): fc.Arbitrary<TestGrantDef[]> {
  const pool = opts.permissions ?? DEFAULT_PERMISSIONS;
  if (pool.length === 0) return fc.constant([]);
  const types = opts.types ?? DEFAULT_TYPES;
  const names = permissionName({ pool });
  const permission = opts.globs === false ? names : fc.oneof({ weight: 4, arbitrary: names }, { weight: 1, arbitrary: permissionGlob({ pool }) });
  const fieldNames = (): fc.Arbitrary<string[]> => fc.subarray([...DEFAULT_FIELDS]);

  const grant = sparse(
    {
      permission,
      relation: fc.oneof(fromPool(['owner', 'member']), fc.array(fromPool(['owner', 'member']), { minLength: 1, maxLength: 2 })),
      ...(types.length ? { on: fc.array(sparse({ type: fromPool(types), id: fromPool(ID_PATTERNS) }, { type: 100, id: 40 }), { minLength: 1, maxLength: 2 }) } : {}),
      fields: sparse({ read: fieldNames(), write: fieldNames(), hide: fieldNames() }, {}, 50),
      requiresTag: word(),
      ...(types.length ? { grantedAt: subset(types, 2) } : {}),
    },
    { permission: 100, relation: 30, on: 40, fields: 30, requiresTag: 20, grantedAt: 30 },
  ) as unknown as fc.Arbitrary<TestGrantDef>;
  return fc.array(grant, { maxLength: opts.maxGrants ?? 3 });
}

export interface RoleGraphOptions extends GrantOptions {
  /** A count, or the exact names; `[]` gives an empty graph. Default 1..6 roles named r0, r1, ... */
  readonly roles?: number | readonly string[];
  /** Default 2. */
  readonly maxExtends?: number;
  /** Default true: edges only point at roles that come earlier in a hidden order. false: any role, itself included. */
  readonly acyclic?: boolean;
  /** Default false. When true, `extends` and `implies` may also name roles that do not exist. */
  readonly dangling?: boolean;
}

const roleNames = (n: number): string[] => Array.from({ length: n }, (_, i) => `r${i}`);

const GHOSTS = ['ghost0', 'ghost1'];

export function roleGraph(opts: RoleGraphOptions = {}): fc.Arbitrary<TestRoleDef[]> {
  const acyclic = opts.acyclic ?? true;
  const maxExtends = opts.maxExtends ?? 2;
  const grantsArb = grants(opts);
  const types = opts.types ?? DEFAULT_TYPES;

  const build = (names: readonly string[]): fc.Arbitrary<TestRoleDef[]> => {
    if (names.length === 0) return fc.constant([]);
    const role = (name: string, at: number): fc.Arbitrary<TestRoleDef> => {
      const reachable = [...(acyclic ? names.slice(0, at) : names), ...(opts.dangling ? GHOSTS : [])];
      const edges = reachable.length ? fc.uniqueArray(fromPool(reachable), { maxLength: Math.min(maxExtends, reachable.length) }) : fc.constant([] as string[]);
      const implied = sparse({ role: fromPool(reachable.length ? reachable : [name]), at: fromPool(['self-and-descendants', 'descendants'] as const), tags: subset(['beta', 'audit']), bypass: subset(['restrict', 'cap'] as const) }, { role: 100, at: 100, tags: 30, bypass: 30 });
      return sparse(
        {
          name: fc.constant(name),
          extends: edges,
          grants: grantsArb,
          assignable: fc.boolean(),
          subjectSet: fc.boolean(),
          ...(types.length ? { scopeTypes: subset(types, 2) } : {}),
          ...(reachable.length ? { implies: fc.array(implied, { minLength: 1, maxLength: 2 }) } : {}),
          description: word(),
          source: fc.constant('test'),
        },
        { name: 100, extends: 100, grants: 100, assignable: 100, source: 100, subjectSet: 50, scopeTypes: 50, implies: 30, description: 30 },
      ) as unknown as fc.Arbitrary<TestRoleDef>;
    };

    // Roles are built in their hidden order and permuted afterwards, so the output order says nothing
    // about which edges point backwards, and nothing in the generator is chained (which would stop shrinking).
    const order = names.map((_, i) => i);
    return fc.tuple(fc.tuple(...names.map(role)), fc.shuffledSubarray(order, { minLength: order.length, maxLength: order.length })).map(([defs, perm]) => perm.map((i) => defs[i]));
  };

  if (Array.isArray(opts.roles)) return build(opts.roles);
  if (typeof opts.roles === 'number') return build(roleNames(Math.max(1, opts.roles)));
  return fc.integer({ min: 1, max: 6 }).chain((n) => build(roleNames(n)));
}

export interface LadderOptions extends GrantOptions {
  readonly names?: readonly string[];
  /** Role pool; `[]` throws, a ladder needs roles. */
  readonly roles?: readonly string[];
  readonly minRoles?: number;
  readonly maxRoles?: number;
}

/** A ladder and its roles, weakest first; every role carries `ladder`. */
export function ladder(opts: LadderOptions = {}): fc.Arbitrary<{ ladder: TestLadderDef; roles: TestRoleDef[] }> {
  const pool = opts.roles ?? DEFAULT_ROLES;
  const min = Math.min(opts.minRoles ?? 2, pool.length);
  const grantsArb = grants(opts);
  const types = opts.types ?? DEFAULT_TYPES;
  return fc
    .tuple(fromPool(opts.names ?? ['project', 'org', 'dept'], 'names'), fc.uniqueArray(fromPool(pool, 'roles'), { minLength: min, maxLength: Math.min(opts.maxRoles ?? 4, pool.length) }), types.length ? optional(subset(types, 2)) : fc.constant(undefined))
    .chain(([name, names, resourceTypes]) =>
      fc.tuple(...names.map(() => fc.tuple(grantsArb, fc.boolean()))).map((parts) => ({
        ladder: { name, roles: names, ...(resourceTypes ? { resourceTypes } : {}) },
        roles: names.map((n, i): TestRoleDef => ({ name: n, ladder: name, extends: [], grants: parts[i][0], assignable: parts[i][1], source: 'test' })),
      })),
    );
}

export interface RuleOptions extends RefOptions, NowOption {
  readonly ladders?: readonly string[];
  readonly roles?: readonly string[];
  readonly scopes?: readonly ResourceRef[];
  readonly principalTypes?: readonly string[];
}

type RuleBase = Pick<RuleDef, 'id' | 'scope' | 'resourceTypes' | 'subjects' | 'expiresAt' | 'source'>;

const scopeOf = (opts: { readonly scopes?: readonly ResourceRef[] } & RefOptions): fc.Arbitrary<ResourceRef> => (opts.scopes?.length ? fromPool(opts.scopes) : scopeRef({ ...opts, global: true }));

function base(opts: RuleOptions): fc.Arbitrary<RuleBase> {
  const kinds = opts.principalTypes?.length ? opts.principalTypes : ['user', 'service', 'agent', 'link'];
  const types = opts.types ?? DEFAULT_TYPES;
  return fc.record(
    {
      id: idOf(opts.ids).map((i) => `rule-${i}`),
      scope: scopeOf(opts),
      ...(types.length ? { resourceTypes: subset(types, 2) } : {}),
      subjects: fc.record({ principalTypes: subset(kinds, 2), actorTypes: subset(kinds, 2), refs: fc.array(principalRef(), { minLength: 1, maxLength: 2 }) }, { requiredKeys: [] }),
      expiresAt: fc.oneof(dateInRange(opts.now), fc.constant(null)),
      source: fc.constant('test'),
    },
    { requiredKeys: ['id', 'scope', 'source'] },
  ) as fc.Arbitrary<RuleBase>;
}

/** Kind 'cap': `maxRole` is a role name, a `{ ref }` or null (drops the assignment). */
export function cap(opts: RuleOptions = {}): fc.Arbitrary<RuleDef> {
  const roles = opts.roles ?? DEFAULT_ROLES;
  const types = opts.types ?? DEFAULT_TYPES;
  const maxRole: fc.Arbitrary<RuleDef['maxRole']> = fc.oneof(
    ...(roles.length ? [{ weight: 4, arbitrary: fromPool(roles) as fc.Arbitrary<RuleDef['maxRole']> }] : []),
    { weight: 1, arbitrary: fromPool(['principal.attributes.max_role', 'scope.org.policies.max_role']).map((ref) => ({ ref })) },
    { weight: 1, arbitrary: fc.constant(null) },
  );
  return fc
    .record(
      {
        base: base(opts),
        ladder: fromPool(opts.ladders ?? ['project', 'org'], 'ladders'),
        maxRole,
        stripTags: fc.boolean(),
        assignments: fc.record({ ...(types.length ? { scopeTypes: subset(types, 2) } : {}), subjectTypes: subset(['user', 'service', 'group'], 2) }, { requiredKeys: [] }),
      },
      { requiredKeys: ['base', 'ladder', 'maxRole'] },
    )
    .map(({ base: b, ...rest }): RuleDef => ({ ...b, kind: 'cap', ...rest }));
}

/** Kind 'restrict': assignments made above `scope` are dropped unless the subject is in `allow`. */
export function restriction(opts: RuleOptions = {}): fc.Arbitrary<RuleDef> {
  const set = fc.record({ role: fromPool(opts.roles ?? DEFAULT_ROLES, 'roles'), scope: scopeOf(opts) }).map((s): AssignmentSubject => ({ set: s }));
  const allow = fc.array(fc.oneof({ weight: 3, arbitrary: principalRef() as fc.Arbitrary<AssignmentSubject> }, { weight: 1, arbitrary: set }), { maxLength: 3 });
  return fc.record({ base: base(opts), allow }).map(({ base: b, allow: a }): RuleDef => ({ ...b, kind: 'restrict', allow: a }));
}

export interface AssignmentOptions extends RefOptions, NowOption {
  /** Default: user, service, group and link refs, so links get grants too. */
  readonly subjects?: fc.Arbitrary<PrincipalRef>;
  readonly roles?: readonly string[];
  readonly scopes?: readonly ResourceRef[];
  /** Include subject sets. Default true. */
  readonly sets?: boolean;
}

export function assignment(opts: AssignmentOptions = {}): fc.Arbitrary<Assignment> {
  const roles = fromPool(opts.roles ?? DEFAULT_ROLES, 'roles');
  const scope = scopeOf(opts);
  const direct: fc.Arbitrary<AssignmentSubject> = opts.subjects ?? principalRef({ ids: opts.ids });
  const set = fc.record({ role: roles, scope }).map((s): AssignmentSubject => ({ set: s }));
  const subject = opts.sets === false ? direct : fc.oneof({ weight: 4, arbitrary: direct }, { weight: 1, arbitrary: set });

  return fc.record(
    {
      id: fc.nat({ max: 99 }).map((n) => `as-${n}`),
      subject,
      role: roles,
      scope,
      tags: fc.array(fromPool(['beta', 'audit', 'billing']), { maxLength: 2 }),
      expiresAt: fc.oneof(dateInRange(opts.now), fc.constant(null)),
      grantedBy: principalRef(),
      source: fc.constant('test'),
    },
    { requiredKeys: ['id', 'subject', 'role', 'scope', 'source'] },
  ) as fc.Arbitrary<Assignment>;
}
