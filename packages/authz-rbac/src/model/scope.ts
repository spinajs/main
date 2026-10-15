import { GLOBAL, resourceKey } from '@spinajs/authz';
import type { ResourceRef, ResourceType } from '@spinajs/authz';

/**
 * Whether an assignment scope applies to a resource of `type` with this path: GLOBAL, a node of the
 * path by key, or the type-only scope of `type` itself. A type-only scope of another type reaches
 * nothing: the engine reads a type-only `under` scope differently, so no row filter may depend on one.
 */
export function scopeMatcher(type: ResourceType, path: readonly ResourceRef[]): (scope: ResourceRef) => boolean {
  const keys = new Set([...path, GLOBAL, { type }].map(resourceKey));
  return (scope) => keys.has(resourceKey(scope));
}
