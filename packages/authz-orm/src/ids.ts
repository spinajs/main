import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import { extractModelDescriptor, lookupValue } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { nameOf } from './registry.js';
import type { ModelClass } from './registry.js';

export const refKey = resourceKey;

/** A hydrated id as the text authz_resource_ancestor and the list SQL (CAST AS TEXT) hold. */
export function idText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (typeof value === 'bigint') return value.toString();
  return undefined;
}

/**
 * The value to look `id` up by in `column`, or undefined when no row can have it. Such an id is left out
 * of the query rather than bound: binding it fails the cast on some databases and matches a coerced key on others.
 */
export function idLookup(model: ModelClass, column: string, id: string): string | number | undefined {
  const c = extractModelDescriptor(model as never)?.Columns?.find((x) => x.Name === column);
  return c ? lookupValue(c, id) : id;
}

export function tableOf(model: ModelClass): string {
  const t = extractModelDescriptor(model as never)?.TableName;
  if (typeof t !== 'string' || t === '') throw new AuthzConfigError(`authz-orm: ${nameOf(model)} has no table`);
  return t;
}

export function driverOf(model: ModelClass): OrmDriver {
  const d = extractModelDescriptor(model as never)?.Driver as OrmDriver | undefined;
  if (!d) throw new AuthzConfigError(`authz-orm: ${nameOf(model)} has no ORM connection yet (is the ORM booted?)`);
  return d;
}
