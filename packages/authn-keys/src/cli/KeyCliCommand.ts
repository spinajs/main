import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { OrmMigrator } from '@spinajs/orm';

/**
 * The cli resolves only the command it runs, so the command boots the Orm and the `Migration.OnStartup` pass that
 * creates the key tables, as an app process does; model queries on such a connection throw until that pass ran.
 */
export abstract class KeyCliCommand extends CliCommand {
  @Autoinject(OrmMigrator)
  protected Migrator: OrmMigrator;
}
