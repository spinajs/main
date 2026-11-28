import type { PolicyIR, RelationName, TypeName } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import type { HolderRef, RewriteAutomaton } from './graph.js';
import { explore, reachersOf } from './monotone.js';
import type { Exploration, Reacher } from './monotone.js';
import { matchesHolder } from './verdict.js';

/** Does a `role:<r>@<t>`, `role:<r>` or `<t>#<rel>` selector name the relation `type#relation`? */
export function namesRelation(ir: PolicyIR, selector: string, type: TypeName, relation: RelationName): boolean {
  const role = /^role:([^@]+)(?:@(.+))?$/.exec(selector);
  if (role !== null) return (ir.principal.roles[role[1]] ?? []).some((r) => r.type === type && r.relation === relation && (role[2] === undefined || role[2] === r.type));
  return selector === `${type}#${relation}`;
}

/**
 * Reachers whose path reads the relation the selector names behind a subject set: whoever the set holds is its member
 * too. For `public:<t>#<rel>` only the paths that end on a wildcard, as its holder reads them.
 */
function reachedBehind(ir: PolicyIR, a: RewriteAutomaton, permission: Permission, start: string, selector: string): Reacher[] {
  const wildcard = selector.startsWith('public:');
  const held = wildcard ? selector.slice('public:'.length) : selector;
  const ex = explore(a, start, undefined, (e) => namesRelation(ir, held, e.type, e.relation));
  return reachersOf(ir, permission, { ...ex, accepted: ex.accepted.filter((x) => x.behind === true && (!wildcard || x.holder.kind === 'public')) });
}

/**
 * The reachers of `permission` the selector selects, as `never()` reads them, and the exploration they come from (none
 * for an unbound permission). A reacher is labelled by its relation's first role only, so a relation is matched by every
 * role that holds it, and a public member of that relation is one of its holders. The match runs inside the exploration:
 * it keeps one path per holder key, and a role's key names no relation. `anyone` also selects every anyone term.
 */
export function selectedReachers(ir: PolicyIR, a: RewriteAutomaton, permission: Permission, selector: string, anyone: boolean): { readonly hits: Reacher[]; readonly exploration?: Exploration } {
  const start = a.start(permission);
  if (start === undefined) return { hits: [] };
  const selected = (h: HolderRef): boolean => (h.kind === 'anyone' ? anyone : matchesHolder(selector, h) || namesRelation(ir, selector, h.type, h.relation));
  const exploration = explore(a, start, selected);
  return { hits: [...reachersOf(ir, permission, exploration), ...reachedBehind(ir, a, permission, start, selector)], exploration };
}
