import { RawQuery } from '../builders/raw.js';
import type { AlterTableQueryBuilder, TableQueryBuilder } from '../builders/schema/table.js';
import type { OrmDriver, TransactionCallback } from '../driver.js';
import { planMigration, type CallArg, type ColumnCall, type MigrationStep } from './codegen.js';
import type { SchemaChange } from './types.js';

type Invokable = Record<string, (...args: unknown[]) => unknown>;

const argValue = (arg: CallArg): unknown => (typeof arg === 'object' && !Array.isArray(arg) ? RawQuery.create(arg.raw) : arg);

// the same calls `renderColumn` writes into the migration, made on the live builder
function applyColumn(table: TableQueryBuilder | AlterTableQueryBuilder, call: ColumnCall): void {
  let target = (table as unknown as Invokable)[call.method](...call.args.map(argValue));
  for (const link of call.chain) target = (target as Invokable)[link.name](...link.args.map(argValue));
}

/** Runs one planned step on `driver`: what the generated migration's `up()` does for it. */
export async function runStep(driver: OrmDriver, step: MigrationStep): Promise<void> {
  switch (step.kind) {
    case 'createTable':
      await driver.schema().createTable(step.table, (table) => {
        step.columns.forEach((c) => applyColumn(table, c));
        step.foreignKeys.forEach((f) => table.foreignKey(f.column).references(f.table, f.references));
      });
      return;
    case 'alterTable':
      await driver.schema().alterTable(step.table, (table) => {
        step.columns.forEach((c) => applyColumn(table, c));
        step.drops.forEach((d) => table.dropColumn(d));
      });
      return;
    case 'createIndex': {
      const index = driver.index().table(step.table).name(step.name).columns(step.columns);
      await (step.unique ? index.unique() : index);
      return;
    }
    case 'dropIndex':
      await driver.index().table(step.table).name(step.name).drop();
      return;
    case 'dropTable':
      await driver.schema().dropTable(step.table);
  }
}

/**
 * The DDL `changes` run on `driver`'s dialect, compiled without touching the database: the steps run on a copy of the
 * driver whose `executeOnDb` records each statement and answers with no rows.
 */
export async function renderSql(changes: SchemaChange[], driver: OrmDriver, options: { allowDestructive: boolean }): Promise<string[]> {
  const statements: string[] = [];
  let recorded: string[] = [];
  const recorder = Object.create(driver) as OrmDriver & { executeOnDb(statement: string): Promise<unknown[]> };
  recorder.executeOnDb = (statement: string) => {
    recorded.push(statement.trim());
    return Promise.resolve([]);
  };
  // a driver's transaction() sends BEGIN past executeOnDb (sqlite's column rebuild opens one)
  recorder.transaction = <R>(cb: TransactionCallback<R>): Promise<R> => cb(recorder);
  for (const planned of planMigration(changes)) {
    if (planned.destructive && !options.allowDestructive) continue;
    recorded = [];
    try {
      await runStep(recorder, planned.step);
      statements.push(...recorded);
    } catch (err) {
      const line = `-- ${planned.step.kind} ${planned.step.table} is not compiled offline: ${err instanceof Error ? err.message : String(err)}`;
      // a line terminator in a name or in the message would end the comment and turn the rest into SQL
      statements.push(line.replace(/[\r\n\p{Zl}\p{Zp}]/gu, ' '));
    }
  }
  return statements;
}
