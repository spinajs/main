import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';

import { RBAC_ASSIGNMENT_OP } from '../../contracts.js';
import type { CompiledGrant } from '../../model/grants.js';
import type { ImpliedEntry } from '../../model/ladder/implies.js';
import type { CompiledLadder } from '../../model/ladder/ladders.js';
import { assignmentProblem } from '../../model/roles.js';
import type { RbacAssignmentArgsV2 } from '../../model/rules/args.js';
import type { RbacListing } from '../role-graph.js';

/*
 * The constant part of a `native:rbac.assignment` v2 term without rules (design §6.1.2 steps 1 and 5–7,
 * §12.4 "A grant route"), worked out from the role graph and its tables so the SQL only matches stored
 * roles, tags and scope types.
 *
 * A contribution is what step 1 puts in `live` for a row: a live assignment of the subjects on the row's
 * path (its stored role and tags), or a role its role implies at the same scope (the implied role, the
 * entry's tags; 'descendants' not when the assignment is at the row itself). The config roles are
 * contributions of constant GLOBAL assignments. Every one passes `ceiling.roles`, the stored role also
 * `assignmentProblem`. The candidate of the route's grant passes steps 5–7 exactly when, each on its own:
 * - holder: a contribution's role holds the grant's role in its closure (with no cap the effective role
 *   is the role, so a ladder rank compares as a fixed set of roles);
 * - tag (`requiresTag`): a contribution carries the tag;
 * - provenance (`grantedAt`): a contribution made at those scope types counts: for a ladder grant one on
 *   that ladder at or above the grant's rank, else a holder.
 * The ladder's `resourceTypes` decide whether the grant applies on the row type at all.
 */

/** One of the conditions a route term ANDs: some contribution on the row's path meets it. */
export interface RbacRouteNeed {
  readonly what: 'holder' | 'tag' | 'provenance';
  /** A config role (a constant GLOBAL assignment) meets it on every row. */
  readonly config: boolean;
  /** Stored roles whose own contribution meets it. */
  readonly direct: readonly string[];
  /** Stored roles implying a role that meets it at their scope and below. */
  readonly implied: readonly string[];
  /** Stored roles implying a role that meets it below their scope only, so not when assigned at the row itself. */
  readonly impliedBelow: readonly string[];
  /** The direct contribution meets it only when the assignment's stored tags hold this tag. */
  readonly storedTag?: string;
  /** Only assignments made at these scope types meet it. */
  readonly madeAt?: readonly ResourceType[];
}

export interface RbacRoutePlan {
  /** Whether the grant applies on the row type (ladder `resourceTypes`); false: no row is permitted. */
  readonly applies: boolean;
  /** ANDed. */
  readonly needs: readonly RbacRouteNeed[];
}

const refuse = (why: string): AuthzConfigError => new AuthzConfigError(`${RBAC_ASSIGNMENT_OP}: ${why}`);

const stale = (why: string): AuthzConfigError => refuse(`${why}; the roles changed since the term was built, so it is refused rather than compiled against other roles`);

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sameNames = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => JSON.stringify(a === undefined ? a : [...new Set(a)].sort(byCodeUnits)) === JSON.stringify(b === undefined ? b : [...new Set(b)].sort(byCodeUnits));

/** The grant a route names, checked against the current roles. */
export interface RbacRouteGrant {
  readonly grant: CompiledGrant;
  readonly ladder?: CompiledLadder;
  /** The stored roles that can reach the grant (`route.roles`). */
  readonly roles: readonly string[];
}

/**
 * The grant `args.route` names, from the tables the model evaluates with.
 * @throws AuthzConfigError for a route the current roles do not give as the args state it
 */
export function rbacRouteGrant(listing: RbacListing, args: Pick<RbacAssignmentArgsV2, 'permission' | 'route'>): RbacRouteGrant {
  const { roles: graph, grants, ladders, implies } = listing;
  const route = args.route;
  const def = graph.get(route.role)?.def.grants[route.grant];
  if (!def) throw stale(`route ${route.role}#${route.grant} names no grant of the current roles`);
  const grant = grants.grants(route.role, args.permission).find((g) => g.role === route.role && g.def === def);
  if (!grant) throw stale(`grant ${route.role}#${route.grant} does not give '${args.permission}'`);
  const reaches = (role: string): boolean => graph.get(role)?.closure.includes(grant.role) === true;
  const ladder = ladders?.ladderOf(grant.role);
  // routeOf (model/rules/native.ts) states these; the in-memory evaluator reads them from the args.
  const roles = graph.names.filter((r) => reaches(r) || (implies?.of(r) ?? []).some((e) => reaches(e.role)));
  if (ladder?.name !== route.ladder) throw stale(`route ${route.role}#${route.grant} names ladder ${JSON.stringify(route.ladder)}, the role's is ${JSON.stringify(ladder?.name)}`);
  if (grant.requiresTag !== route.requiresTag || !sameNames(grant.grantedAt, route.grantedAt)) throw stale(`route ${route.role}#${route.grant} states requiresTag or grantedAt unlike the grant`);
  if (!sameNames(roles, route.roles)) throw stale(`route ${route.role}#${route.grant} lists roles ${JSON.stringify(route.roles)}, the current roles reach it from ${JSON.stringify([...roles].sort(byCodeUnits))}`);
  return { grant, ...(ladder ? { ladder } : {}), roles };
}

