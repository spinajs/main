import { AUTHZ_CONNECTION, AuthzConfigError, AuthzDomains, DefaultAuthzDomains } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';
import { OrmDriver, extractModelDescriptor } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

import { recordDriver } from './records.js';

const ROOT_DOMAIN = 'root';

/**
 * The driver of `tx`, an `AuthzAdmin` transaction on the connection `record` lives on (D-L2-1, D-L2-2).
 * Stores write only inside one (design §9.2); a write on another connection would land where the reads
 * never look.
 */
export function requireTransaction(record: typeof ModelBase, tx: AuthzTx, where: string): OrmDriver {
  const driver = tx?.driver;
  if (!(driver instanceof OrmDriver)) {
    throw new AuthzConfigError(`${where}: AuthzTx.driver must be the OrmDriver of an AuthzAdmin transaction`);
  }
  if (driver.CurrentTransaction === undefined) {
    throw new AuthzConfigError(`${where}: stores write only inside an AuthzAdmin transaction, and none is in scope`);
  }
  const own = recordDriver(record);
  if (driver !== own) {
    throw new AuthzConfigError(`${where}: the AuthzTx runs on connection ${JSON.stringify(driver.Options.Name)}, but ${extractModelDescriptor(record)?.TableName} is on connection ${JSON.stringify(own.Options.Name)} (db.Aliases.${AUTHZ_CONNECTION})`);
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
