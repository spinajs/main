import { MANIFEST_VERSION, type ColumnSqlSpec, type Manifest, type ModelColumn, type ModelEntry } from '@spinajs/manifest';

export function col(name: string, sql: ColumnSqlSpec, options: { nullable?: boolean; primary?: boolean } = {}): ModelColumn {
  return { name, type: { text: 'unknown' }, primary: options.primary ?? false, nullable: options.nullable ?? false, sql };
}

export const id = (): ModelColumn => col('Id', { family: 'integer', inferred: true }, { primary: true });

export function model(className: string, tableName: string, columns: ModelColumn[], extra: Partial<ModelEntry> = {}): ModelEntry {
  return { id: `app:${className}`, className, tableName, columns, relations: [], accessResource: false, source: { file: 'src/models.ts', line: 1, col: 1, package: 'app' }, ...extra };
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

/** Six models: every family both dialects can compare, two foreign keys, an index and a unique composite index. */
export function shopModels(prefix: string): ModelEntry[] {
  const t = (name: string): string => `${prefix}${name}`;
  return [
    model('Company', t('companies'), [id(), col('Name', { family: 'text', length: 120, unique: true })]),
    model('User', t('users'), [id(), col('Email', { family: 'text', length: 200, unique: true }), col('CompanyId', { family: 'integer', inferred: true }), col('CreatedAt', { family: 'datetime', default: { raw: 'CURRENT_TIMESTAMP' } })], {
      relations: [{ name: 'Company', kind: 'belongsTo', target: 'Company', foreignKey: 'CompanyId' }],
    }),
    model('Post', t('posts'), [id(), col('Title', { family: 'text', inferred: true }), col('Body', { family: 'text', inferred: true }, { nullable: true }), col('OwnerId', { family: 'integer', inferred: true }), col('Published', { family: 'boolean', default: false })], {
      relations: [{ name: 'Owner', kind: 'belongsTo', target: 'User', foreignKey: 'OwnerId' }],
      indexes: [{ columns: ['OwnerId', 'Published'], unique: false }],
    }),
    model('Tag', t('tags'), [id(), col('Name', { family: 'text', length: 50, unique: true })]),
    model('PostTag', t('post_tags'), [id(), col('PostId', { family: 'integer', inferred: true }), col('TagId', { family: 'integer', inferred: true })], { indexes: [{ columns: ['PostId', 'TagId'], unique: true }] }),
    model('Setting', t('settings'), [
      id(),
      col('Data', { family: 'json' }, { nullable: true }),
      col('Price', { family: 'decimal', precision: 10, scale: 2 }),
      col('Ratio', { family: 'float' }),
      col('Born', { family: 'date' }, { nullable: true }),
      col('Opens', { family: 'time' }, { nullable: true }),
      col('Hits', { family: 'bigint' }),
      col('Token', { family: 'uuid' }, { nullable: true }),
      col('Avatar', { family: 'binary' }, { nullable: true }),
      col('Status', { family: 'enum', enumValues: ['draft', 'live'] }),
    ]),
  ];
}
