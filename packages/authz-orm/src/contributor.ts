import { AUTHZ_CONNECTION, AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { Orm, extractModelDescriptor } from '@spinajs/orm';

import { nameOf, registeredClasses, registeredTypes } from './registry.js';

/**
 * Every list joins authz_assignment (and, with @Parent, authz_resource_ancestor) with the resource table,
 * and every delete forgets scopes in the statement's transaction: each @AccessResource model must use the
 * connection of the authz tables, the one db.Aliases.authz names.
 */
export function checkResourceConnections(orm: Orm): void {
  const stores = orm.Connections.get(AUTHZ_CONNECTION);
  if (!stores) throw new AuthzConfigError(`authz-orm: no ORM connection answers to "${AUTHZ_CONNECTION}"; set db.Aliases.${AUTHZ_CONNECTION} (connections: ${[...orm.Connections.keys()].join(', ')})`);
  const wrong: string[] = [];
  for (const cls of registeredClasses()) {
    const driver = extractModelDescriptor(cls as never)?.Driver;
    if (!driver || driver === stores) continue;
    wrong.push(`${nameOf(cls)} (connection ${JSON.stringify(driver.Options?.Name)})`);
  }
  if (wrong.length > 0) throw new AuthzConfigError(`authz-orm: @AccessResource models must use the authz connection ${JSON.stringify(stores.Options?.Name)} (db.Aliases.${AUTHZ_CONNECTION}), where authz_resource_ancestor and authz_assignment live: ${wrong.join(', ')}`);
}

/** Runs the check at every domain boot and gives rule 12 the `@AccessResource` types, so a list permission on any other type is refused. */
@Singleton()
@Injectable(AuthzContributor)
export class AuthzOrmContributor extends AuthzContributor {
  contribute(_domain: string): AuthzContribution {
    if (!DI.RootContainer.isResolved(Orm)) return {};
    checkResourceConnections(DI.get(Orm) as Orm);
    return { listTypes: registeredTypes() };
  }
}
