import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

/**
 * The cli resolves only the command it runs, so the command boots the Orm its TokenService queries, whichever
 * TokenService is registered.
 */
export abstract class TokenCliCommand extends CliCommand {
  @Autoinject(Orm)
  protected Orm: Orm;
}
