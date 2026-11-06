import type { Diagnostic, ModelIndex, SqlDialectProfile } from '@spinajs/manifest';
import { RawQuery } from '../builders/raw.js';
import type { IColumnDescriptor } from '../interfaces.js';
import { familiesOf, reportsNullability } from './families.js';
import { foldTargetTables } from './target.js';
import type { DiffOptions, LiveExtras, LiveTableExtras, SchemaChange, TargetColumn, TargetTable } from './types.js';

interface DiffContext {
  dialect: SqlDialectProfile | undefined;
  diagnostics: Diagnostic[];
  prune: Set<string>;
  base: Map<string, TargetTable>;
  noted: Set<string>;
  /** Identity of a table or column name: case-folded when the dialect compares identifiers that way. */
  fold: (name: string) => string;
}

interface Finding {
  reason: string;
  destructive: boolean;
}

type IndexKey = Pick<ModelIndex, 'columns' | 'unique'>;

const FOLD_NONE = (name: string): string => name;
const FOLD_CASE = (name: string): string => name.toLowerCase();

function note(ctx: DiffContext, code: string, message: string, severity: Diagnostic['severity'] = 'info'): void {
  ctx.diagnostics.push({ code, severity, message });
}

/** MIG003 once per aspect: a missing capability belongs to the driver, not to each column. */
function once(ctx: DiffContext, key: string, message: string): void {
  if (ctx.noted.has(key)) return;
  ctx.noted.add(key);
  note(ctx, 'MIG003', message);
}

const hasDefault = (column: IColumnDescriptor): boolean => column.DefaultValue !== null && column.DefaultValue !== undefined;

/** Without `hasRows` the table is assumed to have rows. */
const failsOnRows = (column: TargetColumn, extras: LiveTableExtras | undefined): boolean =>
  !column.nullable && !column.primary && column.sql.default === undefined && extras?.hasRows !== false;

const sameIndex = (a: IndexKey, b: IndexKey, ctx: DiffContext): boolean => a.unique === b.unique && a.columns.map(ctx.fold).join('\0') === b.columns.map(ctx.fold).join('\0');

const uniqueColumns = (table: TargetTable): ModelIndex[] => table.columns.filter((c) => c.sql.unique && !c.primary).map((c) => ({ columns: [c.name], unique: true }));

const wantedIndexes = (table: TargetTable): ModelIndex[] => [...table.indexes, ...uniqueColumns(table)];

export function indexName(table: string, index: ModelIndex): string {
  return index.name ?? `${index.unique ? 'uq' : 'ix'}_${table}_${index.columns.join('_')}`;
}

function addColumn(table: TargetTable, column: TargetColumn, extras: LiveTableExtras | undefined): SchemaChange {
  if (!failsOnRows(column, extras)) return { kind: 'addColumn', table: table.name, detail: column, destructive: false };
  return { kind: 'addColumn', table: table.name, detail: column, destructive: true, reason: `${table.name}.${column.name} is NOT NULL without a default and the table has rows` };
}

function typeChange(table: string, column: TargetColumn, current: IColumnDescriptor, ctx: DiffContext): Finding | undefined {
  if (!ctx.dialect) {
    once(ctx, `types:${table}`, `types of ${table} not compared: the dialect of the driver is unknown`);
    return undefined;
  }
  const native = current.NativeType || current.Type;
  const families = familiesOf(native, ctx.dialect);
  if (!families) {
    once(ctx, `type:${table}.${column.name}`, `type of ${table}.${column.name} not compared: ${native} is not a known ${ctx.dialect.name} type`);
    return undefined;
  }
  if (families.includes(column.sql.family)) return undefined;
  return { reason: `type ${native} → ${column.sql.family}`, destructive: !(column.sql.family === 'bigint' && families.includes('integer')) };
}

function lengthChange(table: string, column: TargetColumn, current: IColumnDescriptor, ctx: DiffContext): Finding | undefined {
  const wanted = column.sql.length;
  if (column.sql.inferred || wanted === undefined) return undefined;
  if (current.MaxLength <= 0) {
    once(ctx, `lengths:${table}`, `lengths of ${table} not compared: the driver reports none`);
    return undefined;
  }
  return wanted === current.MaxLength ? undefined : { reason: `length ${current.MaxLength} → ${wanted}`, destructive: wanted < current.MaxLength };
}

function nullChange(column: TargetColumn, current: IColumnDescriptor, extras: LiveTableExtras | undefined, ctx: DiffContext): Finding | undefined {
  if (column.sql.inferred || column.primary || column.nullable === current.Nullable || !reportsNullability(ctx.dialect, column.sql.family)) return undefined;
  // A default does not backfill existing NULLs, so SET NOT NULL fails on a table with rows whatever the default.
  return { reason: column.nullable ? 'NULL allowed' : 'NOT NULL', destructive: !column.nullable && extras?.hasRows !== false };
}

