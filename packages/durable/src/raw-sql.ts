import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';

// executeOnDb lives on orm-sql's SqlDriver, not on the OrmDriver contract
export type RawSqlDriver = OrmDriver & {
  executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown>;
};

export async function defaultSqlDriver(owner = 'durable'): Promise<RawSqlDriver> {
  const driver = (await DI.resolve(Orm)).Connections.get('default') as RawSqlDriver | undefined;
  if (!driver) throw new InvalidOperation(`${owner}: ORM connection "default" not found`);
  return driver;
}
