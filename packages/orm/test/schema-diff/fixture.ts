import { MANIFEST_VERSION, type ColumnSqlSpec, type Manifest, type ModelColumn, type ModelEntry, type SourceRef } from '@spinajs/manifest';
import type { IColumnDescriptor } from '../../src/interfaces.js';

export const SOURCE: SourceRef = { file: 'src/models.ts', line: 1, col: 1, package: 'app' };

export function col(name: string, sql: ColumnSqlSpec, options: { nullable?: boolean; primary?: boolean } = {}): ModelColumn {
  return { name, type: { text: 'unknown' }, primary: options.primary ?? false, nullable: options.nullable ?? false, sql };
}

export const id = (): ModelColumn => col('Id', { family: 'integer', inferred: true }, { primary: true });

export function model(className: string, tableName: string, columns: ModelColumn[], extra: Partial<ModelEntry> = {}): ModelEntry {
  return { id: `app:${className}`, className, tableName, columns, relations: [], accessResource: false, source: SOURCE, ...extra };
}

export function manifestOf(models: ModelEntry[]): Manifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    app: { name: 'app', version: '0.0.0', root: '.', outDir: 'lib' },
    packages: [],
    generatedAt: '2026-11-03T00:00:00.000Z',
    hash: '0'.repeat(64),
    services: [],
    values: [],
    controllers: [],
    socketControllers: [],
    socketContracts: [],
    configModules: [],
    configUsages: [],
    models,
    migrations: [],
    schedules: [],
    commands: [],
    queueMessages: [],
    schemas: {},
    diagnostics: [],
  };
}

/** A column as a driver's `tableInfo()` reports it. */
export function live(name: string, nativeType: string, overrides: Partial<IColumnDescriptor> = {}): IColumnDescriptor {
  return {
    Name: name,
    Type: nativeType,
    NativeType: nativeType,
    MaxLength: -1,
    Comment: '',
    DefaultValue: null,
    Unsigned: false,
    Nullable: false,
    PrimaryKey: false,
    AutoIncrement: false,
    Converter: null,
    Schema: undefined,
    Unique: false,
    Uuid: false,
    Ignore: false,
    Aggregate: false,
    Virtual: false,
    IsForeignKey: false,
    ForeignKeyDescription: null,
    ...overrides,
  };
}
