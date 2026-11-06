import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm, OrmDriver } from '@spinajs/orm';

export async function defaultSqlDriver(owner = 'durable'): Promise<OrmDriver> {
  const driver = (await DI.resolve(Orm)).Connections.get('default');
  if (!driver) throw new InvalidOperation(`${owner}: ORM connection "default" not found`);
  return driver;
}
