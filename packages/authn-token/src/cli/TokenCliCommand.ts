import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

/**
 * The cli resolves only the command it runs, so the command boots the Orm its TokenService queries. Not the
 * TokenService itself: a boot migration that seeds users or tokens resolves it while the Orm is resolving.
 */
export abstract class TokenCliCommand extends CliCommand {
  @Autoinject(Orm)
  protected Orm: Orm;
}
