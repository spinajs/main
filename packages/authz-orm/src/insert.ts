import { AuthzConfigError, evaluateResidual } from '@spinajs/authz';
import type { EvaluationContext, Principal, RelationResolver, ResourceFilter, SubjectEnv, Truth } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { extractModelDescriptor } from '@spinajs/orm';
import type { InsertQueryBuilder } from '@spinajs/orm';

import type { OrmScopePolicy } from './api.js';
import { columnsOf, dialectOf, idMode, idText, idValue } from './columns.js';
import type { ColumnInfo, Dialect } from './columns.js';
import { scopePolicyOf } from './registry.js';
import type { ModelClass, ResourceEntry } from './registry.js';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/** Relation names in `f`, with whether one occurs under an even number of `not`s. */
export function relationsOf(f: ResourceFilter): Map<string, { positive: boolean }> {
  const out = new Map<string, { positive: boolean }>();
  const walk = (node: unknown, positive: boolean): void => {
    if (!isObject(node)) return;
    switch (node.op) {
      case 'relation':
        if (typeof node.relation === 'string') {
          const prev = out.get(node.relation);
          out.set(node.relation, { positive: positive || prev?.positive === true });
        }
        return;
      case 'not':
        walk(node.arg, !positive);
        return;
      case 'and':
      case 'or':
        if (Array.isArray(node.args)) for (const a of node.args) walk(a, positive);
        return;
    }
  };
  walk(f, true);
  return out;
}

// The evaluator reads a throw from the attribute reader as UNKNOWN.
export class Unknown extends Error {}

const PG_INTEGER = new Set(['int2', 'int4', 'smallint', 'integer']);

/**
 * The value a row will hydrate to, for the values a caller can pass; anything else (a column the
 * insert leaves to its default, a RawQuery, a value the driver converts) is UNKNOWN.
 */
export function insertedValue(info: ColumnInfo, present: boolean, value: unknown, dialect: Dialect): unknown {
  if (!present || value === undefined) throw new Unknown();
  switch (info.kind) {
    case 'string':
      if (value === null || typeof value === 'string') return value;
      break;
    case 'number':
      if (value === null) return value;
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) break;
      // Postgres rounds a fraction written to an integer column.
      if (dialect === 'postgres' && PG_INTEGER.has(String(info.descriptor.NativeType ?? '').toLowerCase()) && !Number.isInteger(value)) break;
      return value;
    case 'boolean':
      // The boolean converter hydrates only 1, '1' and true as true.
      if (value === true || value === 1 || value === '1') return true;
      if (value === false || value === 0 || value === '0' || value === null) return false;
      break;
    case 'opaque':
      return value === null ? null : Object.freeze({});
    case 'converted':
      return Object.freeze({});
  }
  throw new Unknown();
}

interface InsertCheck {
  readonly model: ModelClass;
  readonly entry: ResourceEntry;
  /** The delegation principal. */
  readonly principal: Principal;
  readonly residual: ResourceFilter;
}

/**
 * Conventions §6 inserts: stamp the owner (D-L4-7), let the other relations' policies stamp or
 * refuse, then every row must satisfy the residual in memory. Returns the index of the first row that
 * does not, or -1.
 */
export async function authorizeInsert(builder: InsertQueryBuilder, c: InsertCheck): Promise<number> {
  const columns = columnsOf(c.model);
  const dialect = dialectOf(extractModelDescriptor(c.model as never));
  const relations = relationsOf(c.residual);
  const owner = c.entry.owner;
  const ownerInfo = owner === undefined ? undefined : columns.get(owner);
  if (owner !== undefined && !ownerInfo) throw new AuthzConfigError(`authz-orm: @Owner() of ${c.model.name} is on '${owner}', which is not a column of its table`);

  if (relations.get('owner')?.positive && ownerInfo && c.principal.type === 'user' && typeof c.principal.id === 'string') {
    const value = idValue(idMode(ownerInfo, dialect), c.principal.id, ownerInfo);
    if (value !== undefined) builder.forceColumn(ownerInfo.name, value);
  }

  const stamped = new Set<string>();
  for (const [name, { positive }] of relations) {
    if (!positive || (name === 'owner' && ownerInfo)) continue;
    const cls = scopePolicyOf(c.model, name);
    if (cls === undefined) continue;
    const policy = (await DI.resolve(cls as never)) as OrmScopePolicy;
    if (typeof policy.authorizeCreate !== 'function') continue;
    await policy.authorizeCreate(builder, c.principal);
    stamped.add(name);
  }

  // §4: only a user owns; a column the insert leaves to its default is UNKNOWN.
  const owns = (info: ColumnInfo, row: Record<string, unknown>): Truth => {
    if (c.principal.type !== 'user' || typeof c.principal.id !== 'string') return false;
    if (!Object.hasOwn(row, info.name)) return undefined;
    return idText(idMode(info, dialect), row[info.name]) === c.principal.id;
  };

  const given = [...columns.keys()].map((name) => [name, builder.getColumnValues(name)] as const).filter(([, values]) => values.length > 0);
  for (let i = 0; i < builder.Values.length; i++) {
    const row: Record<string, unknown> = {};
    for (const [name, values] of given) row[name] = values[i];
    const env: SubjectEnv = {
      principal: c.principal,
      ref: { type: c.entry.type },
      attribute: (_subject, field) => {
        const info = columns.get(field);
        if (!info) return undefined;
        if (info.descriptor.Virtual || info.descriptor.Aggregate) throw new Unknown();
        return insertedValue(info, Object.hasOwn(row, field), row[field], dialect);
      },
      relation: (type, name) => {
        const holds = name === 'owner' && ownerInfo ? owns(ownerInfo, row) : stamped.has(name) ? true : undefined;
        return { type, relation: name, holds: async () => holds } as unknown as RelationResolver;
      },
      ancestors: async () => null,
      native: () => undefined,
      ctx: {} as EvaluationContext,
    };
    if ((await evaluateResidual(c.residual, row, env)) !== true) return i;
  }
  return -1;
}
