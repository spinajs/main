import { canonicalJson } from '@spinajs/audit';
import type { CapturedRow, RowChange } from '@spinajs/orm';

import type { HistorySpec } from './registry.js';
import type { HistoryOp } from './types.js';

export type { HistoryOp } from './types.js';
export { HISTORY_OPS } from './types.js';

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
  // An invalid date (mysql2's zero DATETIME) is null, as JSON.stringify and canonicalJson write it.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  return value;
}

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null;

// JSON.parse never returns undefined, so it marks text that does not parse.
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// A string, or a number outside strings in group 1.
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const MIN_NORMAL_DOUBLE = 2 ** -1022;

// Fifteen significant digits always survive a double in its normal range. A false positive only keeps the text comparison.
function lossyNumber(token: string): boolean {
  const n = Number(token);
  const digits = token
    .replace(/[eE].*$/, '')
    .replace(/[-.]/g, '')
    .replace(/^0+|0+$/g, '');
  return !Number.isFinite(n) || digits.length > 15 || (digits !== '' && Math.abs(n) < MIN_NORMAL_DOUBLE);
}

const holdsLossyNumber = (text: string): boolean => [...text.matchAll(JSON_TOKEN)].some(([, number]) => number !== undefined && lossyNumber(number));

// sqlite and MSSQL hand a JSON column over as its text, where PostgreSQL and MySQL parse it. Parsing merges numbers a
// double cannot tell apart (beyond 2^53, 1e400 and null), so such text keeps the text comparison.
function sameJsonText(a: string, b: string): boolean {
  if (holdsLossyNumber(a) || holdsLossyNumber(b)) return false;
  const x = parsedJson(a);
  const y = parsedJson(b);
  return x !== undefined && y !== undefined && canonicalJson(x) === canonicalJson(y);
}

// Two values are the same when the store would keep the same text for them; nearly every column decides on the identity check.
function same(a: unknown, b: unknown, json: boolean): boolean {
  if (json && typeof a === 'string' && typeof b === 'string' && a !== b) return sameJsonText(a, b);
  const x = toHistoryValue(a);
  const y = toHistoryValue(b);
  return Object.is(x, y) || (isObject(x) && isObject(y) && canonicalJson(x) === canonicalJson(y));
}
const isNullish = (v: unknown): boolean => v === null || v === undefined;

function visibleRow(spec: HistorySpec, row: CapturedRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([k]) => !spec.exclude.has(k) && !spec.masked.has(k))
      .map(([k, v]) => [k, toHistoryValue(v)]),
  );
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
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((c) => !spec.exclude.has(c) && !same(before[c], after[c], spec.json.has(c))).sort();
  if (changed.length === 0) return undefined;
  const visible = changed.filter((c) => !spec.masked.has(c));
  return {
    id,
    op: updateOp(spec, before, after),
    // The capture hands a column-mode row as its key and tracked columns, so `after` is self-contained in both modes.
    data: { before: pick(before, visible), after: visibleRow(spec, after), changed },
  };
}
