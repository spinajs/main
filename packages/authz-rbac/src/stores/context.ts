import { AuthzConfigError, AuthzDomains, DefaultAuthzDomains } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import { Orm, OrmDriver } from '@spinajs/orm';

/** Config key naming the ORM connection of the authz-rbac tables (D-L2-2); absent means {@link ADMIN_CONNECTION_KEY}. */
export const RBAC_CONNECTION_KEY = 'authz.rbac.connection';

/** The connection DbAuthzAdminBackend opens its transactions on; absent means the default connection. */
export const ADMIN_CONNECTION_KEY = 'authz.admin.connection';

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
    throw new AuthzConfigError(`${where}: the AuthzTx runs on connection ${JSON.stringify(driver.Options.Name)}, but the store uses ${JSON.stringify(store.Options.Name)} (${RBAC_CONNECTION_KEY}, else ${ADMIN_CONNECTION_KEY}, else the default connection)`);
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

/**
 * The connection named by `authz.rbac.connection`, else by `authz.admin.connection`, else the ORM's
 * default connection: with only one key set, the stores and DbAuthzAdminBackend still share it.
 */
export async function storeConnection(container: IContainer): Promise<OrmDriver> {
  const configuration = container.hasRegistered(Configuration) ? await container.resolve(Configuration) : undefined;
  const rbac = configuration?.get<string>(RBAC_CONNECTION_KEY);
  const admin = rbac === undefined ? configuration?.get<string>(ADMIN_CONNECTION_KEY) : undefined;
  const key = rbac !== undefined ? RBAC_CONNECTION_KEY : admin !== undefined ? ADMIN_CONNECTION_KEY : 'the ORM default connection';
  const name = rbac ?? admin ?? 'default';
  const orm = await container.resolve(Orm);
  const driver = orm.Connections.get(name);

  if (!driver) {
    throw new AuthzConfigError(`${key}: no ORM connection named ${JSON.stringify(name)} (connections: ${[...orm.Connections.keys()].join(', ')})`);
  }

  return driver;
}
