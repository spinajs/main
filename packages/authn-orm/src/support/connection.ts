import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { Orm, OrmDriver } from '@spinajs/orm';

import { driverDialect } from './sql.js';
import type { Dialect } from './sql.js';

/** @internal */
export interface StoreDb {
  readonly driver: OrmDriver;
  readonly dialect: Dialect;
}

/** @internal The given driver, or the `'default'` connection of the Orm injected into the store. */
export class StoreConnection {
  private db: StoreDb | undefined;

  // A getter: DI sets the injected Orm after the store's constructor has run.
  constructor(private readonly owner: string, private readonly driver: OrmDriver | undefined, private readonly orm: () => Orm | undefined) {}

  public async get(): Promise<StoreDb> {
    this.db ??= this.load();
    return this.db;
  }

  private load(): StoreDb {
    let driver = this.driver;
    if (!driver) {
      const orm = this.orm();
      if (!orm) throw new InvalidOperation(`${this.owner}: built without a driver and not by DI, so it has no Orm`);
      driver = orm.Connections.get('default');
      if (!driver) throw new InvalidOption(`${this.owner}: the Orm has no 'default' connection`);
    }
    return { driver, dialect: driverDialect(driver) };
  }
}
