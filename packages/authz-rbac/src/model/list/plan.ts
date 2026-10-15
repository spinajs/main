import { GLOBAL, resourceKey } from '@spinajs/authz';
import type { AssignmentSubject, ModelListPlan, PlanTerm, Principal, ResourceType } from '@spinajs/authz';

import { RBAC_ASSIGNMENT_PLAN_OP, rbacPlanArgs } from '../../plan/args.js';
import type { RbacAssignmentPlanArgs, RbacPlanRole } from '../../plan/args.js';
import { subjectKeyOf } from '../../stores/columns.js';
import { subjectKey } from '../assignments.js';
import { roleDenied } from '../deny.js';
import type { LiveAssignment, RbacState } from '../evaluate.js';
import type { CompiledGrant } from '../grants.js';
import { reachableGrants } from '../ladder/steps.js';
import { usableVia } from '../sets/extension.js';
import { principalSubjectKey } from '../sets/keys.js';
import { WILDCARD_ID } from '../sets/resolver.js';

export const DEFAULT_MAX_PLAN_SUBJECTS = 500;
export const RELATION_OWNER_OP = 'relation.owner';
export const RELATION_SELF_OP = 'relation.self';

/** relation.owner / relation.self (overview names table): the row's owner (self) is one of these principals; L4 compiles it. */
export interface RelationPlanArgs {
  readonly principals: readonly { readonly type: string; readonly id: string }[];
}

type Holders = Pick<RbacAssignmentPlanArgs, 'subjects' | 'membership' | 'memberKeys'>;

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const unique = (list: readonly string[]): string[] => [...new Set(list)];
const everywhere = (l: LiveAssignment, type: ResourceType): boolean => l.scope.type === GLOBAL.type || (l.scope.type === type && l.scope.id == null);

/**
 * The list plan of design §6.2 from the state after `cap` of the type-level request `{ type }`: `live` holds
 * the $global and type-level assignments (decided here), `scoped` the others (rbac.assignment terms),
 * `denied` the deny rows. Lane L8 decisions 6-9.
 * @throws Error where a list cannot be planned exactly (rules, a tag carried apart); L2 makes it deny-all model_error
 */
export function rbacListPlan(s: RbacState, opts: { readonly maxSubjects: number }): ModelListPlan {
  const { input, permission } = s;
  const type = input.request.resource.type;
  if ((input.rules?.length ?? 0) > 0 || (input.rowDependentRules?.length ?? 0) > 0) throw new Error(`rbac: rules apply to ${permission} on ${JSON.stringify(type)}, so it is not list-filterable`);
  const ends: number[] = [];
  const bound = (until: Date | undefined) => {
    if (until) ends.push(until.getTime());
  };
  const finish = (plan: ModelListPlan): ModelListPlan => Object.freeze(ends.length > 0 && plan.kind !== 'abstain' ? { ...plan, validUntil: new Date(Math.min(...ends)) } : plan);

  const denying = s.denied.filter((l) => input.grants.denies(l.role, permission));
  const denyAll = denying.filter((l) => everywhere(l, type));
  if (denyAll.length > 0) {
    for (const l of denyAll) bound(l.expiresAt);
    return finish({ kind: 'deny-all', reason: Object.freeze(roleDenied(denyAll.map((l) => l.role))) });
  }

  const entries = new Map<string, RbacPlanRole>();
  const add = (l: LiveAssignment, extra: { readonly scopeTypes?: readonly string[]; readonly tag?: string; readonly relation?: 'owner' | 'self' } = {}) => {
    const scopeTypes = intersect(input.roles.get(l.assignment.role)?.scopeTypes, extra.scopeTypes);
    if (scopeTypes && scopeTypes.length === 0) return;
    const entry: RbacPlanRole = { role: l.assignment.role, ...(scopeTypes ? { scopeTypes } : {}), ...(extra.tag !== undefined ? { tag: extra.tag } : {}), ...(l.onlyBelow ? { descendantsOnly: true } : {}), ...(extra.relation ? { relation: extra.relation } : {}) };
    entries.set(JSON.stringify(entry), entry);
  };
  const relations = new Set<'owner' | 'self'>();
  let all = false;
  const liveTags = new Set(s.live.flatMap((l) => l.tags));

  for (const l of s.live) {
    for (const g of reachableGrants(s, l)) {
      if (!admits(g, type) || (g.grantedAt && !g.grantedAt.includes(l.scope.type))) continue;
      bound(l.expiresAt);
      if (g.requiresTag !== undefined && !liveTags.has(g.requiresTag)) {
        if (g.relations) throw new Error(`rbac: role '${g.role}' grants ${permission} with a relation and tag '${g.requiresTag}', which a list cannot join`);
        // Held everywhere; the rows are those under an assignment carrying the tag.
        for (const c of s.scoped) if (!c.impliedBy && c.tags.includes(g.requiresTag)) add(c, { tag: g.requiresTag });
        continue;
      }
      if (!g.relations) {
        all = true;
        continue;
      }
      for (const r of g.relations) {
        if (r !== 'owner' && r !== 'self') throw new Error(`rbac: role '${g.role}' grants ${permission} with the relation '${r}', which lists do not support`);
        relations.add(r);
      }
    }
  }

  for (const l of s.scoped) {
    for (const g of reachableGrants(s, l)) {
      if (!admits(g, type) || (g.grantedAt && !g.grantedAt.includes(l.scope.type))) continue;
      if (g.relations) {
        // listSupport refuses a relation with requiresTag or grantedAt, so the relation is the only qualifier.
        for (const r of g.relations) {
          if (r !== 'owner' && r !== 'self') throw new Error(`rbac: role '${g.role}' grants ${permission} with the relation '${r}' at ${resourceKey(l.scope)}, which lists do not support`);
          add(l, { relation: r });
        }
        continue;
      }
      const tag = g.requiresTag;
      if (tag === undefined || liveTags.has(tag)) add(l, g.grantedAt ? { scopeTypes: g.grantedAt } : {});
      else if (l.impliedBy && l.tags.includes(tag)) add(l);
      else if (!l.impliedBy && l.tags.includes(tag)) add(l, { tag });
      else if (s.scoped.some((c) => c.tags.includes(tag) && !reachableGrants(s, c).includes(g))) throw new Error(`rbac: tag '${tag}' that ${permission} requires is carried apart from role '${g.role}'; lists follow a tag only on the assignment that grants the role`);
    }
  }

  if (!all && entries.size === 0 && relations.size === 0) return Object.freeze({ kind: 'abstain' });
  const denyRoles = unique(denying.map((l) => l.role)).sort(byCodePoint);
  const deny: PlanTerm[] = denyRoles.length === 0 ? [] : [term(RBAC_ASSIGNMENT_PLAN_OP, rbacPlanArgs({ ...holders(s, true, opts.maxSubjects), roles: denyRoles.map((role) => ({ role })), global: true }))];
  if (all) return finish(deny.length === 0 ? { kind: 'all' } : { kind: 'all', deny: Object.freeze(deny) });
  const permit: PlanTerm[] = [...(entries.size > 0 ? [term(RBAC_ASSIGNMENT_PLAN_OP, rbacPlanArgs({ ...holders(s, false, opts.maxSubjects, bound), roles: [...entries.values()], global: false }))] : []), ...[...relations].sort(byCodePoint).map((r) => term(r === 'owner' ? RELATION_OWNER_OP : RELATION_SELF_OP, relationArgs(input.request.principal)))];
  return finish({ kind: 'terms', permit: Object.freeze(permit), deny: Object.freeze(deny) });
}