/** A modify re-states the whole definition, so an aspect the driver does not report may change unseen. */
function restated(column: TargetColumn, current: IColumnDescriptor, dialect: SqlDialectProfile | undefined): Finding[] {
  const { sql } = column;
  const out: Finding[] = [];
  if (sql.family === 'decimal') {
    out.push({ reason: `precision not compared; re-stated as ${sql.precision === undefined ? "the driver's default" : `(${sql.precision},${sql.scale ?? 0})`}`, destructive: true });
  }
  const lengthEnforced = sql.family === 'binary' || (sql.family === 'text' && !dialect?.unboundedText);
  if (lengthEnforced && sql.length !== undefined && current.MaxLength <= 0) {
    out.push({ reason: `length not compared; re-stated as ${sql.length}`, destructive: true });
  }
  if (sql.default === undefined && !restatableDefault(current.DefaultValue)) {
    out.push({ reason: 'live default not re-statable', destructive: true });
  }
  return out;
}

/** What the codegen can write back on a modify; a converter may have made the live default an object (a `TimeSpan`). */
function restatableDefault(value: unknown): boolean {
  return value === null || value === undefined || value instanceof RawQuery || ['string', 'number', 'boolean'].includes(typeof value);
}

function alterColumn(table: TargetTable, column: TargetColumn, current: IColumnDescriptor, extras: LiveTableExtras | undefined, ctx: DiffContext): SchemaChange | undefined {
  const compared = [typeChange(table.name, column, current, ctx), lengthChange(table.name, column, current, ctx), nullChange(column, current, extras, ctx)].filter((f): f is Finding => f !== undefined);
  if (compared.length === 0) return undefined;
  const findings = [...compared, ...restated(column, current, ctx.dialect)];
  return {
    kind: 'alterColumn',
    table: table.name,
    detail: { column, from: current },
    destructive: findings.some((f) => f.destructive),
    reason: `${table.name}.${column.name}: ${findings.map((f) => f.reason).join(', ')}`,
  };
}

function dropReason(table: TargetTable, name: string, ctx: DiffContext): string | undefined {
  const key = `${table.name}.${name}`;
  if (ctx.base.get(ctx.fold(table.name))?.columns.some((c) => ctx.fold(c.name) === ctx.fold(name))) return `${key} was removed from the models since --base`;
  if (table.exhaustive) return `${table.name} is exhaustive and no model declares ${name}`;
  return ctx.prune.has(ctx.fold(key)) ? `--prune ${key}` : undefined;
}

function liveOnly(table: TargetTable, current: IColumnDescriptor, ctx: DiffContext): SchemaChange {
  const reason = dropReason(table, current.Name, ctx);
  if (reason) return { kind: 'dropColumn', table: table.name, detail: { column: current.Name }, destructive: true, reason };
  const key = `${table.name}.${current.Name}`;
  const models = table.models.join(', ');
  note(ctx, 'MIG002', `column ${key} is declared by no model (${models}) and is left as it is`);
  if (!current.Nullable && !hasDefault(current) && !current.AutoIncrement) {
    note(ctx, 'MIG004', `column ${key} is NOT NULL without a default and no model declares it: inserts through ${models} fail; declare it on a model or give it a default`, 'warning');
  }
  return { kind: 'unmanaged', table: table.name, detail: { column: current.Name, nullable: current.Nullable, hasDefault: hasDefault(current) }, destructive: false };
}

const addIndex = (table: TargetTable, index: ModelIndex): SchemaChange => ({ kind: 'addIndex', table: table.name, detail: { ...index, name: indexName(table.name, index) }, destructive: false });

function diffIndexes(table: TargetTable, columns: IColumnDescriptor[], extras: LiveTableExtras | undefined, ctx: DiffContext): SchemaChange[] {
  const wanted = wantedIndexes(table);
  if (!extras?.indexes) {
    if (table.indexes.length > 0) once(ctx, `indexes:${table.name}`, `indexes of ${table.name} not compared: the driver has no tableIndexes()`);
    return uniqueColumns(table)
      .filter((index) => !columns.find((c) => ctx.fold(c.Name) === ctx.fold(index.columns[0]))?.Unique)
      .map((index) => addIndex(table, index));
  }
  const live = extras.indexes.filter((i) => !i.primary);
  const added = wanted.filter((w) => !live.some((l) => sameIndex(l, w, ctx))).map((w) => addIndex(table, w));
  const base = ctx.base.get(ctx.fold(table.name));
  const removed = base ? live.filter((l) => wantedIndexes(base).some((b) => sameIndex(b, l, ctx)) && !wanted.some((w) => sameIndex(w, l, ctx))) : [];
  const dropped = removed.map((l): SchemaChange => ({ kind: 'dropIndex', table: table.name, detail: { name: l.name }, destructive: true, reason: `index ${l.name} on ${table.name} was removed from the models since --base` }));
  return [...added, ...dropped];
}

