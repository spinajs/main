import { DI } from '@spinajs/di';
import { ConcurrencyConflict, InvalidOperation } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { TenantUnavailable, isTenantId } from '@spinajs/tenancy';

import { TENANCY_CONNECTION, TENANTS_TABLE } from '../connection.js';
import { TenantModel } from '../models/TenantModel.js';

export type LifecycleOperationKind = 'provision' | 'delete';

export interface LifecycleFailure {
  readonly step: string;
  readonly message: string;
  readonly at: string;
}

export interface LifecycleOperation {
  readonly kind: LifecycleOperationKind;
  /** The steps that finished; a retry skips them. */
  readonly done: readonly string[];
  readonly startedAt: string;
  readonly reason?: string;
  readonly failed?: LifecycleFailure;
}

export interface LifecycleExport {
  readonly fs: string;
  readonly path: string;
  readonly at: string;
}

/** The `lifecycle` column of a tenant's row; only the holder of the tenant's lease writes it. */
export interface TenantLifecycleState {
  /** The provisioning or deletion that has not finished. */
  readonly operation?: LifecycleOperation;
  /** The `PerPlacement` migrations applied in the tenant's schema. */
  readonly migrated?: readonly string[];
  readonly exports?: readonly LifecycleExport[];
  /** The modules of the data parts and the event sink the tenant was served with; an export or a deletion needs them all. */
  readonly bridges?: readonly string[];
}

/** The `suspension` column of a tenant's row. */
export interface TenantSuspension {
  readonly reason: string;
  readonly at: string;
}

class Unreadable extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function text(v: unknown): string {
  if (typeof v !== 'string') throw new Unreadable();
  return v;
}

function texts(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Unreadable();
  return v.map((item: unknown) => text(item));
}

function failureOf(v: unknown): LifecycleFailure | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new Unreadable();
  return { step: text(v.step), message: text(v.message), at: text(v.at) };
}

function operationOf(v: unknown): LifecycleOperation | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new Unreadable();
  const kind = v.kind;
  if (kind !== 'provision' && kind !== 'delete') throw new Unreadable();
  const reason = v.reason === undefined ? undefined : text(v.reason);
  const failed = failureOf(v.failed);
  return { kind, done: texts(v.done), startedAt: text(v.startedAt), ...(reason === undefined ? {} : { reason }), ...(failed === undefined ? {} : { failed }) };
}

function exportsOf(v: unknown): LifecycleExport[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Unreadable();
  return v.map((item: unknown) => {
    if (!isRecord(item)) throw new Unreadable();
    return { fs: text(item.fs), path: text(item.path), at: text(item.at) };
  });
}

/** The lifecycle record of `row`, `{}` when it has none. A record it cannot read is refused, never taken as empty. */
export function lifecycleOf(row: TenantModel): TenantLifecycleState {
  const value: unknown = row.lifecycle;
  if (value === null || value === undefined) return {};
  try {
    if (!isRecord(value)) throw new Unreadable();
    const operation = operationOf(value.operation);
    const migrated = value.migrated === undefined ? undefined : texts(value.migrated);
    const exports = exportsOf(value.exports);
    const bridges = value.bridges === undefined ? undefined : texts(value.bridges);
    return {
      ...(operation === undefined ? {} : { operation }),
      ...(migrated === undefined ? {} : { migrated }),
      ...(exports === undefined ? {} : { exports }),
      ...(bridges === undefined ? {} : { bridges }),
    };
  } catch (err) {
    if (err instanceof Unreadable) throw new InvalidOperation(`tenancy-orm: tenant "${row.id}" has an unreadable lifecycle record`);
    throw err;
  }
}

/** The suspension of `row`, undefined when it has none; one it cannot read is refused. */
export function suspensionOf(row: TenantModel): TenantSuspension | undefined {
  const value: unknown = row.suspension;
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value) || typeof value.reason !== 'string' || typeof value.at !== 'string') {
    throw new InvalidOperation(`tenancy-orm: tenant "${row.id}" has an unreadable suspension record`);
  }
  return { reason: value.reason, at: value.at };
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** The tenant table's connection, never a tenant's own one. */
export async function tenancyDriver(): Promise<OrmDriver> {
  const driver = (await DI.resolve(Orm)).Connections.get(TENANCY_CONNECTION);
  if (!driver) throw new InvalidOperation(`tenancy-orm: no connection answers to "${TENANCY_CONNECTION}" (db.Aliases.tenancy)`);
  return driver;
}

/** The row of tenant `id`, read past every cache. */
export async function requireRow(id: string): Promise<TenantModel> {
  const row = isTenantId(id) ? await TenantModel.where('id', id).first() : undefined;
  if (!row) throw new TenantUnavailable('unknown', `tenancy-orm: no tenant "${id}"`);
  return row;
}

const rowsAffected = (result: unknown): number => (isRecord(result) && typeof result.RowsAffected === 'number' ? result.RowsAffected : 0);

/**
 * Writes the lifecycle record of `id` while the lease whose conditions `fence` holds is held. The record is read,
 * changed and written whole, so a writer without the lease would undo what the holder wrote.
 */
export async function writeLifecycle(id: string, state: TenantLifecycleState, fence: Readonly<Record<string, unknown>>): Promise<void> {
  const driver = await tenancyDriver();
  const result: unknown = await driver.update().in(TENANTS_TABLE).update({ lifecycle: JSON.stringify(state) }).where(fence);
  if (rowsAffected(result) !== 1) {
    throw new ConcurrencyConflict(`tenancy-orm: tenant "${id}" was taken over by another lifecycle operation`);
  }
}
