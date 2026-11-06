import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { MANIFEST_VERSION, type ColumnSqlSpec, type Manifest, type ModelColumn, type ModelEntry } from '@spinajs/manifest';
import { buildTargetSchema, diffSchema, introspectSchema, Orm, planMigration, runStep, type OrmDriver } from '@spinajs/orm';
import '@spinajs/log';
import '@spinajs/orm-sqlite';
import '@spinajs/orm-pglite';
import { MigrateDiffCommand } from '../src/index.js';

const col = (name: string, sql: ColumnSqlSpec, nullable = false): ModelColumn => ({ name, type: { text: 'unknown' }, primary: false, nullable, sql });
const id = (): ModelColumn => ({ name: 'Id', type: { text: 'number' }, primary: true, nullable: false, sql: { family: 'integer', inferred: true } });
const model = (className: string, tableName: string, columns: ModelColumn[], extra: Partial<ModelEntry> = {}): ModelEntry => ({
  id: `app:${className}`,
  className,
  tableName,
  columns,
  relations: [],
  accessResource: false,
  source: { file: 'src/models.ts', line: 1, col: 1, package: 'app' },
  ...extra,
});

function manifestOf(models: ModelEntry[]): Manifest {
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

class DiffCliConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
    this.Config.db = {
      StrictTableCheck: false,
      DefaultConnection: 'pg',
      Connections: [
        { Driver: 'orm-driver-pglite', Filename: ':memory:', Name: 'pg' },
        { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'lite' },
      ],
    };
  }
}

/** stdout and stderr of `fn`, as lines: they are this command's output. */
async function capture(fn: () => Promise<void>): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string) => out.push(chunk) > 0;
  process.stderr.write = (chunk: string) => err.push(chunk) > 0;
  try {
    await fn();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  const lines = (chunks: string[]): string[] => chunks.join('').split('\n').filter((l) => l.length > 0);
  return { out: lines(out), err: lines(err) };
}

