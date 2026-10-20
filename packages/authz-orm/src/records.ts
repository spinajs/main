import { AUTHZ_CONNECTION, AuthzConfigError } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import { ConnectionMismatch, NotAnOrmDriver, OrmConnectionMissing, OrmNotResolved, TransactionRequired, modelDriver, requireModelConnection, requireModelTransaction } from '@spinajs/orm';
import type { ISelectQueryBuilder, ModelBase, OrmDriver } from '@spinajs/orm';

/** The ORM's connection errors in the words of the authz tables; anything else as it is. */
function connectionError(record: typeof ModelBase, err: unknown): unknown {
  if (err instanceof OrmNotResolved) {
    return new AuthzConfigError(`${record.name}: the Orm is not resolved yet; resolve it (await DI.resolve(Orm)) before the authz tables are used`, { cause: err });
  }
  if (err instanceof OrmConnectionMissing) {
    return new AuthzConfigError(`${record.name}: no ORM connection answers to "${AUTHZ_CONNECTION}"; set db.Aliases.${AUTHZ_CONNECTION}`, { cause: err });
  }
  return err;
}

function mismatch(subject: string, err: ConnectionMismatch): AuthzConfigError {
  return new AuthzConfigError(`${subject} runs on connection ${JSON.stringify(err.actual)}, but ${err.table} is on connection ${JSON.stringify(err.expected)} (db.Aliases.${AUTHZ_CONNECTION})`, { cause: err });
}

/** The driver `record`'s queries run on; a transaction on it is the one they join. */
export function recordDriver(record: typeof ModelBase): OrmDriver {
  try {
    return modelDriver(record);
  } catch (err) {
    throw connectionError(record, err);
  }
}

/** `record.query()`, its connection errors naming `db.Aliases.authz`. */
export function selectFrom<R extends typeof ModelBase>(record: R): ISelectQueryBuilder<InstanceType<R>[]> {
  try {
    return record.query();
  } catch (err) {
    throw connectionError(record, err);
  }
}

/** `driver` when it is the connection `record` lives on, so a statement and the authz rows it keeps commit together. */
export function requireConnection(record: typeof ModelBase, driver: OrmDriver, where: string): OrmDriver {
  try {
    return requireModelConnection(record, driver);
  } catch (err) {
    if (err instanceof ConnectionMismatch) throw mismatch(where, err);
    throw connectionError(record, err);
  }
}

/**
 * The driver of `tx`, an `AuthzAdmin` transaction on the connection `record` lives on. Stores write only
 * inside one; a write on another connection would land where the reads never look.
 */
export function requireTransaction(record: typeof ModelBase, tx: AuthzTx, where: string): OrmDriver {
  try {
    return requireModelTransaction(record, tx?.driver);
  } catch (err) {
    if (err instanceof NotAnOrmDriver) {
      throw new AuthzConfigError(`${where}: AuthzTx.driver must be the OrmDriver of an AuthzAdmin transaction`, { cause: err });
    }
    if (err instanceof TransactionRequired) {
      throw new AuthzConfigError(`${where}: stores write only inside an AuthzAdmin transaction, and none is in scope`, { cause: err });
    }
    if (err instanceof ConnectionMismatch) throw mismatch(`${where}: the AuthzTx`, err);
    throw connectionError(record, err);
  }
}
