import type { Configuration } from '@spinajs/configuration';

export type RbacStoreKind = 'roles' | 'assignments' | 'rules' | 'links';

// Kept in code, not in the config fragment: fragment arrays concatenate with the app's, so a default
// listed there could never be removed and would appear twice when the app names it too.
export const RBAC_STORE_DEFAULTS: Readonly<Record<RbacStoreKind, readonly string[]>> = Object.freeze({
  roles: Object.freeze(['ConfigRoleStore']),
  assignments: Object.freeze(['DbAssignmentStore']),
  rules: Object.freeze(['ConfigRuleStore']),
  links: Object.freeze(['DbLinkStore']),
});

/** `authz.rbac.stores.<kind>` when the app sets it, else the default; duplicates dropped, order kept. */
export function rbacStoreNames(config: Pick<Configuration, 'get'>, kind: RbacStoreKind): readonly string[] {
  const configured = config.get<string[] | undefined>(['authz', 'rbac', 'stores', kind]);
  return [...new Set(configured ?? RBAC_STORE_DEFAULTS[kind])];
}
