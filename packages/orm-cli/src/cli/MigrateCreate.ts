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

export const DEFAULT_MIGRATION_DIR = './src/migrations';

export const DEFAULT_MIGRATION_CONNECTION = 'default';

/**
 * The scaffold. `connection` is named ( rather than `_connection` ) in both hooks because both
 * bodies are meant to be filled in immediately - and the eslint pragma on the first line is the
 * repo's own convention for a migration whose `down()` legitimately ignores it.
 */
export function migrationTemplate(cls: string, connection: string): string {
  return `/* eslint-disable @typescript-eslint/no-unused-vars */
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/**
 * TODO: describe the schema change this migration makes.
 */
@Migration('${connection}')
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
export class MigrateCreateCommand extends CliCommand {
  @Logger('ORM-CLI')
  protected Log: Log;

  public async execute(options: IMigrateCreateCommandOptions): Promise<void> {
    const name = options.name ?? '';
    const connection = options.connection ?? DEFAULT_MIGRATION_CONNECTION;

    if (!MIGRATION_NAME_REGEXP.test(name)) {
      throw new InvalidArgument(`Invalid migration name "${name}" - it must be a plain class-name prefix: a letter followed by letters or digits, no spaces, dashes or underscores. The _yyyy_MM_dd_HH_mm_ss suffix is appended here.`);
    }

    if (!CONNECTION_NAME_REGEXP.test(connection)) {
      throw new InvalidArgument(`Invalid connection name "${connection}" - expected the name of a connection from db.Connections, eg. "default"`);
    }

    // The timestamp is not decoration: it is the ONLY ordering the migration runner has, and it is
    // read back out of the class name rather than out of the file's mtime or its position on disk.
    const cls = `${name}_${DateTime.now().toFormat('yyyy_MM_dd_HH_mm_ss')}`;
    const dir = options.dir ?? DEFAULT_MIGRATION_DIR;
    const file = path.join(dir, `${cls}.ts`);

    fs.mkdirSync(dir, { recursive: true });

    try {
      // 'wx' - never clobber. Two `migrate-create` runs inside the same second produce the same
      // class name, and silently overwriting the first one would delete work that was just written.
      fs.writeFileSync(file, migrationTemplate(cls, connection), { flag: 'wx', encoding: 'utf-8' });
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

    this.Log.info(`Created migration ${cls} for connection "${connection}". It only takes effect once the class is imported - re-export it from your package or application index, the way src/migrations files are re-exported elsewhere, so the @Migration decorator runs and registers it.`);
  }
}
