import type { Diagnostic, ModelIndex, SqlDialectProfile } from '@spinajs/manifest';
import type { IColumnDescriptor } from '../interfaces.js';
import { familiesOf, reportsNullability } from './families.js';
import type { DiffOptions, LiveExtras, LiveTableExtras, SchemaChange, TargetColumn, TargetTable } from './types.js';

interface DiffContext {
  dialect: SqlDialectProfile | undefined;
  diagnostics: Diagnostic[];
  prune: Set<string>;
  base: Map<string, TargetTable>;
  noted: Set<string>;
}

interface Finding {
  reason: string;
  destructive: boolean;
}

type IndexKey = Pick<ModelIndex, 'columns' | 'unique'>;

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

const sameIndex = (a: IndexKey, b: IndexKey): boolean => a.unique === b.unique && a.columns.join('\0') === b.columns.join('\0');

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
  return { reason: column.nullable ? 'NULL allowed' : 'NOT NULL', destructive: failsOnRows(column, extras) };
}

function alterColumn(table: TargetTable, column: TargetColumn, current: IColumnDescriptor, extras: LiveTableExtras | undefined, ctx: DiffContext): SchemaChange | undefined {
  const findings = [typeChange(table.name, column, current, ctx), lengthChange(table.name, column, current, ctx), nullChange(column, current, extras, ctx)].filter((f): f is Finding => f !== undefined);
  if (findings.length === 0) return undefined;
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
  if (ctx.base.get(table.name)?.columns.some((c) => c.name === name)) return `${key} was removed from the models since --base`;
  if (table.exhaustive) return `${table.name} is exhaustive and no model declares ${name}`;
  return ctx.prune.has(key) ? `--prune ${key}` : undefined;
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
      .filter((index) => !columns.find((c) => c.Name === index.columns[0])?.Unique)
      .map((index) => addIndex(table, index));
  }
  const live = extras.indexes.filter((i) => !i.primary);
  const added = wanted.filter((w) => !live.some((l) => sameIndex(l, w))).map((w) => addIndex(table, w));
  const base = ctx.base.get(table.name);
  const removed = base ? live.filter((l) => wantedIndexes(base).some((b) => sameIndex(b, l)) && !wanted.some((w) => sameIndex(w, l))) : [];
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
    if (live.some((l) => l.column === fk.column && l.table === fk.table && l.references === fk.references)) continue;
    note(ctx, 'MIG005', `foreign key ${table.name}.${fk.column} → ${fk.table}.${fk.references} is missing; the schema builder adds foreign keys only in createTable, so add it in a hand-written migration`);
  }
}

function diffTable(table: TargetTable, columns: IColumnDescriptor[], extras: LiveTableExtras | undefined, ctx: DiffContext): SchemaChange[] {
  const out: SchemaChange[] = [];
  for (const column of table.columns) {
    const current = columns.find((c) => c.Name === column.name);
    const change = current ? alterColumn(table, column, current, extras, ctx) : addColumn(table, column, extras);
    if (change) out.push(change);
  }
  for (const current of columns) {
    if (!table.columns.some((c) => c.name === current.Name)) out.push(liveOnly(table, current, ctx));
  }
  noteForeignKeys(table, extras, ctx);
  return [...out, ...diffIndexes(table, columns, extras, ctx)];
}

function droppedTables(target: TargetTable[], live: Map<string, IColumnDescriptor[]>, ctx: DiffContext): SchemaChange[] {
  return [...ctx.base.values()]
    .filter((b) => live.has(b.name) && !target.some((t) => t.name === b.name))
    .map((b): SchemaChange => ({ kind: 'dropTable', table: b.name, detail: { table: b.name }, destructive: true, reason: `${b.name} is mapped by no model since --base` }));
}

/**
 * What it takes to bring `live` to `target` (D10). Only columns the models declare are added or altered; a column no model
 * declares is `unmanaged` and dropped only under the D19 rule 3 conditions. Diagnostics go to `options.diagnostics`.
 */
export function diffSchema(target: TargetTable[], live: Map<string, IColumnDescriptor[]>, extras: LiveExtras = new Map(), options: DiffOptions = {}): SchemaChange[] {
  const ctx: DiffContext = {
    dialect: options.dialect,
    diagnostics: options.diagnostics ?? [],
    prune: new Set(options.prune ?? []),
    base: new Map((options.base ?? []).map((t) => [t.name, t])),
    noted: new Set(),
  };
  const changes: SchemaChange[] = [];
  for (const table of target) {
    const columns = live.get(table.name);
    if (columns) changes.push(...diffTable(table, columns, extras.get(table.name), ctx));
    else changes.push({ kind: 'createTable', table: table.name, detail: table, destructive: false });
  }
  return [...changes, ...droppedTables(target, live, ctx)];
}
