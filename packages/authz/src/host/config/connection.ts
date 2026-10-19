import { AuthzConfigError } from '../../contracts/errors.js';

/** The ORM connection alias of every authz table; an app maps it with `db.Aliases.authz`. */
export const AUTHZ_CONNECTION = 'authz';

const REMOVED_KEYS = [
  ['admin', 'connection'],
  ['rbac', 'connection'],
] as const;

/** Fails boot on the keys `db.Aliases.authz` replaced, so an app's choice of database is never ignored. */
export function checkRemovedConnectionKeys(authz: unknown): void {
  const tree = (authz ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const set = REMOVED_KEYS.filter(([section, key]) => tree[section]?.[key] !== undefined).map(([section, key]) => `authz.${section}.${key}`);
  if (set.length === 0) return;
  throw new AuthzConfigError(`${set.join(', ')}: removed; the authz tables use the ORM connection alias "${AUTHZ_CONNECTION}", so set db.Aliases.${AUTHZ_CONNECTION} to the connection name instead (default: "default")`);
}
