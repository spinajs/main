import { InvalidArgument } from '@spinajs/exceptions';
import type { ColumnFamily, ColumnSqlSpec, ModelIndex } from '@spinajs/manifest';
import { DateTime } from 'luxon';
import type { IColumnDescriptor } from '../interfaces.js';
import { indexName } from './diff.js';
import { autoIncrementOf } from './target.js';
import type { SchemaChange, TargetColumn, TargetForeignKey, TargetTable } from './types.js';

export type CallArg = string | number | string[] | { raw: string };

/** One schema-builder column call: `table.<method>(...args).<chain…>`. */
export interface ColumnCall {
  method: string;
  args: CallArg[];
  chain: Array<{ name: string; args: CallArg[] }>;
}

export type MigrationStep =
  | { kind: 'createTable'; table: string; columns: ColumnCall[]; foreignKeys: TargetForeignKey[] }
  | { kind: 'alterTable'; table: string; columns: ColumnCall[]; drops: string[] }
  | { kind: 'createIndex'; table: string; name: string; columns: string[]; unique: boolean }
  | { kind: 'dropIndex'; table: string; name: string }
  | { kind: 'dropTable'; table: string };

export interface PlannedStep {
  step: MigrationStep;
  destructive: boolean;
  reason?: string;
  /** What `down()` runs; absent when the step is not reversed. */
  undo?: MigrationStep;
}

export interface GenerateOptions {
  name: string;
  connection: string;
  allowDestructive: boolean;
  now: Date;
}

export type ActionableChange = Exclude<SchemaChange, { kind: 'unmanaged' }>;

type CreateChange = Extract<ActionableChange, { kind: 'createTable' }>;
type ColumnMode = 'create' | 'add' | 'modify';
type TypeCall = Pick<ColumnCall, 'method' | 'args'>;

export const isActionable = (change: SchemaChange): change is ActionableChange => change.kind !== 'unmanaged';

// What MIGRATION_FILE_REGEXP reads back: the prefix may not carry underscore-digit runs of its own.
const NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const STEP_ORDER: Record<ActionableChange['kind'], number> = { createTable: 0, addColumn: 1, alterColumn: 2, addIndex: 3, dropIndex: 4, dropColumn: 5, dropTable: 6 };

const plain =
  (method: string) =>
  (): TypeCall => ({ method, args: [] });

const TYPE_CALLS: Record<ColumnFamily, (spec: ColumnSqlSpec, mode: ColumnMode) => TypeCall> = {
  integer: plain('int'),
  bigint: plain('bigint'),
  decimal: (s) => ({ method: 'decimal', args: s.precision === undefined ? [] : [s.precision, s.scale ?? 0] }),
  float: plain('double'),
  text: (s) => (s.length === undefined ? { method: 'text', args: [] } : { method: 'string', args: [s.length] }),
  boolean: plain('boolean'),
  date: plain('date'),
  datetime: plain('dateTime'),
  time: plain('time'),
  json: plain('json'),
  binary: (s) => (s.length === undefined ? { method: 'longblob', args: [] } : { method: 'binary', args: [s.length] }),
  // only TableQueryBuilder has uuid(); it is binary(16) there as well
  uuid: (_s, mode) => (mode === 'create' ? { method: 'uuid', args: [] } : { method: 'binary', args: [16] }),
  enum: (s) => ({ method: 'enum', args: [s.enumValues ?? []] }),
};

function defaultChain(value: ColumnSqlSpec['default']): ColumnCall['chain'] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object') return [{ name: 'default', args: [] }, { name: 'value', args: [typeof value === 'boolean' ? Number(value) : value] }];
  const raw = value.raw.trim().toUpperCase();
  if (raw === 'CURRENT_TIMESTAMP') return [{ name: 'default', args: [] }, { name: 'dateTime', args: [] }];
  if (raw === 'CURRENT_DATE') return [{ name: 'default', args: [] }, { name: 'date', args: [] }];
  return [{ name: 'default', args: [] }, { name: 'raw', args: [{ raw: value.raw }] }];
}

/** The live default as a spec default, when it is a plain value; anything else is the database's to keep. */
function liveDefault(from: IColumnDescriptor): ColumnSqlSpec['default'] {
  const value: unknown = from.DefaultValue;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
}

