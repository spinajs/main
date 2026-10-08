import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

/**
 * Base of the token commands. The cli resolves only the command it runs and boots nothing else, so
 * without the injected Orm the models are bare and every query throws "Not implemented".
 */
export abstract class TokenCliCommand extends CliCommand {
  @Autoinject(Orm)
  protected Orm: Orm;
}
