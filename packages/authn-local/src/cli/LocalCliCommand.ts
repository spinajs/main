import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

/**
 * The cli resolves only the command it runs, so the command boots what an app process boots before serving: the Orm,
 * which applies the `Migration.OnStartup` migrations the DB-backed stores need.
 */
export abstract class LocalCliCommand extends CliCommand {
  @Autoinject(Orm)
  protected Orm: Orm;
}
