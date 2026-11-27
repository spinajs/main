import { InvalidConfiguration } from '@spinajs/configuration';
import type { FrameworkConfiguration } from '@spinajs/configuration';

export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The first own key of `value`, at any depth, that names a prototype member; undefined when it holds none. */
export function reservedKeyIn(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const found = RESERVED_SEGMENTS.has(key) ? key : reservedKeyIn(child, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** What `configuration.check` returns for a tenant's value; InvalidConfiguration also for a value holding a reserved key. */
export function checkTenantValue(configuration: FrameworkConfiguration, path: string, value: unknown): unknown {
  // A path without a schema is served as a copy, and a copy keeps an own __proto__ key for the consumer's Object.assign.
  const reserved = reservedKeyIn(value);
  if (reserved !== undefined) throw new InvalidConfiguration(`${path}: the value holds the reserved key '${reserved}'`);
  return configuration.check(path, value);
}
