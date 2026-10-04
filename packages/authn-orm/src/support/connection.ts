import { DI, IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { Orm, OrmDriver } from '@spinajs/orm';

import { driverDialect } from './sql.js';
import type { Dialect } from './sql.js';

export interface StoreOptions {
  /** Where the Orm comes from when no driver is given; default the root container. */
  readonly container?: IContainer;
}

/** @internal */
export interface StoreDb {
  readonly driver: OrmDriver;
  readonly dialect: Dialect;
}

/** @internal The given driver, or the Orm's `'default'` connection resolved once on first use; a failed resolve is retried. */
export class StoreConnection {
  private loading: Promise<StoreDb> | undefined;

  constructor(private readonly owner: string, private readonly driver?: OrmDriver, private readonly container?: IContainer) {}

  public get(): Promise<StoreDb> {
    this.loading ??= this.load().catch((err: unknown) => {
      this.loading = undefined;
      throw err;
    });
    return this.loading;
  }

  private async load(): Promise<StoreDb> {
    let driver = this.driver;
    if (!driver) {
      const orm = await (this.container ?? DI.RootContainer).resolve(Orm);
      driver = orm.Connections.get('default');
      if (!driver) throw new InvalidOption(`${this.owner}: the Orm has no 'default' connection`);
    }
    return { driver, dialect: driverDialect(driver) };
  }
}
