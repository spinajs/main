import type { ColumnFamily, ColumnSqlSpec, Diagnostic, Manifest, ModelColumn, ModelEntry, ModelIndex } from '@spinajs/manifest';
import type { TargetColumn, TargetTable } from './types.js';

const TS_FAMILIES: Partial<Record<string, ColumnFamily>> = { number: 'integer', string: 'text', boolean: 'boolean', Date: 'datetime', DateTime: 'datetime', Uint8Array: 'binary', Buffer: 'binary' };

/** The column's spec; a fragment built before `@Column` has none, so the family comes from the TypeScript type as D8 infers it. */
export function columnSpecOf(column: ModelColumn): ColumnSqlSpec {
  return column.sql ?? { family: TS_FAMILIES[column.type.text] ?? 'json', inferred: true };
}

/** An inferred integer primary key is `@Primary() Id: number`, which every migration in the repo creates auto-incremented. */
export function autoIncrementOf(column: Pick<TargetColumn, 'sql' | 'primary'>): boolean {
  const { sql } = column;
  return sql.autoIncrement ?? (column.primary && sql.inferred === true && (sql.family === 'integer' || sql.family === 'bigint'));
}

function canonical(spec: ColumnSqlSpec): string {
  const entries = Object.entries(spec).filter(([key]) => key !== 'inferred');
  return JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** An inferred spec only knows the family, so it yields to an explicit spec of that family. */
function mergeSpecs(a: ColumnSqlSpec, b: ColumnSqlSpec): ColumnSqlSpec | undefined {
  if (a.family !== b.family) return undefined;
  if (a.inferred) return b;
  if (b.inferred) return a;
  return canonical(a) === canonical(b) ? a : undefined;
}

function mergeColumn(table: TargetTable, model: ModelEntry, column: ModelColumn, diagnostics: Diagnostic[]): void {
  const incoming: TargetColumn = { name: column.name, sql: columnSpecOf(column), nullable: column.nullable && !column.primary, primary: column.primary };
  const existing = table.columns.find((c) => c.name === column.name);
  if (!existing) {
    table.columns.push(incoming);
    return;
  }
  const merged = mergeSpecs(existing.sql, incoming.sql);
  if (!merged) {
    const message = `column ${table.name}.${column.name} is declared with different specs by ${table.models.join(', ')}: ${canonical(existing.sql)} and ${canonical(incoming.sql)}`;
    diagnostics.push({ code: 'MIG001', severity: 'error', message, source: model.source });
    return;
  }
  existing.sql = merged;
  existing.nullable = existing.nullable || incoming.nullable;
  existing.primary = existing.primary || incoming.primary;
}

const sameIndex = (a: ModelIndex, b: ModelIndex): boolean => a.unique === b.unique && a.columns.join('\0') === b.columns.join('\0');

function addIndexes(table: TargetTable, model: ModelEntry): void {
  for (const index of model.indexes ?? []) {
    if (!table.indexes.some((i) => sameIndex(i, index))) table.indexes.push(index);
  }
}

/** The owning side only: a belongsTo to a model on the same connection. S1 (A3) always records its foreign key and leaves out a primary key that is the target's. */
function addForeignKeys(table: TargetTable, model: ModelEntry, models: ModelEntry[]): void {
  for (const relation of model.relations) {
    if ((relation.kind !== 'belongsTo' && relation.kind !== 'forwardBelongsTo') || !relation.foreignKey) continue;
    const target = models.find((m) => m.className === relation.target);
    const references = relation.primaryKey ?? target?.columns.find((c) => c.primary)?.name;
    if (!target || !references || table.foreignKeys.some((f) => f.column === relation.foreignKey)) continue;
    table.foreignKeys.push({ column: relation.foreignKey, table: target.tableName, references });
  }
}

/**
 * The schema the models on `connections` (a connection and every name that resolves to it) declare: one table per
 * `tableName`, holding the union of the columns of every model mapped to it (D19 rule 1). Conflicting specs are `MIG001`.
 */
export function buildTargetSchema(manifest: Manifest, connections: string | readonly string[], diagnostics: Diagnostic[] = []): TargetTable[] {
  const names = new Set<string>(typeof connections === 'string' ? [connections] : connections);
  const models = manifest.models.filter((m) => names.has(m.connection ?? 'default'));
  const tables = new Map<string, TargetTable>();
  for (const model of models) {
    const table = tables.get(model.tableName) ?? { name: model.tableName, columns: [], indexes: [], foreignKeys: [], exhaustive: false, models: [] };
    tables.set(model.tableName, table);
    table.models.push(model.className);
    table.exhaustive = table.exhaustive || model.exhaustive === true;
    for (const column of model.columns) mergeColumn(table, model, column, diagnostics);
    addIndexes(table, model);
  }
  for (const model of models) {
    const table = tables.get(model.tableName);
    if (table) addForeignKeys(table, model, models);
  }
  return [...tables.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}
