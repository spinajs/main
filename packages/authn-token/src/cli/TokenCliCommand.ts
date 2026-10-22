import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { OrmMigrator } from '@spinajs/orm';

/**
 * The cli resolves only the command it runs, so the command boots what an app process boots before serving: the Orm
 * and the `Migration.OnStartup` pass, without which model queries on such a connection throw. Whichever TokenService
 * is registered.
 */
export abstract class TokenCliCommand extends CliCommand {
  @Autoinject(OrmMigrator)
  protected Migrator: OrmMigrator;
}
