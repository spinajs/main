import { CliCommand, Command, Option } from '@spinajs/cli';
import { InvalidArgument, IOFail } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import { DateTime } from 'luxon';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface IMigrateCreateCommandOptions {
  name: string;
  dir?: string;
  connection?: string;
  env?: string;
}

/**
 * The prefix half of `Prefix_yyyy_MM_dd_HH_mm_ss`. Deliberately narrower than what a TS class
 * name allows: underscores and digits are how the runner finds the timestamp - `MIGRATION_FILE_REGEXP`
 * splits on the LAST `_yyyy_MM_dd_HH_mm_ss`-shaped run - so a prefix that carries its own
 * underscore-digit groups is a name nobody can read back with confidence.
 */
export const MIGRATION_NAME_REGEXP = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * The connection name is interpolated into `@Migration('...')`, so anything that could close that
 * string literal has to be refused here rather than emitted into a file that will not parse.
 */
export const CONNECTION_NAME_REGEXP = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The env tag becomes a dot-segment in the file name AND a string literal inside `@Migration()`,
 * so it may carry neither a dot ( which would read as a second tag ) nor anything that could close
 * that literal.
 */
export const ENV_NAME_REGEXP = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * The three middle segments `parseMigrationFileEnv` provably cannot read back as an environment
 * tag - they are carved out by name there ( a test suite named after its migration, a TypeScript
 * declaration file ), not because they collide with a real tag but because a `<Name>.<tag>.ts` file
 * whose tag is one of these is never read as tagged at all. `--env test` would therefore write a
 * file whose suffix channel is silently dead - and one many projects' `**\/*.test.ts` globs would
 * try to execute as a test suite besides. Refused here rather than left to surprise someone later.
 */
const RESERVED_ENV_NAMES = ['test', 'spec', 'd'];

/**
 * Reads `--env` directly off `process.argv`, deliberately more flexible than `Configuration`'s own
 * `parseArgv` ( `packages/configuration/src/util.ts` - not exported from that package's public surface,
 * so this logic is duplicated rather than imported ).
 *
 * `parseArgv` handles only the space-separated form ( `--env local` ), but this helper also accepts
 * the equals form ( `--env=local` ). This is correct here: `packages/cli/src/args.ts` strips both
 * forms from commander's argv, because `Configuration` consumes the framework-level `--env` directly.
 * With `--env=local`, the value is stripped but `Configuration`'s `parseArgv` cannot recognize the
 * equals form, so the CLI process boots under the default environment while the scaffolded file gets
 * its `.local` suffix — harmless for this command, which uses the value only as a filename tag and
 * a decorator string. `-e` is untouched by the strip and reaches commander normally, so it needs no
 * duplicate handling here.
 */
export function parseEnvArgv(argv: string[] = process.argv): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--env') {
      return argv[i + 1];
    }

    if (arg.startsWith('--env=')) {
      return arg.slice('--env='.length);
    }
  }

  return undefined;
}

export const DEFAULT_MIGRATION_DIR = './src/migrations';

export const DEFAULT_MIGRATION_CONNECTION = 'default';

/**
 * The scaffold. `connection` is named ( rather than `_connection` ) in both hooks because both
 * bodies are meant to be filled in immediately - and the eslint pragma on the first line is the
 * repo's own convention for a migration whose `down()` legitimately ignores it.
 */
export function migrationTemplate(cls: string, connection: string, env?: string): string {
  return `/* eslint-disable @typescript-eslint/no-unused-vars */
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/**
 * TODO: describe the schema change this migration makes.
 */
@Migration('${connection}'${env ? `, { Env: '${env}' }` : ''})
export class ${cls} extends OrmMigration {
  /**
   * Schema changes. Models are NOT wired up yet at this point - reach the database through
   * \`connection\`, never through a model class.
   */
  public async up(connection: OrmDriver): Promise<void> {
    // TODO: await connection.schema().createTable('table_name', (table) => { ... });
  }

  /**
   * Undoes \`up()\`. Leave it empty only when the change genuinely cannot be reversed - an empty
   * \`down()\` makes migrate-down report success while changing nothing.
   */
  public async down(connection: OrmDriver): Promise<void> {
    // TODO: await connection.schema().dropTable('table_name');
  }
}
`;
}

