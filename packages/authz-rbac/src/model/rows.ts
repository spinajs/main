import { and, or, resourceKey } from '@spinajs/authz';
import type { ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

export const MAX_UNDER_SCOPES = 10_000;

/**
 * The rows of `type` below the scopes of `holders`, canonical: sorted by key, without duplicates;
 * FALSE for none. A holder marked `onlyBelow` (an implied role with at: 'descendants') leaves its
 * scope itself out, which only a row of the scope's own type can be.
 * @throws Error past MAX_UNDER_SCOPES scopes (the engine makes it model_error)
 */
export function underTerm(holders: readonly { readonly scope: ResourceRef; readonly onlyBelow?: boolean }[], type: ResourceType): ResourceFilter {
  const scopes = new Map<string, ResourceRef>();
  const below = new Map<string, ResourceRef>();
  for (const h of holders) (h.onlyBelow && h.scope.type === type ? below : scopes).set(resourceKey(h.scope), { type: h.scope.type, id: h.scope.id });
  for (const key of scopes.keys()) below.delete(key);
  // A list this long belongs in SQL through rbacAssignmentExtension; failing closed beats an unbounded residual.
  if (scopes.size + below.size > MAX_UNDER_SCOPES) throw new Error(`rbac: ${scopes.size + below.size} assignment scopes exceed the ${MAX_UNDER_SCOPES} an under term may hold; use rbacAssignmentExtension for this type`);
  const sorted = (m: Map<string, ResourceRef>) => [...m].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, ref]) => ref);
  const terms: ResourceFilter[] = scopes.size > 0 ? [{ op: 'under', scopes: sorted(scopes) }] : [];
  for (const ref of sorted(below)) terms.push(and({ op: 'under', scopes: [ref] }, { op: 'cmp', field: 'id', cmp: 'ne', value: ref.id! }));
  return or(...terms);
}
