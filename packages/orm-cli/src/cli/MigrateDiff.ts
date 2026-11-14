import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { InvalidArgument, IOFail } from '@spinajs/exceptions';
import { readManifest, type Diagnostic, type Manifest } from '@spinajs/manifest';
import { buildTargetSchema, diffSchema, generateMigration, introspectSchema, isActionable, Orm, renderSql, type ActionableChange, type OrmDriver, type SchemaChange, type TargetTable } from '@spinajs/orm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONNECTION_NAME_REGEXP, DEFAULT_MIGRATION_DIR, MIGRATION_NAME_REGEXP } from '../migration-scaffold.js';
import { resolveCliMigrator } from '../orm.js';

export interface IMigrateDiffCommandOptions {
  connection?: string;
  manifest?: string;
  base?: string;
  out?: string;
  prune?: string;
  package?: string;
  excludePackage?: string;
  allowDestructive?: boolean;
  sql?: boolean;
  check?: boolean;
}

const DEFAULT_NAME = 'SchemaDiff';
const DEFAULT_MANIFEST = 'app.manifest.json';

// stdout is the command's output (a path, DDL, a change list) for scripts to read; diagnostics go to stderr
const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const report = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
// a line terminator in a live or model name would split one entry into lines a script reads as two
const oneLine = (text: string): string => text.replace(/[\r\n\p{Zl}\p{Zp}]/gu, ' ');
const describeChange = (c: SchemaChange): string => oneLine(`${c.destructive ? 'DESTRUCTIVE ' : ''}${c.kind} ${c.table}${c.reason ? `: ${c.reason}` : ''}`);
const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

interface IPackageFilter {
  only: string[];
  excluded: string[];
}

/** The manifest lists every package reachable through dependencies, not which ones the app imports, so the user names them. */
function packageFilterOf(manifest: Manifest, options: IMigrateDiffCommandOptions): IPackageFilter | undefined {
  const filter = { only: list(options.package), excluded: list(options.excludePackage) };
  if (filter.only.length === 0 && filter.excluded.length === 0) return undefined;
  const known = manifest.packages.map((p) => p.name);
  const unknown = [...filter.only, ...filter.excluded].filter((p) => p !== manifest.app.name && !known.includes(p));
  if (unknown.length > 0) throw new InvalidArgument(`Unknown package ${unknown.join(', ')}: the manifest lists the app and ${known.join(', ')}`);
  return filter;
}

/** A table counts while any model of a counted package maps to it; the app's own models always count under `only`. */
function countedTables(manifest: Manifest, tables: TargetTable[], filter: IPackageFilter | undefined): TargetTable[] {
  if (!filter) return tables;
  const counts = (pkg: string): boolean => !filter.excluded.includes(pkg) && (filter.only.length === 0 || pkg === manifest.app.name || filter.only.includes(pkg));
  const kept = new Set(manifest.models.filter((m) => counts(m.source.package)).map((m) => m.tableName));
  return tables.filter((t) => kept.has(t.name));
}

