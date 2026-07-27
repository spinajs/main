/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

import './migrations/UowMigration_2026_07_26_00_00_00.js';
import './models/uow/UowClient.js';
import './models/uow/UowOrder.js';
import './models/uow/UowOrderItem.js';
import './models/uow/UowStrictItem.js';
import './models/uow/UowTag.js';
import './models/uow/UowOrderTag.js';
import './models/uow/UowNode.js';
import './models/uow/UowCycle.js';

export { UowClient } from './models/uow/UowClient.js';
export { UowOrder } from './models/uow/UowOrder.js';
export { UowOrderItem } from './models/uow/UowOrderItem.js';
export { UowStrictItem } from './models/uow/UowStrictItem.js';
export { UowTag } from './models/uow/UowTag.js';
export { UowOrderTag } from './models/uow/UowOrderTag.js';
export { UowNode } from './models/uow/UowNode.js';
export { UowCycleA, UowCycleB } from './models/uow/UowCycle.js';

/** Registers the sqlite connection. Call once from `before()`. */
export function registerUowConnection(): void {
  DI.register(ConnectionConf).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
}

/** Boots a fresh in-memory ORM with the uow schema. Call from `beforeEach()`. */
export async function bootUow(): Promise<Orm> {
  const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
  for (const b of bootstrappers) {
    await b.bootstrap();
  }

  const orm = await DI.resolve(Orm);
  await db().migrateUp();
  await db().reloadTableInfo();

  return orm!;
}

/** Raw row read, bypassing the model layer — used to assert what actually reached the database. */
export async function rows(table: string): Promise<any[]> {
  return (await db().Connections.get('sqlite')!.select().from(table).asRaw<any[]>()) as any[];
}
