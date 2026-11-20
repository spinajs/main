import { canonicalJson } from '@spinajs/audit';
import type { CapturedRow, RowChange } from '@spinajs/orm';

import type { HistorySpec } from './registry.js';
import type { HistoryOp } from './types.js';

export type { HistoryOp } from './types.js';

export const HISTORY_OPS: readonly HistoryOp[] = ['insert', 'update', 'delete', 'soft_delete', 'restore', 'lost'];

/** Subject id of a `lost` marker: it concerns rows of the entity whose keys were never reported, not one row. */
export const LOST_SUBJECT_ID = '*';

// A type alias, not an interface: it has to be assignable to the `data` record of an audit event.
export type HistoryData = { readonly before?: Record<string, unknown>; readonly after?: Record<string, unknown>; readonly changed?: readonly string[] };

export interface PendingEntry {
  readonly id: string;
  readonly op: HistoryOp;
  readonly data: HistoryData;
}

export function toHistoryValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  return value;
}

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null;

// Two values are the same when the store would keep the same text for them; nearly every column decides on the identity check.
function same(a: unknown, b: unknown): boolean {
  const x = toHistoryValue(a);
  const y = toHistoryValue(b);
  return Object.is(x, y) || (isObject(x) && isObject(y) && canonicalJson(x) === canonicalJson(y));
}
const isNullish = (v: unknown): boolean => v === null || v === undefined;

function visibleRow(spec: HistorySpec, row: CapturedRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!spec.exclude.has(k) && !spec.masked.has(k)) out[k] = toHistoryValue(v);
  return out;
}

function pick(row: CapturedRow, columns: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((c) => [c, toHistoryValue(row[c])]));
}

function updateOp(spec: HistorySpec, before: CapturedRow, after: CapturedRow): HistoryOp {
  const c = spec.softDelete;
  if (c === undefined) return 'update';
  if (isNullish(before[c]) && !isNullish(after[c])) return 'soft_delete';
  if (!isNullish(before[c]) && isNullish(after[c])) return 'restore';
  return 'update';
}

export function historyEntryOf(spec: HistorySpec, change: RowChange): PendingEntry | undefined {
  const { id, before, after } = change;
  if (before === undefined) return after === undefined ? undefined : { id, op: 'insert', data: { after: visibleRow(spec, after) } };
  if (after === undefined) return { id, op: 'delete', data: { before: visibleRow(spec, before) } };
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((c) => !spec.exclude.has(c) && !same(before[c], after[c])).sort();
  if (changed.length === 0) return undefined;
  const visible = changed.filter((c) => !spec.masked.has(c));
  return {
    id,
    op: updateOp(spec, before, after),
    // The capture hands a column-mode row as its key and tracked columns, so `after` is self-contained in both modes.
    data: { before: pick(before, visible), after: visibleRow(spec, after), changed },
  };
}