async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('migrate-diff', function () {
  this.timeout(60_000);
  let dir: string;
  let command: MigrateDiffCommand;

  const writeManifest = (name: string, models: ModelEntry[]): string => {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(manifestOf(models)));
    return file;
  };

  const pg = async (): Promise<OrmDriver> => {
    const driver = (await DI.resolve(Orm)).Connections.get('pg');
    if (!driver) throw new Error('no pg connection');
    return driver;
  };

  before(async () => {
    DI.register(DiffCliConf).as(Configuration);
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    command = await DI.resolve(MigrateDiffCommand);
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrate-diff-'));
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  after(async () => {
    await (await DI.resolve(Orm)).dispose();
    DI.clearCache();
  });

  it('writes a migration for what the database lacks and prints its path', async () => {
    const manifest = writeManifest('m', [model('Item', 'cli_items', [id(), col('Name', { family: 'text', inferred: true })])]);
    const out = join(dir, 'migrations');
    const { out: lines } = await capture(() => command.execute('Items', { connection: 'pg', manifest, out }));
    const files = readdirSync(out);
    expect(files).to.have.length(1);
    expect(files[0]).to.match(/^Items_\d{4}(_\d{2}){5}\.ts$/);
    expect(lines).to.deep.equal([join(out, files[0])]);
    expect(readFileSync(join(out, files[0]), 'utf8')).to.include("await connection.schema().createTable('cli_items', (table) => {");
    expect(process.exitCode).to.equal(undefined);
  });

  it('--check exits 1 while the models differ, and leaves the exit code alone once they match', async () => {
    const models = [model('Thing', 'cli_things', [id(), col('Label', { family: 'text', inferred: true }, true)])];
    const manifest = writeManifest('m', models);
    const first = await capture(() => command.execute(undefined, { connection: 'pg', manifest, check: true }));
    expect(first.out).to.deep.equal(['createTable cli_things']);
    expect(process.exitCode).to.equal(1);

    process.exitCode = undefined;
    const driver = await pg();
    const target = buildTargetSchema(manifestOf(models), 'default');
    const live = await introspectSchema(driver, ['cli_things']);
    for (const planned of planMigration(diffSchema(target, live.columns, live.extras, { dialect: live.dialect }))) await runStep(driver, planned.step);

    const second = await capture(() => command.execute(undefined, { connection: 'pg', manifest, check: true }));
    expect(second.out).to.deep.equal([]);
    expect(process.exitCode).to.equal(undefined);
  });

  it('--check lists a column named by --prune as a DESTRUCTIVE drop', async () => {
    const driver = await pg();
    await driver.schema().createTable('cli_prune', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.text('Legacy');
    });
    const manifest = writeManifest('m', [model('Prune', 'cli_prune', [id()])]);
    const { out } = await capture(() => command.execute(undefined, { connection: 'pg', manifest, prune: 'cli_prune.Legacy', check: true }));
    expect(out).to.deep.equal(['DESTRUCTIVE dropColumn cli_prune: --prune cli_prune.Legacy']);
  });

  it('--sql prints the DDL of the connection dialect and writes nothing', async () => {
    for (const [connection, keyword] of [['pg', 'GENERATED BY DEFAULT AS IDENTITY'], ['lite', 'AUTOINCREMENT']] as const) {
      const manifest = writeManifest(connection, [model('Sql', `cli_sql_${connection}`, [id()], { connection })]);
      const out = join(dir, connection);
      const { out: lines } = await capture(() => command.execute(undefined, { connection, manifest, out, sql: true }));
      expect(lines.join('\n')).to.include('CREATE TABLE').and.to.include(keyword);
      expect(existsSync(out)).to.equal(false);
    }
  });

  it('stops on MIG001 with exit code 1 and writes nothing', async () => {
    const manifest = writeManifest('m', [model('A', 'cli_conflict', [col('Email', { family: 'text', length: 10 })]), model('B', 'cli_conflict', [col('Email', { family: 'text', length: 20 })])]);
    const out = join(dir, 'migrations');
    const { err } = await capture(() => command.execute(undefined, { connection: 'pg', manifest, out }));
    expect(err).to.deep.equal(['error MIG001: column cli_conflict.Email is declared with different specs by A, B: {"family":"text","length":10} and {"family":"text","length":20}']);
    expect(process.exitCode).to.equal(1);
    expect(existsSync(out)).to.equal(false);
  });

  it('reports unmanaged columns and the DESTRUCTIVE steps it left as comments', async () => {
    const driver = await pg();
    await driver.schema().createTable('cli_legacy', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.text('Old');
      table.text('Extra');
    });
    const base = writeManifest('base', [model('Legacy', 'cli_legacy', [id(), col('Old', { family: 'text', inferred: true }, true)])]);
    const manifest = writeManifest('m', [model('Legacy', 'cli_legacy', [id(), col('New', { family: 'text', inferred: true }, true)])]);
    const { err } = await capture(() => command.execute('Rename', { connection: 'pg', manifest, base, out: join(dir, 'migrations') }));
    expect(err).to.deep.equal([
      'info MIG002: column cli_legacy.Extra is declared by no model (Legacy) and is left as it is',
      'commented out: DESTRUCTIVE dropColumn cli_legacy: cli_legacy.Old was removed from the models since --base',
    ]);
  });

  it('warns MIG006 before a sqlite column change that rebuilds a referenced table', async () => {
    const lite = (await DI.resolve(Orm)).Connections.get('lite');
    if (!lite) throw new Error('no lite connection');
    await lite.schema().createTable('cli_parent', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.text('Name');
    });
    await lite.schema().createTable('cli_child', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('ParentId');
      table.foreignKey('ParentId').references('cli_parent', 'Id');
    });
    const manifest = writeManifest('m', [model('Parent', 'cli_parent', [id(), col('Name', { family: 'text' })], { connection: 'lite' }), model('Child', 'cli_child', [id(), col('ParentId', { family: 'integer', inferred: true })], { connection: 'lite' })]);
    const { out, err } = await capture(() => command.execute(undefined, { connection: 'lite', manifest, check: true }));
    expect(out).to.deep.equal(['alterColumn cli_parent: cli_parent.Name: NOT NULL']);
    expect(err).to.deep.equal(['warning MIG006: altering a column of cli_parent rebuilds the table, which fails while foreign keys are enforced: it is referenced by cli_child']);
  });

  it('refuses an invalid name and an unknown connection', async () => {
    expect(await thrownBy(() => command.execute('Bad_Name', {}))).to.be.instanceOf(InvalidArgument);
    const error = await thrownBy(() => command.execute(undefined, { connection: 'nope', manifest: writeManifest('m', []) }));
    expect(error).to.be.instanceOf(InvalidArgument);
    expect((error as Error).message).to.equal('Unknown connection "nope": it is not in db.Connections, db.Aliases or db.DefaultConnection');
  });
});
