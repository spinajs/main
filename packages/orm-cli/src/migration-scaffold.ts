// Kept out of cli/MigrateCreate.ts: Cli discovery takes the first export of each command file,
// and these names sort before the command class.
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
export const RESERVED_ENV_NAMES = ['test', 'spec', 'd'];

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
