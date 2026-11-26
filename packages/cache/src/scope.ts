import type { IContainer } from '@spinajs/di';
import { CacheScope } from './contracts.js';

/** The segments of every registered CacheScope, providers ordered by class name so a key is the same in every process; null when one says not to cache here. */
export function scopeSegments(container: IContainer): readonly string[] | null {
  if (!container.hasRegistered(CacheScope)) return [];
  const scopes = [...container.resolve(Array.ofType(CacheScope))].sort((a, b) => a.constructor.name.localeCompare(b.constructor.name));
  const segments: string[] = [];
  for (const scope of scopes) {
    const own = scope.segments();
    if (own === null) return null;
    segments.push(...own);
  }
  return segments;
}
