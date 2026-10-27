import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

/**
 * The cli resolves only the command it runs, so the command resolves the Orm, which applies the `Migration.OnStartup`
 * migrations that create the key tables, as an app process does.
 */
export abstract class KeyCliCommand extends CliCommand {
  @Autoinject(Orm)
  protected Orm: Orm;
}
