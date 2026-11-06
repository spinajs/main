import type { ColumnSqlSpec, Diagnostic, ModelIndex, SqlDialectProfile } from '@spinajs/manifest';
import type { LiveForeignKey, LiveIndex } from '../introspection.js';
import type { IColumnDescriptor } from '../interfaces.js';

export interface TargetColumn {
  name: string;
  sql: ColumnSqlSpec;
  nullable: boolean;
  primary: boolean;
}

export interface TargetForeignKey {
  column: string;
  /** The referenced table. */
  table: string;
  references: string;
}

/** One table as the models on a connection declare it: the union of every model mapped to it (D19). */
export interface TargetTable {
  name: string;
  columns: TargetColumn[];
  indexes: ModelIndex[];
  foreignKeys: TargetForeignKey[];
  /** Some model on it is `@Model(t, { columns: 'exhaustive' })`. */
  exhaustive: boolean;
  /** Class names of the models mapped to it. */
  models: string[];
}

export type SchemaChange =
  | { kind: 'createTable'; table: string; detail: TargetTable; destructive: false; reason?: string }
  | { kind: 'dropTable'; table: string; detail: { table: string }; destructive: true; reason: string }
  | { kind: 'addColumn'; table: string; detail: TargetColumn; destructive: boolean; reason?: string }
  | { kind: 'dropColumn'; table: string; detail: { column: string }; destructive: true; reason: string }
  | { kind: 'alterColumn'; table: string; detail: { column: TargetColumn; from: IColumnDescriptor }; destructive: boolean; reason?: string }
  | { kind: 'addIndex'; table: string; detail: ModelIndex & { name: string }; destructive: false; reason?: string }
  | { kind: 'dropIndex'; table: string; detail: { name: string }; destructive: true; reason: string }
  /** A live column no model declares (D19 rule 2): listed, never written to the migration. */
  | { kind: 'unmanaged'; table: string; detail: { column: string; nullable: boolean; hasDefault: boolean }; destructive: false; reason?: string };

export interface LiveTableExtras {
  /** Undefined when the driver has no `tableIndexes()`. */
  indexes?: LiveIndex[];
  /** Undefined when the driver has no `tableForeignKeys()`. */
  foreignKeys?: LiveForeignKey[];
  hasRows?: boolean;
}

export type LiveExtras = Map<string, LiveTableExtras>;

export interface DiffOptions {
  /** The target built from the manifest the database was last generated from (`--base`). */
  base?: TargetTable[];
  /** `table.column` entries of undeclared columns to drop (`--prune`). */
  prune?: string[];
  dialect?: SqlDialectProfile;
  /** Receives MIG002–MIG005. */
  diagnostics?: Diagnostic[];
}
