import type { CompiledGrant } from '../grants.js';
import type { LiveAssignment, RbacState } from '../evaluate.js';

/** The grants of the requested permission that `live` reaches and that apply on the requested resource type. */
export function reachableGrants(s: RbacState, live: LiveAssignment): readonly CompiledGrant[] {
  const grants = s.input.grants.grants(live.role, s.permission);
  const ladders = s.input.ladders;
  if (!ladders) return grants;
  const type = s.input.request.resource.type;
  return grants.filter((g) => ladders.appliesAt(g, type));
}
