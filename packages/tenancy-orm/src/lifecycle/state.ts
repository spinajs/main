import { InvalidOperation } from '@spinajs/exceptions';

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

/** The `lifecycle` column `value` of tenant `id`; `{}` when it holds none. */
export function readLifecycle(id: string, value: unknown): TenantLifecycleState {
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
    if (err instanceof Unreadable) throw new InvalidOperation(`tenancy-orm: tenant "${id}" has an unreadable lifecycle record`);
    throw err;
  }
}

/** The `suspension` column `value` of tenant `id`; undefined when it holds none. */
export function readSuspension(id: string, value: unknown): TenantSuspension | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value) || typeof value.reason !== 'string' || typeof value.at !== 'string') {
    throw new InvalidOperation(`tenancy-orm: tenant "${id}" has an unreadable suspension record`);
  }
  return { reason: value.reason, at: value.at };
}
