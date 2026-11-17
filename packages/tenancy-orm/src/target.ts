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

/** The tenant model a statement touches: through its own model, or through the table it reads. */
export function targetOf(query: QueryBuilder): TenantTarget | undefined {
  const table = query.Table;
  const ownTable = extractModelDescriptor(query.Model)?.TableName;
  const byModel = tenantModelOf(query.Model);
  if (byModel !== undefined) return { entry: byModel, owned: ownTable === table };
  // Another model on its own table is not this package's business, whatever the table is called.
  if (ownTable === table) return undefined;
  const byTable = tenantModelOfTable(table);
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
