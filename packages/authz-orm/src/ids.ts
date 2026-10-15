import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import { extractModelDescriptor } from '@spinajs/orm';
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

const NUMERIC = /int|serial|number|numeric|decimal|real|float|double/i;
const UUID_TYPE = /^(uuid|uniqueidentifier)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;

/**
 * The value to look `id` up by in `column`, or undefined when no row can have it: binding 'abc'
 * against an integer or uuid column is a cast error on PostgreSQL, not a miss.
 */
export function idLookup(model: ModelClass, column: string, id: string): string | number | undefined {
  const c = extractModelDescriptor(model as never)?.Columns?.find((x) => x.Name === column);
  const type = String(c?.NativeType ?? c?.Type ?? '');
  if (UUID_TYPE.test(type)) return UUID.test(id) ? id : undefined;
  if (NUMERIC.test(type)) {
    if (!INTEGER.test(id)) return undefined;
    const n = Number(id);
    return Number.isSafeInteger(n) ? n : id;
  }
  return id;
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