/**
 * The schema-builder call for `column`. On `modify`, `from` (the live column) supplies every aspect the spec does not
 * state: the dialect compilers rebuild the whole definition, so an aspect left out would be dropped, not kept (D19).
 */
export function columnCall(column: TargetColumn, mode: ColumnMode, from?: IColumnDescriptor): ColumnCall {
  const { sql } = column;
  const type = TYPE_CALLS[sql.family](sql, mode);
  const chain: ColumnCall['chain'] = [];
  const flag = (name: string, on: boolean | undefined): void => {
    if (on) chain.push({ name, args: [] });
  };
  const keep = mode === 'modify' ? from : undefined;
  flag('modify', mode === 'modify');
  flag('primaryKey', column.primary);
  flag('autoIncrement', autoIncrementOf(column));
  // an inferred spec states no nullability (amendment 7), so the live column decides
  flag('notNull', keep && sql.inferred ? !keep.Nullable : !column.nullable);
  flag('unique', (sql.unique ?? keep?.Unique === true) && !column.primary);
  flag('unsigned', sql.unsigned ?? keep?.Unsigned);
  chain.push(...defaultChain(sql.default !== undefined || !keep ? sql.default : liveDefault(keep)));
  return { method: type.method, args: [column.name, ...type.args], chain };
}

const quote = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function renderArg(arg: CallArg): string {
  if (typeof arg === 'string') return quote(arg);
  if (typeof arg === 'number') return String(arg);
  if (Array.isArray(arg)) return `[${arg.map(quote).join(', ')}]`;
  return `RawQuery.create(${quote(arg.raw)})`;
}

const renderCall = (name: string, args: CallArg[]): string => `${name}(${args.map(renderArg).join(', ')})`;

const renderColumn = (call: ColumnCall): string => `table.${[renderCall(call.method, call.args), ...call.chain.map((c) => renderCall(c.name, c.args))].join('.')};`;

/** The lines of one step inside `up()`/`down()`, without the method's indentation. */
export function renderStep(step: MigrationStep): string[] {
  switch (step.kind) {
    case 'createTable':
      return [
        `await connection.schema().createTable(${quote(step.table)}, (table) => {`,
        ...step.columns.map((c) => `  ${renderColumn(c)}`),
        ...step.foreignKeys.map((f) => `  table.foreignKey(${quote(f.column)}).references(${quote(f.table)}, ${quote(f.references)});`),
        '});',
      ];
    case 'alterTable':
      return [`await connection.schema().alterTable(${quote(step.table)}, (table) => {`, ...step.columns.map((c) => `  ${renderColumn(c)}`), ...step.drops.map((d) => `  table.dropColumn(${quote(d)});`), '});'];
    case 'createIndex':
      return [`await connection.index()${step.unique ? '.unique()' : ''}.table(${quote(step.table)}).name(${quote(step.name)}).columns(${renderArg(step.columns)});`];
    case 'dropIndex':
      return [`await connection.index().table(${quote(step.table)}).name(${quote(step.name)}).drop();`];
    case 'dropTable':
      return [`await connection.schema().dropTable(${quote(step.table)});`];
  }
}

const indexStep = (table: string, index: ModelIndex): MigrationStep => ({ kind: 'createIndex', table, name: indexName(table, index), columns: index.columns, unique: index.unique });

const createStep = (table: TargetTable): MigrationStep => ({ kind: 'createTable', table: table.name, columns: table.columns.map((c) => columnCall(c, 'create')), foreignKeys: table.foreignKeys });

const alterStep = (table: string, columns: ColumnCall[], drops: string[] = []): MigrationStep => ({ kind: 'alterTable', table, columns, drops });

function plannedSteps(change: ActionableChange): PlannedStep[] {
  const base = { destructive: change.destructive, ...(change.reason ? { reason: change.reason } : {}) };
  switch (change.kind) {
    case 'createTable':
      // the indexes go with the table, so dropping the table undoes them
      return [{ ...base, step: createStep(change.detail), undo: { kind: 'dropTable', table: change.table } }, ...change.detail.indexes.map((index) => ({ destructive: false, step: indexStep(change.table, index) }))];
    case 'addColumn':
      return [{ ...base, step: alterStep(change.table, [columnCall(change.detail, 'add')]), undo: alterStep(change.table, [], [change.detail.name]) }];
    case 'alterColumn':
      return [{ ...base, step: alterStep(change.table, [columnCall(change.detail.column, 'modify', change.detail.from)]) }];
    case 'dropColumn':
      return [{ ...base, step: alterStep(change.table, [], [change.detail.column]) }];
    case 'addIndex':
      return [{ ...base, step: indexStep(change.table, change.detail), undo: { kind: 'dropIndex', table: change.table, name: change.detail.name } }];
    case 'dropIndex':
      return [{ ...base, step: { kind: 'dropIndex', table: change.table, name: change.detail.name } }];
    case 'dropTable':
      return [{ ...base, step: { kind: 'dropTable', table: change.table } }];
  }
}

