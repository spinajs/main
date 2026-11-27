import { GLOBAL_OBJECT, GLOBAL_TYPE, parseSubjectTypeRef } from '@spinajs/authz-ir';
import type { ObjectRef, PolicyIR, TypeName } from '@spinajs/authz-ir';

/** `k` objects per declared type (`$global` has its one), the principal and the resource; a principal of a type the IR does not declare stands outside the objects. */
export interface Universe {
  readonly k: number;
  readonly objects: Readonly<Record<TypeName, readonly ObjectRef[]>>;
  readonly principal: ObjectRef;
  readonly resource: ObjectRef;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const initial = (type: TypeName): string => /[a-z]/i.exec(type)?.[0].toLowerCase() ?? 'x';

function objects(ir: PolicyIR, k: number): Record<TypeName, ObjectRef[]> {
  const out: Record<TypeName, ObjectRef[]> = {};
  for (const type of Object.keys(ir.types)) out[type] = type === GLOBAL_TYPE ? [GLOBAL_OBJECT] : Array.from({ length: k }, (_, i) => ({ type, id: `${initial(type)}${i + 1}` }));
  return out;
}

/**
 * Types a principal can have: direct and wildcard subjects of stored relations, and types with a `self` relation.
 * A subject type the IR does not declare counts as well: a compiled RBAC policy names `user` in `allowed` lists only.
 */
export function principalTypes(ir: PolicyIR): TypeName[] {
  const out = new Set<TypeName>();
  for (const [name, type] of Object.entries(ir.types)) {
    for (const rel of Object.values(type.relations)) {
      for (const a of rel.allowed.map(parseSubjectTypeRef)) if (a.relation === undefined && a.type !== GLOBAL_TYPE) out.add(rel.source.kind === 'self' ? name : a.type);
    }
  }
  return [...out].sort();
}

/**
 * The universes a bounded query searches for one resource type: one per principal type, and when the principal
 * and the resource share a type, both the principal as the resource and a resource apart from it. By symmetry the
 * first objects stand for any.
 */
export function universes(ir: PolicyIR, k: number, resourceType: TypeName): Universe[] {
  const all = objects(ir, k);
  if (!own(all, resourceType)) return [];
  const out: Universe[] = [];
  for (const type of principalTypes(ir)) {
    // No relation holds on an undeclared type, so its principal needs no objects of its type beside it.
    const principal = own(all, type) ? all[type][0] : { type, id: `${initial(type)}1` };
    out.push({ k, objects: all, principal, resource: all[resourceType][0] });
    if (type === resourceType && all[type].length > 1) out.push({ k, objects: all, principal, resource: all[resourceType][1] });
  }
  return out;
}