/**
 * The one command here that needs no database and no Orm: it writes a file. Keeping it free of
 * `DI.resolve(Orm)` means a developer can scaffold a migration in a checkout whose connections
 * are not configured, or not reachable, which is exactly when new migrations get written.
 */
@Command('migrate-create', 'Scaffolds a new migration file')
@Option('-n, --name [name]', true, 'migration name prefix - a plain class-name prefix, letters and digits only')
@Option('-d, --dir [dir]', false, `target directory, default ${DEFAULT_MIGRATION_DIR}`)
@Option('-c, --connection [connection]', false, `connection the migration runs on, default "${DEFAULT_MIGRATION_CONNECTION}"`)
@Option('-e, --env [env]', false, 'environment this migration belongs to, eg. local - omit to run it in every environment')
export class MigrateCreateCommand extends CliCommand {
  @Logger('ORM-CLI')
  protected Log: Log;

  public async execute(options: IMigrateCreateCommandOptions): Promise<void> {
    const name = options.name ?? '';
    const connection = options.connection ?? DEFAULT_MIGRATION_CONNECTION;

    // An explicit `options.env` wins - that is how the tests in this suite call `execute()`
    // directly - and falls back to a direct argv read for the real CLI path, where
    // `packages/cli/src/args.ts` has already stripped `--env <value>` out of what commander sees.
    // See `parseEnvArgv()`.
    const env = options.env ?? parseEnvArgv();

    if (!MIGRATION_NAME_REGEXP.test(name)) {
      throw new InvalidArgument(`Invalid migration name "${name}" - it must be a plain class-name prefix: a letter followed by letters or digits, no spaces, dashes or underscores. The _yyyy_MM_dd_HH_mm_ss suffix is appended here.`);
    }

    if (!CONNECTION_NAME_REGEXP.test(connection)) {
      throw new InvalidArgument(`Invalid connection name "${connection}" - expected the name of a connection from db.Connections, eg. "default"`);
    }

    if (env !== undefined) {
      if (!ENV_NAME_REGEXP.test(env)) {
        throw new InvalidArgument(`Invalid environment name "${env}" - a letter followed by letters, digits or dashes. It becomes both a file suffix and a string inside @Migration().`);
      }

      if (RESERVED_ENV_NAMES.includes(env)) {
        throw new InvalidArgument(`Invalid environment name "${env}" - "test", "spec" and "d" are carved out by the migration file parser as file-kind markers (a test suite, a TypeScript declaration file), never read back as an environment tag. Choose a different name.`);
      }
    }

    // The timestamp is not decoration: it is the ONLY ordering the migration runner has, and it is
    // read back out of the class name rather than out of the file's mtime or its position on disk.
    const cls = `${name}_${DateTime.now().toFormat('yyyy_MM_dd_HH_mm_ss')}`;
    const dir = options.dir ?? DEFAULT_MIGRATION_DIR;
    const file = path.join(dir, `${cls}${env ? `.${env}` : ''}.ts`);

    fs.mkdirSync(dir, { recursive: true });

    try {
      // 'wx' - never clobber. Two `migrate-create` runs inside the same second produce the same
      // class name, and silently overwriting the first one would delete work that was just written.
      fs.writeFileSync(file, migrationTemplate(cls, connection, env), { flag: 'wx', encoding: 'utf-8' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new IOFail(`Migration file ${file} already exists - a migration with this name was created in the same second. Wait a second and run it again, or pass a different --name.`, err as Error);
      }

      throw err;
    }

    // The path goes to stdout on its own line so `$(spinajs migrate-create -n Foo)` is usable;
    // everything else is guidance and belongs in the log.
    // eslint-disable-next-line no-console
    console.log(file);

    // The scan is about the APPLICATION's own directories ( `system.dirs.migrations`, resolved
    // against ITS cwd at runtime ) - not about where this file happened to be scaffolded. Scaffold
    // it inside a package under `<pkg>/src/migrations` and it sits in a directory this same list
    // would scan too, but only when the consumer boots FROM that package's own cwd, which almost
    // never happens: the running process's cwd is the application, not any of its dependencies. A
    // package's migrations must always be re-exported from its own index, or they never run.
    this.Log.info(`Created migration ${cls} for connection "${connection}"${env ? ` in environment "${env}"` : ''}. A file under the application's own system.dirs.migrations is discovered automatically. Inside a package, always re-export it from the package's index - a package's own directories are never scanned at a consumer's runtime - so the @Migration decorator runs and registers it.`);
  }
}
