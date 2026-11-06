import type { ColumnFamily, Manifest, ModelColumn, SqlDialectProfile, SqlRowColumn } from '@spinajs/manifest';
import type { SqlNode } from './parse.js';

/** A column as raw SQL returns it; `family` picks the type of SUM and AVG over it. */
export interface TypedColumn extends SqlRowColumn { family?: ColumnFamily }

export interface TableInfo {
  name: string;
  columns: Map<string, TypedColumn>;
  /** Some model on the table is `@Model(t, { columns: 'exhaustive' })`, so an undeclared column is an error, not a gap. */
  exhaustive: boolean;
}

/** A FROM item: a model table, or a CTE / subquery whose columns are known (`columns`) or not (`undefined`). */
export interface Source {
  alias: string;
  table?: TableInfo;
  columns?: Map<string, TypedColumn>;
  /** The outer side of a join can produce NULL in every column. */
  nullable: boolean;
}

export interface Scope {
  sources: Source[];
  parent?: Scope;
}

export type Lookup =
  | { kind: 'found'; column: TypedColumn; source: Source }
  | { kind: 'opaque' }
  | { kind: 'missing'; tables: TableInfo[]; alias?: string }
  | { kind: 'ambiguous'; sources: Source[] };

export const nameKey = (name: string): string => name.toLowerCase();

/** Raw SQL bypasses value converters, so only types a driver hands back unchanged are kept; the rest are `unknown`. */
const PORTABLE = /^(number|string|boolean|bigint|Date)$/;
const STRING_LITERALS = /^("[^"]*"|'[^']*')( \| ("[^"]*"|'[^']*'))*$/;

export function rowType(text: string): string {
  return PORTABLE.test(text) || STRING_LITERALS.test(text) ? text : 'unknown';
}

/** A fragment older than `ModelColumn.sql` still says boolean, bigint or Date through the TS type. */
const TS_FAMILIES: Readonly<Record<string, ColumnFamily>> = { boolean: 'boolean', bigint: 'bigint', Date: 'datetime' };

export function columnRowType(column: ModelColumn, profile: SqlDialectProfile): TypedColumn {
  const family = column.sql?.family ?? TS_FAMILIES[column.type.text];
  const raw = family ? profile.families[family] : undefined;
  return { name: column.name, ts: raw ?? rowType(column.type.text), nullable: column.nullable, ...(family ? { family } : {}) };
}

const indexes = new WeakMap<Manifest, WeakMap<SqlDialectProfile, Map<string, Map<string, TableInfo>>>>();

function indexModels(models: Manifest['models'], profile: SqlDialectProfile): Map<string, TableInfo> {
  const tables = new Map<string, TableInfo>();
  for (const model of models) {
    const table = tables.get(nameKey(model.tableName)) ?? { name: model.tableName, columns: new Map<string, TypedColumn>(), exhaustive: false };
    table.exhaustive = table.exhaustive || model.exhaustive === true;
    for (const c of model.columns) {
      if (!table.columns.has(nameKey(c.name))) table.columns.set(nameKey(c.name), columnRowType(c, profile));
    }
    tables.set(nameKey(model.tableName), table);
  }
  return tables;
}

/**
 * The model tables a query resolves against; models mapped to one table contribute the union of their columns (D19).
 * With a `connection`, the models of that connection (A17); every model when the query names none or no model is on it,
 * which keeps `db.Aliases` from causing false SQL002.
 */
export function schemaIndex(manifest: Manifest, connection: string | undefined, profile: SqlDialectProfile): Map<string, TableInfo> {
  const byProfile = indexes.get(manifest) ?? new WeakMap<SqlDialectProfile, Map<string, Map<string, TableInfo>>>();
  indexes.set(manifest, byProfile);
  const byConnection = byProfile.get(profile) ?? new Map<string, Map<string, TableInfo>>();
  byProfile.set(profile, byConnection);
  const key = connection ?? '';
  const cached = byConnection.get(key);
  if (cached) return cached;
  const scoped = connection ? manifest.models.filter((m) => m.connection === connection) : [];
  const tables = indexModels(scoped.length > 0 ? scoped : manifest.models, profile);
  byConnection.set(key, tables);
  return tables;
}

export function asNode(value: unknown): SqlNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as SqlNode) : undefined;
}

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

/** An identifier as the grammars spell it: a string, `{ value }`, `{ expr: { value } }` or a dotted `[{ value }]` list (its last part). */
export function nameOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return nameOf(value[value.length - 1]);
  const node = asNode(value);
  if (!node) return undefined;
  if (typeof node.value === 'string') return node.value;
  if (node.expr !== undefined) return nameOf(node.expr);
  return node.name !== undefined ? nameOf(node.name) : undefined;
}

function columnsOf(source: Source): Map<string, TypedColumn> | undefined {
  return source.table ? source.table.columns : source.columns;
}

function findAlias(scope: Scope | undefined, alias: string): Source | undefined {
  for (let s = scope; s; s = s.parent) {
    const found = s.sources.find((source) => nameKey(source.alias) === nameKey(alias));
    if (found) return found;
  }
  return undefined;
}

function lookupQualified(scope: Scope, alias: string, column: string): Lookup {
  const source = findAlias(scope, alias);
  if (!source) return { kind: 'missing', tables: [], alias };
  const columns = columnsOf(source);
  if (!columns) return { kind: 'opaque' };
  const found = columns.get(nameKey(column));
  if (found) return { kind: 'found', column: found, source };
  return { kind: 'missing', tables: source.table ? [source.table] : [], alias };
}

function lookupUnqualified(scope: Scope, column: string): Lookup {
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    const hits = s.sources.filter((source) => columnsOf(source)?.has(nameKey(column)));
    if (hits.length > 1) return { kind: 'ambiguous', sources: hits };
    if (hits.length === 1) return { kind: 'found', column: columnsOf(hits[0])!.get(nameKey(column))!, source: hits[0] };
    if (s.sources.some((source) => !columnsOf(source))) return { kind: 'opaque' };
  }
  return { kind: 'missing', tables: scope.sources.flatMap((source) => (source.table ? [source.table] : [])) };
}

export function lookupColumn(scope: Scope, alias: string | undefined, column: string): Lookup {
  return alias ? lookupQualified(scope, alias, column) : lookupUnqualified(scope, column);
}