/** Created tables ordered so a referenced table comes first; a table pointing at itself is fine. */
function byDependency(creates: CreateChange[]): CreateChange[] {
  const out: CreateChange[] = [];
  const seen = new Set<string>();
  const visit = (change: CreateChange): void => {
    if (seen.has(change.table)) return;
    seen.add(change.table);
    for (const fk of change.detail.foreignKeys) {
      const dependency = creates.find((c) => c.table === fk.table);
      if (dependency) visit(dependency);
    }
    out.push(change);
  };
  creates.forEach(visit);
  return out;
}

/** The steps a migration runs for `changes`, creates first and drops last; unmanaged columns are left out. */
export function planMigration(changes: SchemaChange[]): PlannedStep[] {
  const actionable = changes.filter(isActionable);
  const creates = actionable.filter((c): c is CreateChange => c.kind === 'createTable');
  const rest = actionable.filter((c) => c.kind !== 'createTable').sort((a, b) => STEP_ORDER[a.kind] - STEP_ORDER[b.kind]);
  return [...byDependency(creates), ...rest].flatMap(plannedSteps);
}

function renderPlanned(planned: PlannedStep, allowDestructive: boolean): string[] {
  const lines = renderStep(planned.step);
  if (!planned.destructive) return planned.reason ? [`// ${planned.reason}`, ...lines] : lines;
  const marker = `// DESTRUCTIVE: ${planned.reason ?? planned.step.kind}`;
  return allowDestructive ? [marker, ...lines] : [`${marker} (pass --allow-destructive to run it)`, ...lines.map((l) => `// ${l}`)];
}

function methodBody(lines: string[]): { parameter: string; lines: string[] } {
  return { parameter: lines.some((l) => !l.startsWith('//')) ? 'connection' : '_connection', lines: lines.map((l) => `    ${l}`) };
}

const callsRaw = (call: ColumnCall): boolean => call.chain.some((link) => link.args.some((a) => typeof a === 'object' && !Array.isArray(a)));

const usesRaw = (planned: PlannedStep[]): boolean => planned.some(({ step }) => (step.kind === 'createTable' || step.kind === 'alterTable') && step.columns.some(callsRaw));

/** A `@Migration` class over the schema builder (D10); DESTRUCTIVE steps are comments unless `allowDestructive`. */
export function generateMigration(changes: SchemaChange[], options: GenerateOptions): { fileName: string; source: string } {
  if (!NAME.test(options.name)) throw new InvalidArgument(`Invalid migration name "${options.name}": a letter followed by letters or digits`);
  const cls = `${options.name}_${DateTime.fromJSDate(options.now).toFormat('yyyy_MM_dd_HH_mm_ss')}`;
  const planned = planMigration(changes);
  const up = methodBody(planned.flatMap((p) => renderPlanned(p, options.allowDestructive)));
  const undo = planned.flatMap((p) => (p.undo && (!p.destructive || options.allowDestructive) ? [p.undo] : []));
  const down = methodBody(undo.reverse().flatMap(renderStep));
  const imports = ['Migration', 'OrmDriver', 'OrmMigration', ...(usesRaw(planned) ? ['RawQuery'] : [])];
  const source = [
    `import { ${imports.join(', ')} } from '@spinajs/orm';`,
    '',
    '/**',
    ' * Generated by `spinajs migrate-diff` from the app manifest. Review it before it runs.',
    ' */',
    `@Migration(${quote(options.connection)})`,
    `export class ${cls} extends OrmMigration {`,
    `  public async up(${up.parameter}: OrmDriver): Promise<void> {`,
    ...up.lines,
    '  }',
    '',
    `  public async down(${down.parameter}: OrmDriver): Promise<void> {`,
    ...down.lines,
    '  }',
    '}',
    '',
  ].join('\n');
  return { fileName: `${cls}.ts`, source };
}
