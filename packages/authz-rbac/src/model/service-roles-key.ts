import { WILDCARD_ID } from './sets/resolver.js';

/**
 * An `authz.rbac.serviceRoles` key: a principal key `<type>:<id>` (see `principalKey`), never a wildcard, whose
 * config roles would never be read. The schema quotes this pattern in its violation, hence the group names.
 */
export const SERVICE_ROLES_KEY = /^(?<type>[^:]+):(?<id>(?!\*$).+)$/;

/** Why `key` cannot be an `authz.rbac.serviceRoles` key, or undefined when it can. */
export function serviceRolesKeyProblem(key: string): string | undefined {
  if (SERVICE_ROLES_KEY.test(key)) return undefined;
  const colon = key.indexOf(':');
  if (colon > 0 && key.slice(colon + 1) === WILDCARD_ID) return `names the wildcard of '${key.slice(0, colon)}'; config roles go to one principal each, so list one key per principal, or grant the wildcard subject through AuthzAdmin`;
  return `must be a principal key '<type>:<id>'${colon === -1 ? `, for example 'service:${key}'` : ''}`;
}