@Command('migrate-diff', 'Writes a migration that brings a database to the schema the models declare')
@Argument('name', false, `migration name prefix, letters and digits, default ${DEFAULT_NAME}`)
@Option('-c, --connection [connection]', false, 'connection to compare, default "default"')
@Option('-m, --manifest <path>', false, `app manifest, default ${DEFAULT_MANIFEST}`)
@Option('-b, --base <path>', false, 'manifest the database was last generated from; a column only it declares is dropped')
@Option('-o, --out <dir>', false, `directory the migration is written to, default ${DEFAULT_MIGRATION_DIR}`)
@Option('-p, --prune <columns>', false, 'comma-separated table.column list of undeclared columns to drop')
@Option('--package <packages>', false, "comma-separated packages whose models count besides the app's own; default every package")
@Option('--exclude-package <packages>', false, 'comma-separated packages whose models do not count')
@Option('--allow-destructive', false, 'write DESTRUCTIVE steps as code instead of comments')
@Option('--sql', false, "print the DDL for the connection's dialect instead of writing a file")
@Option('--check', false, 'write nothing; exit 1 when the database differs from the models')
export class MigrateDiffCommand extends CliCommand {
  public async execute(name: string | undefined, options: IMigrateDiffCommandOptions = {}): Promise<void> {
    const prefix = name ?? DEFAULT_NAME;
    const connection = options.connection ?? 'default';
    if (!MIGRATION_NAME_REGEXP.test(prefix)) throw new InvalidArgument(`Invalid migration name "${prefix}": a letter followed by letters or digits`);
    if (!CONNECTION_NAME_REGEXP.test(connection)) throw new InvalidArgument(`Invalid connection name "${connection}"`);

    const diagnostics: Diagnostic[] = [];
    const { driver, changes } = await this.diff(connection, options, diagnostics);
    diagnostics.forEach((d) => report(oneLine(`${d.severity} ${d.code}: ${d.message}`)));
    if (diagnostics.some((d) => d.severity === 'error')) {
      process.exitCode = 1;
      return;
    }

    const actionable = changes.filter(isActionable);
    if (options.check) {
      actionable.forEach((c) => print(describeChange(c)));
      if (actionable.length > 0) process.exitCode = 1;
      return;
    }
    if (actionable.length === 0) {
      print(`No schema changes on connection ${connection}.`);
      return;
    }
    if (options.sql) {
      const statements = await renderSql(actionable, driver, { allowDestructive: options.allowDestructive === true });
      statements.forEach((s) => print(s.startsWith('--') ? s : `${s};`));
      return;
    }
    this.write(prefix, connection, actionable, options);
  }

  protected async diff(connection: string, options: IMigrateDiffCommandOptions, diagnostics: Diagnostic[]): Promise<{ driver: OrmDriver; changes: SchemaChange[] }> {
    await resolveCliMigrator();
    const orm = await DI.resolve(Orm);
    const driver = orm.Connections.get(connection);
    if (!driver) throw new InvalidArgument(`Unknown connection "${connection}": it is not in db.Connections, db.Aliases or db.DefaultConnection`);
    // a model names a connection, an alias of it, or nothing ('default'); so every name that resolves to this driver counts
    const names = [...orm.Connections].filter(([, d]) => d === driver).map(([n]) => n);
    const manifest = await readManifest(options.manifest ?? DEFAULT_MANIFEST);
    const filter = packageFilterOf(manifest, options);
    const declared = buildTargetSchema(manifest, names, diagnostics);
    const target = countedTables(manifest, declared, filter);
    // a table the filter left out is still mapped by a current model, so --base must not read its absence as a removal
    const filteredOut = new Set(declared.filter((t) => !target.includes(t)).map((t) => t.name));
    const baseManifest = options.base ? await readManifest(options.base) : undefined;
    const base = baseManifest ? countedTables(baseManifest, buildTargetSchema(baseManifest, names), filter).filter((t) => !filteredOut.has(t.name)) : undefined;
    const live = await introspectSchema(driver, [...new Set([...target, ...(base ?? [])].map((t) => t.name))]);
    const prune = list(options.prune);
    return { driver, changes: diffSchema(target, live.columns, live.extras, { base, prune, dialect: live.dialect, foreignKeysEnforced: live.foreignKeysEnforced, allowDestructive: options.allowDestructive, diagnostics }) };
  }

  protected write(prefix: string, connection: string, actionable: ActionableChange[], options: IMigrateDiffCommandOptions): void {
    const allowDestructive = options.allowDestructive === true;
    const { fileName, source } = generateMigration(actionable, { name: prefix, connection, allowDestructive, now: new Date() });
    const dir = options.out ?? DEFAULT_MIGRATION_DIR;
    const file = path.join(dir, fileName);
    fs.mkdirSync(dir, { recursive: true });
    try {
      // 'wx': two runs in one second produce the same class name, and the first file must survive
      fs.writeFileSync(file, source, { flag: 'wx', encoding: 'utf-8' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new IOFail(`Migration file ${file} already exists - it was generated in the same second; run the command again`, err);
      throw err;
    }
    print(file);
    actionable.filter((c) => c.destructive).forEach((c) => report(`${allowDestructive ? 'written' : 'commented out'}: ${describeChange(c)}`));
  }
}
