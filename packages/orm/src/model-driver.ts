import { DI } from '@spinajs/di';

import { DeleteQueryBuilder, createQuery } from './builders.js';
import { extractModelDescriptor } from './descriptor.js';
import { OrmDriver } from './driver.js';
import { ConnectionMismatch, NotAnOrmDriver, OrmConnectionMissing, OrmException, OrmNotResolved, TransactionRequired } from './exceptions.js';
import { ModelBase } from './model.js';
import { Orm } from './orm.js';

/** What `Orm.createConnections()` registers in the root container once the connections and aliases exist. */
const ORM_CONNECTION = 'OrmConnection';

let resolving: Promise<unknown> | undefined;

/**
 * Resolves the Orm unless one already created its connections; concurrent callers share one resolve. Model statics
 * and {@link modelDriver} work only after that, and a process that boots part of an app (a cli command) may not have
 * resolved it.
 */
export async function ormReady(): Promise<void> {
  if (resolving === undefined && DI.check(ORM_CONNECTION)) return;
  resolving ??= Promise.resolve(DI.resolve(Orm)).finally(() => (resolving = undefined));
  await resolving;
}

function connectionDriver(name: string, owner?: string): OrmDriver {
  const prefix = owner ? `${owner}: ` : '';
  if (!DI.check(ORM_CONNECTION)) throw new OrmNotResolved(`${prefix}the Orm has not created its connections yet; await ormReady() first`);

  const driver = DI.resolve<OrmDriver | null>(ORM_CONNECTION, [name]);
  if (!driver) throw new OrmConnectionMissing(`${prefix}no ORM connection answers to "${name}"; add it to db.Connections or map it in db.Aliases`, name);
  return driver;
}

/** The driver of connection `name`, an alias from `db.Aliases` included. */
export function ormConnection(name: string): OrmDriver {
  return connectionDriver(name);
}

/** The driver `model`'s queries run on; a transaction open on it is the one they join. */
export function modelDriver(model: typeof ModelBase): OrmDriver {
  const descriptor = extractModelDescriptor(model);
  if (!descriptor) throw new OrmException(`${model.name} has no model descriptor; decorate it with @Model`);
  return connectionDriver(descriptor.Connection!, model.name);
}

/** A DELETE on `model`'s table for the caller to narrow; `Model.destroy()` takes primary keys only. */
export function deleteFrom<M extends typeof ModelBase>(model: M): DeleteQueryBuilder<InstanceType<M>> {
  modelDriver(model);
  return createQuery(model, DeleteQueryBuilder).query as DeleteQueryBuilder<InstanceType<M>>;
}

function describe(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

function sameConnection(model: typeof ModelBase, driver: OrmDriver, what: string): OrmDriver {
  const own = modelDriver(model);
  if (driver === own) return driver;

  const table = extractModelDescriptor(model)!.TableName;
  throw new ConnectionMismatch(`${model.name}: ${what} runs on connection "${driver.Options.Name}", but ${table} is on connection "${own.Options.Name}"`, table, own.Options.Name, driver.Options.Name);
}

/** `driver` when it is the driver `model` runs on, so a statement on it and one on the model commit together. */
export function requireModelConnection(model: typeof ModelBase, driver: OrmDriver): OrmDriver {
  if (!(driver instanceof OrmDriver)) throw new NotAnOrmDriver(`${model.name}: expected an OrmDriver, got ${describe(driver)}`);
  return sameConnection(model, driver, 'the driver');
}

/**
 * `driver` when it has a transaction open in this async context and is the driver `model` runs on: a write through
 * another connection's transaction would commit apart from it.
 */
export function requireModelTransaction(model: typeof ModelBase, driver: unknown): OrmDriver {
  if (!(driver instanceof OrmDriver)) throw new NotAnOrmDriver(`${model.name}: expected the OrmDriver of an open transaction, got ${describe(driver)}`);
  if (driver.CurrentTransaction === undefined) throw new TransactionRequired(`${model.name}: needs a transaction open on connection "${driver.Options.Name}", and none is in scope`);
  return sameConnection(model, driver, 'the transaction');
}
