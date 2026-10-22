import { AuthzCliBase } from '@spinajs/authz/cli';
import { Orm, OrmMigrator } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AncestorRecord } from '../ancestors/record.js';
import { driverOf } from '../ids.js';
import { recordDriver, requireConnection } from '../records.js';
import { classesOf, nameOf } from '../registry.js';

/**
 * The ORM is resolved when the command runs (the Cli boots only the command), after `OrmMigrator` ran the
 * `Migration.OnStartup` pass an app process runs before serving; tests set `Orm`.
 */
export abstract class AuthzOrmCliCommand extends AuthzCliBase {
  public Orm?: Orm;

  protected async orm(): Promise<Orm> {
    if (!this.Orm) {
      await this.Container.resolve(OrmMigrator);
      this.Orm = (await this.Container.resolve(Orm)) as Orm;
    }
    return this.Orm;
  }

  /** The connection of the type's first registered class, which must be the one authz_resource_ancestor is on; that one for a type without a class. */
  protected driverFor(type: string): OrmDriver {
    const cls = classesOf(type)[0];
    if (!cls) return recordDriver(AncestorRecord);
    return requireConnection(AncestorRecord, driverOf(cls), `authz:ancestors: ${nameOf(cls)} (resource '${type}')`);
  }

  protected async prepare(): Promise<void> {
    await this.orm();
  }
}
