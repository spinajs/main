import { AuthzConfigError } from '@spinajs/authz';
import type { Configuration } from '@spinajs/configuration';
import type { Class, IContainer } from '@spinajs/di';

import { AdminAssignmentStore, AdminLinkStore, AdminMembershipStore, AdminRuleStore } from '../admin/ports.js';
import { AssignmentStore, LinkStore, MembershipStore, RoleStore, RuleStore } from '../contracts.js';
import { rbacStoreNames } from './defaults.js';
import type { RbacStoreKind } from './defaults.js';

// The token the RBAC model reads, and the AuthzAdmin port a store of that kind may also serve.
const PORTS: Readonly<Record<RbacStoreKind, { readonly token: Class<unknown>; readonly admin?: Class<unknown> }>> = {
  roles: { token: RoleStore },
  assignments: { token: AssignmentStore, admin: AdminAssignmentStore },
  rules: { token: RuleStore, admin: AdminRuleStore },
  links: { token: LinkStore, admin: AdminLinkStore },
  membership: { token: MembershipStore, admin: AdminMembershipStore },
};

/**
 * Registers in `container` (a domain's) the store classes `authz.rbac.stores.*` names
 * ({@link rbacStoreNames}, design §8.2): each under its port (`RoleStore`, `AssignmentStore`,
 * `RuleStore`, `LinkStore`) and, when it implements L9's port, under `AdminAssignmentStore`,
 * `AdminRuleStore` or `AdminLinkStore` too. A name must be a class registered in DI under that name
 * (`@Injectable()` registers a store by its class name) that extends the port; otherwise
 * `AuthzConfigError` names the key, and nothing is registered.
 */
export function registerRbacStores(container: IContainer, configuration: Pick<Configuration, 'get'>): void {
  const plan: (readonly [Class<unknown>, Class<unknown>])[] = [];

  for (const kind of Object.keys(PORTS) as RbacStoreKind[]) {
    const { token, admin } = PORTS[kind];
    const key = `authz.rbac.stores.${kind}`;
    for (const name of rbacStoreNames(configuration, kind)) {
      const type = storeClass(container, name);
      if (!type) throw new AuthzConfigError(`${key}: no store class is registered under the name ${JSON.stringify(name)}; is the package that provides it loaded?`);
      if (!(type.prototype instanceof token)) throw new AuthzConfigError(`${key}: ${JSON.stringify(name)} is not a ${token.name}`);
      plan.push([type, token]);
      if (admin && type.prototype instanceof admin) plan.push([type, admin]);
    }
  }

  for (const [type, token] of plan) container.register(type).as(token);
}

/** The store class registered in DI under `name` (the last one), or undefined. */
export function storeClass(container: IContainer, name: string): Class<unknown> | undefined {
  if (typeof name !== 'string' || name === '' || !container.hasRegistered(name)) return undefined;
  const types = (container.Registry.getTypes(name) ?? []) as unknown[];
  // The last class registered under the name; factories (no prototype) cannot be registered under a port by class.
  return [...types].reverse().find((t): t is Class<unknown> => typeof t === 'function' && t.prototype !== undefined);
}
