import { canonicalJson } from '@spinajs/audit';
import { rowsOf } from '@spinajs/audit-orm';
import type { AuditRow } from '@spinajs/audit-orm';
import { captureKeyText, columnKind, extractModelDescriptor, findColumn, lookupValue } from '@spinajs/orm';
import type { IColumnDescriptor, IModelDescriptor, OrmDriver, SelectQueryBuilder } from '@spinajs/orm';
import { isPlainObject } from '@spinajs/util';

import { visibleRow } from './encode.js';
import { HistoryConfigError } from './errors.js';
import type { HistorySpec } from './registry.js';

type RowImage = Readonly<Record<string, unknown>>;

// One IN list within the bind-parameter limits of every driver, as the write capture reads.
const IN_CHUNK = 500;
const PAGE = 1000;

interface ModelTable {
  readonly driver: OrmDriver;
  readonly descriptor: IModelDescriptor;
}

/** The model's own connection: its rows are there, and so are the transactional events of its writes. */
export function tableOf(spec: HistorySpec): ModelTable {
  const descriptor = extractModelDescriptor(spec.model);
  const driver = descriptor?.Driver;
  if (!descriptor || !driver) throw new HistoryConfigError(`orm-history: ${spec.model.name} has no ORM connection yet (is the ORM booted?)`);
  return { driver, descriptor };
}

const recordedColumns = (spec: HistorySpec): readonly string[] | '*' => (spec.columns === '*' ? '*' : [...new Set([spec.pk, ...spec.columns])]);

// The trail stores an event's payload as canonical JSON, so the image takes the same trip.
function imageOf(spec: HistorySpec, row: AuditRow): RowImage {
  const columns = recordedColumns(spec);
  const projected = columns === '*' ? row : Object.fromEntries(Object.entries(row).filter(([c]) => columns.includes(c)));
  const image: unknown = JSON.parse(canonicalJson(visibleRow(spec, projected)));
  return isPlainObject(image) ? image : {};
}

// Without a model, as the capture reads: raw values, no converter, no model scope, never routed to a replica. A query
// middleware that matches by table (the tenant scope) still runs.
function selectOf(spec: HistorySpec, table: ModelTable): SelectQueryBuilder<unknown> {
  const select: SelectQueryBuilder<unknown> = table.driver.select().from(table.descriptor.TableName);
  const columns = recordedColumns(spec);
  if (columns !== '*') select.columns([...columns]);
  return select;
}

// A key column that ignores case or trailing spaces matches rows in another spelling: only the asked texts are answered.
function addImages(spec: HistorySpec, rows: readonly AuditRow[], out: Map<string, RowImage>, asked?: ReadonlySet<string>): void {
  for (const row of rows) {
    const key = row[spec.pk];
    const id = captureKeyText(key);
    if (id === undefined) throw new HistoryConfigError(`orm-history: a row of ${spec.entity} has a primary key without a text (${key === null ? 'null' : typeof key}), so no id names it`);
    if (asked === undefined || asked.has(id)) out.set(id, imageOf(spec, row));
  }
}

/** The asked ids a row can have, each with the value its key column compares with: the others are left out rather than bound, as the capture does. */
export function possibleKeys(spec: HistorySpec, ids: readonly string[]): ReadonlyMap<string, string | number> {
  const column = findColumn(tableOf(spec).descriptor.Columns, spec.pk);
  const out = new Map<string, string | number>();
  for (const id of ids) {
    const value = column ? lookupValue(column, id) : id;
    if (value !== undefined) out.set(id, value);
  }
  return out;
}

export async function currentRows(spec: HistorySpec, ids: readonly string[]): Promise<ReadonlyMap<string, RowImage>> {
  const table = tableOf(spec);
  const keys = possibleKeys(spec, ids);
  const asked = new Set(keys.keys());
  const values = [...keys.values()];
  const out = new Map<string, RowImage>();
  // spinajs-orm-ignore ORM102: deliberate batching, one query per IN_CHUNK keys
  for (let i = 0; i < values.length; i += IN_CHUNK) addImages(spec, rowsOf(await selectOf(spec, table).whereIn(spec.pk, values.slice(i, i + IN_CHUNK))), out, asked);
  return out;
}

