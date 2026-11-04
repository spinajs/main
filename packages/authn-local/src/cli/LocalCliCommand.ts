import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

/** Injecting the Orm boots it for exactly the command being run; the boot fails while a migration is pending (run migrate-up first). */
export abstract class LocalCliCommand extends CliCommand {
  @Autoinject(Orm)
  protected Orm: Orm;
}
