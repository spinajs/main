import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { Orm, extractModelDescriptor } from '@spinajs/orm';

import { entryOf, nameOf, registeredClasses, registeredTypes } from './registry.js';

interface ConfigSource {
  get<T>(path: string[]): T;
}

/** The connection of the authz stores, by authz-rbac's rule (packages/authz-rbac/src/stores/context.ts:65-79). */
export function storesConnection(config: ConfigSource | undefined = DI.get(Configuration) as unknown as ConfigSource | undefined): { name: string; key: string } {
  const rbac = config?.get<string | undefined>(['authz', 'rbac', 'connection']);
  if (typeof rbac === 'string' && rbac !== '') return { name: rbac, key: 'authz.rbac.connection' };
  const admin = config?.get<string | undefined>(['authz', 'admin', 'connection']);
  if (typeof admin === 'string' && admin !== '') return { name: admin, key: 'authz.admin.connection' };
  return { name: 'default', key: 'the ORM default connection' };
}

/**
 * The list query joins authz_resource_ancestor and authz_assignment with the resource table, and a delete
 * forgets scopes in the statement's transaction: models with @Parent must share the stores' connection.
 */
export function checkResourceConnections(orm: Orm, config?: ConfigSource): void {
  const { name, key } = storesConnection(config);
  const stores = orm.Connections.get(name);
  if (!stores) throw new AuthzConfigError(`authz-orm: ${key} gives ${JSON.stringify(name)}, but there is no ORM connection named ${JSON.stringify(name)} (connections: ${[...orm.Connections.keys()].join(', ')})`);
  const wrong: string[] = [];
  for (const cls of registeredClasses()) {
    if ((entryOf(cls)?.parents.length ?? 0) === 0) continue;
    const driver = extractModelDescriptor(cls as never)?.Driver;
    if (!driver || driver === stores) continue;
    wrong.push(`${nameOf(cls)} (connection ${JSON.stringify(driver.Options?.Name)})`);
  }
  if (wrong.length > 0) throw new AuthzConfigError(`authz-orm: @AccessResource models with @Parent must use the authz stores' connection ${JSON.stringify(name)} (${key}), where authz_resource_ancestor and authz_assignment live: ${wrong.join(', ')}`);
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
