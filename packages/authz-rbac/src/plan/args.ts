/** The term of design §6.2 (lane L8 decision 6). */
export const RBAC_ASSIGNMENT_PLAN_OP = 'rbac.assignment';

export interface RbacPlanRole {
  readonly role: string;
  /** Only assignments made at these scope types count (grantedAt, the role's scopeTypes). */
  readonly scopeTypes?: readonly string[];
  /** The counting assignment itself carries this tag (requiresTag). */
  readonly tag?: string;
  /** At the row's ancestors only, never at the row (implies with at: 'descendants'). */
  readonly descendantsOnly?: boolean;
  /** And the row's owner (self) is one of the principals among `subjects` (a relation grant held at a scope). */
  readonly relation?: 'owner' | 'self';
}

export interface RbacAssignmentPlanArgs {
  /** subjectKeyOf keys whose assignments count. */
  readonly subjects: readonly string[];
  /** Also the sets `memberKeys` belong to, read from authz_subject_membership in the query. */
  readonly membership: boolean;
  readonly memberKeys: readonly string[];
  readonly roles: readonly RbacPlanRole[];
  /** Assignments at $global count too. */
  readonly global: boolean;
}

const ARG_KEYS = ['subjects', 'membership', 'memberKeys', 'roles', 'global'];
const ROLE_KEYS = ['role', 'scopeTypes', 'tag', 'descendantsOnly', 'relation'];

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (list: readonly string[]): readonly string[] => Object.freeze([...new Set(list)].sort(byCodePoint));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Canonical args: equal plans are equal JSON (cache keys, statement caches). */
export function rbacPlanArgs(a: RbacAssignmentPlanArgs): RbacAssignmentPlanArgs {
  const roles = new Map<string, RbacPlanRole>();
  for (const r of a.roles) {
    const role: RbacPlanRole = Object.freeze({ role: r.role, ...(r.scopeTypes ? { scopeTypes: sorted(r.scopeTypes) } : {}), ...(r.tag !== undefined ? { tag: r.tag } : {}), ...(r.descendantsOnly ? { descendantsOnly: true } : {}), ...(r.relation ? { relation: r.relation } : {}) });
    roles.set(JSON.stringify(role), role);
  }
  const list = [...roles].sort(([x], [y]) => byCodePoint(x, y)).map(([, r]) => r);
  return Object.freeze({ subjects: sorted(a.subjects), membership: a.membership, memberKeys: sorted(a.memberKeys), roles: Object.freeze(list), global: a.global });
}

/** @throws Error naming the problem, for anything but the exact shape: a compiler must not guess at args it does not know. */
export function parseRbacPlanArgs(args: unknown): RbacAssignmentPlanArgs {
  const fail = (problem: string): never => {
    throw new Error(`${RBAC_ASSIGNMENT_PLAN_OP}: ${problem}`);
  };
  if (!isObject(args)) return fail('args must be an object');
  const unknown = Object.keys(args).filter((k) => !ARG_KEYS.includes(k));
  if (unknown.length > 0) fail(`unknown args key(s) ${unknown.join(', ')}`);
  const names = (v: unknown, what: string): string[] => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '') ? (v as string[]) : fail(`${what} must be an array of non-empty strings`));
  if (typeof args.membership !== 'boolean') fail('membership must be a boolean');
  if (typeof args.global !== 'boolean') fail('global must be a boolean');
  if (!Array.isArray(args.roles)) fail('roles must be an array');
  const roles = (args.roles as unknown[]).map((r, i): RbacPlanRole => {
    if (!isObject(r)) return fail(`roles[${i}] must be an object`);
    const extra = Object.keys(r).filter((k) => !ROLE_KEYS.includes(k));
    if (extra.length > 0) fail(`roles[${i}] has unknown key(s) ${extra.join(', ')}`);
    const { role, scopeTypes, tag, descendantsOnly, relation } = r;
    if (typeof role !== 'string' || role === '') fail(`roles[${i}].role must be a role name`);
    if (tag !== undefined && (typeof tag !== 'string' || tag === '' || tag.includes(','))) fail(`roles[${i}].tag must be a tag`);
    if (descendantsOnly !== undefined && descendantsOnly !== true) fail(`roles[${i}].descendantsOnly must be true when present`);
    if (relation !== undefined && relation !== 'owner' && relation !== 'self') fail(`roles[${i}].relation must be 'owner' or 'self'`);
    return { role: role as string, ...(scopeTypes !== undefined ? { scopeTypes: names(scopeTypes, `roles[${i}].scopeTypes`) } : {}), ...(tag !== undefined ? { tag: tag as string } : {}), ...(descendantsOnly ? { descendantsOnly: true } : {}), ...(relation !== undefined ? { relation: relation as 'owner' | 'self' } : {}) };
  });
  return rbacPlanArgs({ subjects: names(args.subjects, 'subjects'), membership: args.membership as boolean, memberKeys: names(args.memberKeys, 'memberKeys'), roles, global: args.global as boolean });
}