const comparable = (v: unknown): v is string | number | null => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

// Its history cannot tell which rows held a value of a column it does not record before a change.
function recordedColumn(spec: HistorySpec, descriptor: IModelDescriptor, column: string): IColumnDescriptor {
  const columns = recordedColumns(spec);
  const declared = findColumn(descriptor.Columns, column);
  if (declared?.Name === column && !spec.exclude.has(column) && !spec.masked.has(column) && (columns === '*' || columns.includes(column))) return declared;
  throw new HistoryConfigError(`orm-history: ${spec.entity} does not record ${column}, so its history cannot tell which rows matched it`);
}

type Condition = readonly [column: string, bound: string | number | null];

interface Filter {
  readonly conditions: readonly Condition[];
  /** The string values of text columns: a row answers only when it holds each as given. */
  readonly texts: ReadonlyMap<string, string>;
}

// Undefined when no row can match. Every column is checked first, so a refused column is refused whatever comes first.
function filterOf(spec: HistorySpec, descriptor: IModelDescriptor, where: RowImage): Filter | undefined {
  const conditions: Condition[] = [];
  const texts = new Map<string, string>();
  let matchable = true;
  for (const [column, value] of Object.entries(where)) {
    const declared = recordedColumn(spec, descriptor, column);
    if (!comparable(value)) throw new HistoryConfigError(`orm-history: where.${column} must be a string, a finite number or null`);
    // As for a key: a value no row of the column's type can hold is coerced to another value on some databases.
    const bound = value === null ? null : lookupValue(declared, String(value));
    if (bound === undefined) matchable = false;
    else conditions.push([column, bound]);
    if (value !== null && columnKind(declared) === 'text') texts.set(column, String(value));
  }
  return matchable ? { conditions, texts } : undefined;
}

function pageOf(spec: HistorySpec, table: ModelTable, filter: Filter, after: unknown, limit: number): SelectQueryBuilder<unknown> {
  const select = selectOf(spec, table);
  for (const [column, bound] of filter.conditions) {
    if (bound === null) select.whereNull(column);
    else select.where(column, '=', bound);
  }
  if (after !== undefined) select.where(spec.pk, '>', after);
  return select.orderBy(spec.pk).take(limit);
}

export async function currentWhere(spec: HistorySpec, where: RowImage, limit: number): Promise<ReadonlyMap<string, RowImage>> {
  if (!Number.isInteger(limit) || limit < 1) throw new HistoryConfigError('orm-history: limit must be an integer of 1 or more');
  const table = tableOf(spec);
  const filter = filterOf(spec, table.descriptor, where);
  const out = new Map<string, RowImage>();
  if (filter === undefined) return out;
  // A text column compares by its collation, which ignores case or trailing spaces on MySQL and MSSQL: the rows it
  // matched in another spelling are dropped here, and the read pages on by key so that `limit` still holds.
  const asAsked = (row: AuditRow): boolean => {
    const values = new Map(Object.entries(row));
    return [...filter.texts].every(([column, value]) => values.get(column) === value);
  };
  let after: unknown;
  // Each page after the first doubles, so that rows matched only in another spelling cost few statements.
  let size = limit;
  for (;;) {
    // spinajs-orm-ignore ORM102: pages by key until `limit` rows hold the asked texts or the table ends
    const rows = rowsOf(await pageOf(spec, table, filter, after, size));
    addImages(spec, rows.filter(asAsked).slice(0, limit - out.size), out);
    const last = rows.at(-1);
    if (out.size === limit || rows.length < size || last === undefined) return out;
    after = last[spec.pk];
    if (size < PAGE) size = Math.min(PAGE, size * 2);
  }
}