function noteForeignKeys(table: TargetTable, extras: LiveTableExtras | undefined, ctx: DiffContext): void {
  if (table.foreignKeys.length === 0) return;
  const live = extras?.foreignKeys;
  if (!live) {
    once(ctx, `fks:${table.name}`, `foreign keys of ${table.name} not compared: the driver has no tableForeignKeys()`);
    return;
  }
  for (const fk of table.foreignKeys) {
    if (live.some((l) => ctx.fold(l.column) === ctx.fold(fk.column) && ctx.fold(l.table) === ctx.fold(fk.table) && ctx.fold(l.references) === ctx.fold(fk.references))) continue;
    note(ctx, 'MIG005', `foreign key ${table.name}.${fk.column} → ${fk.table}.${fk.references} is missing; the schema builder adds foreign keys only in createTable, so add it in a hand-written migration`);
  }
}

function diffTable(table: TargetTable, columns: IColumnDescriptor[], extras: LiveTableExtras | undefined, ctx: DiffContext): SchemaChange[] {
  const out: SchemaChange[] = [];
  for (const column of table.columns) {
    const current = columns.find((c) => ctx.fold(c.Name) === ctx.fold(column.name));
    const change = current ? alterColumn(table, column, current, extras, ctx) : addColumn(table, column, extras);
    if (change) out.push(change);
  }
  for (const current of columns) {
    if (!table.columns.some((c) => ctx.fold(c.name) === ctx.fold(current.Name))) out.push(liveOnly(table, current, ctx));
  }
  noteForeignKeys(table, extras, ctx);
  return [...out, ...diffIndexes(table, columns, extras, ctx)];
}

const keyedBy = <T>(map: Map<string, T>, fold: (name: string) => string): Map<string, T> => new Map([...map].map(([name, value]) => [fold(name), value]));

function droppedTables(target: TargetTable[], live: Map<string, IColumnDescriptor[]>, ctx: DiffContext): SchemaChange[] {
  return [...ctx.base.values()]
    .filter((b) => live.has(ctx.fold(b.name)) && !target.some((t) => ctx.fold(t.name) === ctx.fold(b.name)))
    .map((b): SchemaChange => ({ kind: 'dropTable', table: b.name, detail: { table: b.name }, destructive: true, reason: `${b.name} is mapped by no model since --base` }));
}

/** MIG006: the driver alters a column by rebuilding the table, which it refuses while foreign keys are enforced and another table references it. */
function noteRebuilds(changes: SchemaChange[], liveExtras: LiveExtras, ctx: DiffContext): void {
  if (!ctx.dialect?.alterColumnRebuildsTable) return;
  const references = [
    ...[...liveExtras].flatMap(([from, extras]) => (extras.foreignKeys ?? []).map((fk) => ({ from, to: fk.table }))),
    ...changes.flatMap((c) => (c.kind === 'createTable' ? c.detail.foreignKeys.map((fk) => ({ from: c.table, to: fk.table })) : [])),
  ];
  for (const table of new Set(changes.filter((c) => c.kind === 'alterColumn').map((c) => c.table))) {
    const referrers = new Set(references.filter((r) => ctx.fold(r.to) === ctx.fold(table) && ctx.fold(r.from) !== ctx.fold(table)).map((r) => r.from));
    if (referrers.size === 0) continue;
    note(ctx, 'MIG006', `altering a column of ${table} rebuilds the table when that step runs, which fails while foreign keys are enforced: it is referenced by ${[...referrers].join(', ')}`, 'warning');
  }
}

/**
 * What it takes to bring `live` to `target` (D10). Only columns the models declare are added or altered; a column no model
 * declares is `unmanaged` and dropped only under the D19 rule 3 conditions. Diagnostics go to `options.diagnostics`.
 */
export function diffSchema(models: TargetTable[], liveTables: Map<string, IColumnDescriptor[]>, liveExtras: LiveExtras = new Map(), options: DiffOptions = {}): SchemaChange[] {
  const fold = options.dialect?.caseInsensitiveIdentifiers ? FOLD_CASE : FOLD_NONE;
  const diagnostics = options.diagnostics ?? [];
  const target = foldTargetTables(models, fold, diagnostics);
  const live = keyedBy(liveTables, fold);
  const extras = keyedBy(liveExtras, fold);
  const ctx: DiffContext = {
    dialect: options.dialect,
    diagnostics,
    prune: new Set((options.prune ?? []).map(fold)),
    base: new Map(foldTargetTables(options.base ?? [], fold).map((t) => [fold(t.name), t])),
    noted: new Set(),
    fold,
  };
  const changes: SchemaChange[] = [];
  for (const table of target) {
    const columns = live.get(fold(table.name));
    if (columns) changes.push(...diffTable(table, columns, extras.get(fold(table.name)), ctx));
    else changes.push({ kind: 'createTable', table: table.name, detail: table, destructive: false });
  }
  noteRebuilds(changes, liveExtras, ctx);
  return [...changes, ...droppedTables(target, live, ctx)];
}
