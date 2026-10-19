import { AUTHZ_CONNECTION, AuthzConfigError, AuthzDomains, DefaultAuthzDomains } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';
import { ConnectionMismatch, NotAnOrmDriver, OrmConnectionMissing, OrmNotResolved, TransactionRequired, modelDriver, requireModelTransaction } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

const ROOT_DOMAIN = 'root';

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

/** The driver `record`'s queries run on; a transaction on it is the one they join. */
export function recordDriver(record: typeof ModelBase): OrmDriver {
  try {
    return modelDriver(record);
  } catch (err) {
    throw connectionError(record, err);
  }
}

/**
 * The driver of `tx`, an `AuthzAdmin` transaction on the connection `record` lives on (D-L2-1, D-L2-2).
 * Stores write only inside one (design §9.2); a write on another connection would land where the reads
 * never look.
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
    if (err instanceof ConnectionMismatch) {
      throw new AuthzConfigError(`${where}: the AuthzTx runs on connection ${JSON.stringify(err.actual)}, but ${err.table} is on connection ${JSON.stringify(err.expected)} (db.Aliases.${AUTHZ_CONNECTION})`, { cause: err });
    }
    throw connectionError(record, err);
  }
}

/**
 * The authz domain a store resolved in `container` serves: the nearest domain container on the
 * way to the root, else `'root'`. Reads the domain registry only when the host already created it,
 * so a store never instantiates it.
 */
export function storeDomain(container: IContainer): string {
  if (!container.isResolved(AuthzDomains)) return ROOT_DOMAIN;

  const domains = container.get(AuthzDomains);
  if (!(domains instanceof DefaultAuthzDomains)) return ROOT_DOMAIN;

  for (let c: IContainer | undefined = container; c; c = c.Parent) {
    const id = domains.describe(c);
    if (id) return id.name;
  }

  return ROOT_DOMAIN;
}