/**
 * The plan of a route term on rows of `rowType`, from the tables the model evaluates with.
 * @throws AuthzConfigError for args with rules (they compile through `RbacRulesSql`), and for a route the current
 *   roles do not give as the args state it
 */
export function rbacRoutePlan(listing: RbacListing, args: RbacAssignmentArgsV2, rowType: ResourceType): RbacRoutePlan {
  if (args.rules.length > 0 || args.dbRules) {
    throw refuse(`args v2 with ${args.dbRules ? 'stored rules (dbRules)' : `${args.rules.length} rule(s)`} have no plan without rules; RbacRulesSql compiles them`);
  }
  const { roles: graph, ladders, implies } = listing;
  const route = args.route;
  const { grant, ladder } = rbacRouteGrant(listing, args);
  const reaches = (role: string): boolean => graph.get(role)?.closure.includes(grant.role) === true;
  const impliedBy = (role: string): readonly ImpliedEntry[] => implies?.of(role) ?? [];

  const ceiling = args.ceilingRoles ? new Set(args.ceilingRoles) : undefined;
  const within = (role: string): boolean => ceiling === undefined || ceiling.has(role);
  const stored = graph.names.filter(within);
  const config = args.config.map((c) => c.role).filter((r) => within(r) && assignmentProblem(graph, r, GLOBAL) === undefined);

  const need = (what: RbacRouteNeed['what'], directMeets: (role: string) => boolean, impliedMeets: (e: ImpliedEntry) => boolean, extra: Pick<RbacRouteNeed, 'storedTag' | 'madeAt'> = {}): RbacRouteNeed => {
    if (extra.madeAt?.length === 0) return { what, config: false, direct: [], implied: [], impliedBelow: [], ...extra };
    const counts = (e: ImpliedEntry) => within(e.role) && impliedMeets(e);
    const implied: string[] = [];
    const impliedBelow: string[] = [];
    for (const r of stored) {
      const entries = impliedBy(r).filter(counts);
      if (entries.some((e) => e.at === 'self-and-descendants')) implied.push(r);
      else if (entries.length > 0) impliedBelow.push(r);
    }
    // GLOBAL is never the row, so a 'descendants' role implied there holds on every row; a config role has no tags.
    const atGlobal = extra.madeAt === undefined || extra.madeAt.includes(GLOBAL.type);
    const fromConfig = atGlobal && config.some((r) => (extra.storedTag === undefined && directMeets(r)) || impliedBy(r).some(counts));
    return { what, config: fromConfig, direct: stored.filter(directMeets), implied, impliedBelow, ...extra };
  };

  const holder = need('holder', reaches, (e) => reaches(e.role));
  // A stored tag never holds ',' (normaliseTags refuses it, parseTags splits on it), so no stored row carries such a tag.
  const storable = route.requiresTag?.includes(',') !== true;
  const tag =
    route.requiresTag === undefined
      ? undefined
      : need(
          'tag',
          () => storable,
          (e) => e.tags.includes(route.requiresTag!),
          { storedTag: route.requiresTag },
        );
  let provenance: RbacRouteNeed | undefined;
  if (grant.grantedAt) {
    const needed = ladder ? ladders!.rankOf(grant.role)! : undefined;
    const counts = (role: string): boolean => (ladder ? ladders!.ladderOf(role) === ladder && ladders!.rankOf(role)! >= needed! : reaches(role));
    provenance = need('provenance', counts, (e) => counts(e.role), { madeAt: [...route.grantedAt!] });
  }
  const needs = [...(provenance && covers(holder, provenance) ? [] : [holder]), ...(tag ? [tag] : []), ...(provenance ? [provenance] : [])];
  return { applies: ladders === undefined || ladders.appliesAt(grant, rowType), needs };
}

/** Every assignment meeting `by` also meets `need` on the same row, so `need` adds nothing to an AND with `by`. */
function covers(need: RbacRouteNeed, by: RbacRouteNeed): boolean {
  if (need.storedTag !== undefined || need.madeAt !== undefined) return false;
  const always = new Set([...need.direct, ...need.implied]);
  const somewhere = new Set([...always, ...need.impliedBelow]);
  return (!by.config || need.config) && [...by.direct, ...by.implied].every((r) => always.has(r)) && by.impliedBelow.every((r) => somewhere.has(r));
}