const term = (op: string, args: unknown): PlanTerm => Object.freeze({ op, args });

/** The principal and its companions, each once, as the relation resolvers of checks see them. */
function relationArgs(principal: Principal): RelationPlanArgs {
  const seen = new Map<string, { readonly type: string; readonly id: string }>();
  for (const p of [principal, ...(principal.companions ?? [])]) seen.set(JSON.stringify([p.type, p.id]), Object.freeze({ type: p.type, id: p.id }));
  return Object.freeze({ principals: Object.freeze([...seen.values()]) });
}

/** A type-only pattern admits its own type; an `on` id is refused by listSupport and here. */
function admits(g: CompiledGrant, type: ResourceType): boolean {
  if (!g.patterns) return true;
  if (g.patterns.some((p) => p.id !== undefined)) throw new Error(`rbac: role '${g.role}' limits ${g.permission} with \`on\` ids, so it is not list-filterable`);
  return g.patterns.some((p) => p.type === type);
}

function intersect(a: readonly string[] | undefined, b: readonly string[] | undefined): readonly string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((t) => b.includes(t));
}

/**
 * The holders of a term: explicit keys while they are few (their membership expiry bounds the plan), else the
 * membership sub-query (decision 2 of the overview). Permits leave out sets no usable membership reaches and,
 * under a ceiling, nested sets; denies keep every live set.
 */
function holders(s: RbacState, deny: boolean, max: number, bound?: (until: Date | undefined) => void): Holders {
  const { subjects = [], memberships, nestedSets } = s.input;
  const base: AssignmentSubject[] = [];
  const sets: AssignmentSubject[] = [];
  const ends: (Date | undefined)[] = [];
  for (const subject of subjects) {
    const key = subjectKey(subject);
    const entry = 'set' in subject ? memberships?.get(key) : undefined;
    const nested = 'set' in subject ? nestedSets?.get(key) : undefined;
    if (entry) {
      const usable = usableVia(s, entry.via, deny);
      if (usable.length === 0) continue;
      sets.push(subject);
      ends.push(usable.every((m) => m.expiresAt) ? new Date(Math.max(...usable.map((m) => m.expiresAt!.getTime()))) : undefined);
    } else if (nested) {
      if (!deny && s.ceilingRoles !== undefined) continue;
      sets.push(subject);
      ends.push(nested.expiresAt);
    } else {
      base.push(subject);
    }
  }
  // The resolver never yields a principal whose id is '*' (lane decision 1), so `{ type, id: '*' }` here is the wildcard.
  const baseKeys = unique(base.map((b) => ('set' in b || b.id === WILDCARD_ID ? subjectKeyOf(b) : principalSubjectKey(b))));
  const explicit = unique([...baseKeys, ...sets.map(subjectKeyOf)]);
  if (explicit.length <= max) {
    if (bound) for (const end of ends) bound(end);
    return { subjects: explicit, membership: false, memberKeys: [] };
  }
  if (!deny && s.ceilingRoles !== undefined) throw new Error(`rbac: ${explicit.length} subjects exceed authz.rbac.maxPlanSubjects (${max}) under a ceiling`);
  if (baseKeys.length > max) throw new Error(`rbac: ${baseKeys.length} subjects exceed authz.rbac.maxPlanSubjects (${max})`);
  return { subjects: baseKeys, membership: true, memberKeys: baseKeys };
}
