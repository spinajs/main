import { AUTHZ_CONNECTION, AuthzConfigError, AuthzDomains, DefaultAuthzDomains } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';
import { Orm, OrmDriver } from '@spinajs/orm';

const ROOT_DOMAIN = 'root';

/**
 * The driver of an `AuthzAdmin` transaction (D-L2-1). Stores write only inside one (design §9.2),
 * so anything else is a programming error.
 */
export function transactionDriver(tx: AuthzTx, where: string): OrmDriver {
  const driver = tx?.driver;
  if (!(driver instanceof OrmDriver)) {
    throw new AuthzConfigError(`${where}: AuthzTx.driver must be the OrmDriver of an AuthzAdmin transaction`);
  }
  if (driver.CurrentTransaction === undefined) {
    throw new AuthzConfigError(`${where}: stores write only inside an AuthzAdmin transaction, and none is in scope`);
  }
  return driver;
}

/**
 * Like {@link transactionDriver}, and the transaction must run on `store`, the connection the store
 * reads (D-L2-2): a write on another connection would land where the model never looks.
 */
export function storeTransactionDriver(tx: AuthzTx, store: OrmDriver, where: string): OrmDriver {
  const driver = transactionDriver(tx, where);
  if (driver !== store) {
    throw new AuthzConfigError(`${where}: the AuthzTx runs on connection ${JSON.stringify(driver.Options.Name)}, but the store uses ${JSON.stringify(store.Options.Name)} (db.Aliases.${AUTHZ_CONNECTION})`);
  }
  return driver;
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

/** The ORM connection of the authz tables: the one `db.Aliases.authz` names. */
export async function authzConnection(container: IContainer): Promise<OrmDriver> {
  const orm = (await container.resolve(Orm)) as Orm;
  const driver = orm.Connections.get(AUTHZ_CONNECTION);

  if (!driver) {
    throw new AuthzConfigError(`no ORM connection answers to "${AUTHZ_CONNECTION}": set db.Aliases.${AUTHZ_CONNECTION} (connections: ${[...orm.Connections.keys()].join(', ') || 'none'})`);
  }

  return driver;
}
