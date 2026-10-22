import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { OrmMigrator } from '@spinajs/orm';

/**
 * The cli resolves only the command it runs, so the command boots what an app process boots before serving: the Orm
 * and the `Migration.OnStartup` pass, without which a DB-backed store's model queries on such a connection throw.
 */
export abstract class LocalCliCommand extends CliCommand {
  @Autoinject(OrmMigrator)
  protected Migrator: OrmMigrator;
}
