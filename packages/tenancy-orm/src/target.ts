import { InvalidOperation } from '@spinajs/exceptions';
import { DeleteQueryBuilder, InsertQueryBuilder, SelectQueryBuilder, TruncateTableQueryBuilder, UpdateQueryBuilder, extractModelDescriptor } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';

import { nameOf, tenantModelOf, tenantModelOfTable } from './registry.js';
import type { TenantModelEntry } from './registry.js';

export interface TenantTarget {
  readonly entry: TenantModelEntry;
  /** The builder carries the tenant model and reads its table: the one shape that is filtered. */
  readonly owned: boolean;
}

/** The statements a tenant scope applies to; schema builders other than truncate are not among them. */
export function isStatement(query: QueryBuilder): boolean {
  return query instanceof SelectQueryBuilder || query instanceof UpdateQueryBuilder || query instanceof DeleteQueryBuilder || query instanceof InsertQueryBuilder || query instanceof TruncateTableQueryBuilder;
}

function verbOf(query: QueryBuilder): string {
  if (query instanceof InsertQueryBuilder) return 'insert';
  if (query instanceof UpdateQueryBuilder) return 'update';
  if (query instanceof DeleteQueryBuilder) return 'delete';
  return query instanceof TruncateTableQueryBuilder ? 'truncate' : 'select';
}

/** The tenant model a statement touches: through its own model, or through the table it reads, in any letter case. */
export function targetOf(query: QueryBuilder): TenantTarget | undefined {
  const table: unknown = query.Table;
  const name = typeof table === 'string' ? table.toLowerCase() : undefined;
  const owned = name !== undefined && extractModelDescriptor(query.Model)?.TableName.toLowerCase() === name;
  const byModel = tenantModelOf(query.Model);
  if (byModel !== undefined) return { entry: byModel, owned };
  // A model that is no tenant model is refused on a tenant table too: it reads every tenant's rows.
  const byTable = name === undefined ? undefined : tenantModelOfTable(name);
  return byTable === undefined ? undefined : { entry: byTable, owned: false };
}

export function statementName(query: QueryBuilder, entry: TenantModelEntry): string {
  return `${verbOf(query)} on tenant table ${entry.table} of ${nameOf(entry.model)}`;
}

/** A table without the column cannot be filtered, so the statement is refused instead of run. */
export function requireColumn(query: QueryBuilder, entry: TenantModelEntry): void {
  const columns = extractModelDescriptor(query.Model)?.Columns ?? [];
  if (!columns.some((column) => column.Name === entry.column)) {
    throw new InvalidOperation(`tenancy-orm: table ${entry.table} of tenant model ${nameOf(entry.model)} has no column ${entry.column}; declare the property on the model and run the migration that adds it`);
  }
}
