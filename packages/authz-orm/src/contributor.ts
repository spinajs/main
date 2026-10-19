import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { Autoinject, Container, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Orm, extractModelDescriptor } from '@spinajs/orm';

import { nameOf, registeredClasses, registeredTypes } from './registry.js';

/** `authz.rbac.connection` and `authz.admin.connection` as configured. */
export interface StoresConnectionConfig {
  readonly rbac?: unknown;
  readonly admin?: unknown;
}

/** The connection of the authz stores, by authz-rbac's rule (packages/authz-rbac/src/stores/context.ts:65-79). */
export function storesConnection({ rbac, admin }: StoresConnectionConfig): { name: string; key: string } {
  if (typeof rbac === 'string' && rbac !== '') return { name: rbac, key: 'authz.rbac.connection' };
  if (typeof admin === 'string' && admin !== '') return { name: admin, key: 'authz.admin.connection' };
  return { name: 'default', key: 'the ORM default connection' };
}

/**
 * Every list joins authz_assignment (and, with @Parent, authz_resource_ancestor) with the resource table,
 * and every delete forgets scopes in the statement's transaction: each @AccessResource model must share
 * the stores' connection.
 */
export function checkResourceConnections(orm: Orm, config: StoresConnectionConfig): void {
  const { name, key } = storesConnection(config);
  const stores = orm.Connections.get(name);
  if (!stores) throw new AuthzConfigError(`authz-orm: ${key} gives ${JSON.stringify(name)}, but there is no ORM connection named ${JSON.stringify(name)} (connections: ${[...orm.Connections.keys()].join(', ')})`);
  const wrong: string[] = [];
  for (const cls of registeredClasses()) {
    const driver = extractModelDescriptor(cls as never)?.Driver;
    if (!driver || driver === stores) continue;
    wrong.push(`${nameOf(cls)} (connection ${JSON.stringify(driver.Options?.Name)})`);
  }
  if (wrong.length > 0) throw new AuthzConfigError(`authz-orm: @AccessResource models must use the authz stores' connection ${JSON.stringify(name)} (${key}), where authz_resource_ancestor and authz_assignment live: ${wrong.join(', ')}`);
}

/** Runs the check at every domain boot and gives rule 12 the `@AccessResource` types, so a list permission on any other type is refused. */
@Singleton()
@Injectable(AuthzContributor)
export class AuthzOrmContributor extends AuthzContributor {
  // Apps resolve Orm without registering it, so an optional inject would never see it; and the check must not boot it.
  @Autoinject(Container)
  protected Container: IContainer;

  @Config('authz.rbac.connection')
  protected RbacConnection: unknown;

  @Config('authz.admin.connection')
  protected AdminConnection: unknown;

  contribute(_domain: string): AuthzContribution {
    // listTypes come from the decorators and need no ORM; only the connection check does.
    if (this.Container.isResolved(Orm)) checkResourceConnections(this.Container.get(Orm) as Orm, { rbac: this.RbacConnection, admin: this.AdminConnection });
    return { listTypes: registeredTypes() };
  }
}
