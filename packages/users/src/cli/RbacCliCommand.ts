import { CliCommand } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

/**
 * Base of every rbac command that reads or writes the database. The cli resolves only the command it runs and boots
 * nothing else, so without this the models are bare and every query throws "Not implemented". Injecting the Orm boots
 * it and applies the `Migration.OnStartup` migrations, as an app process does, for exactly the command being run - a
 * command that is merely listed (`--help`, cache builds) still opens no connection.
 */
export abstract class RbacCliCommand extends CliCommand {
  @Autoinject(Orm)
  protected Orm: Orm;

  /** Waits for the Orm's `data()` seeds too: an app process serves only after them. */
  public async resolve(): Promise<void> {
    await super.resolve();
    await this.Orm.Migrator.ready();
  }
}
