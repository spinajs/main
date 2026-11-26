import type { IContainer } from '@spinajs/di';
import { CacheScope } from './contracts.js';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The segments of every registered CacheScope, each as its class name, its count and its own segments, so that no two
 * answers give one key, also between processes that register different scopes. Ordered by class name (the container
 * keeps one class per name), so a key is the same in every process; null when one says not to cache here.
 */
export function scopeSegments(container: IContainer): readonly string[] | null {
  if (!container.hasRegistered(CacheScope)) return [];
  const scopes = [...container.resolve(Array.ofType(CacheScope))].sort((a, b) => byCodeUnit(a.constructor.name, b.constructor.name));
  const segments: string[] = [];
  for (const scope of scopes) {
    const own = scope.segments();
    if (own === null) return null;
    segments.push(scope.constructor.name, String(own.length), ...own);
  }
  return segments;
}
