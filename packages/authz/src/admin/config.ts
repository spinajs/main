import type { Permission } from '../contracts/permission.js';
import type { ResourceType } from '../contracts/principal.js';

/** `{ [kind or 'family.*']: permission | { [scopeType or '*']: permission } }` */
export type AdminPermissionMap = Readonly<Record<string, Permission | Readonly<Record<string, Permission>>>>;

export interface AdminConfig {
  readonly maxBatch: number;
  readonly permissions: AdminPermissionMap;
  /** The AuthzAdminBackend class name. */
  readonly backend: string;
  /** The AdminGuard class name; undefined fails every call closed. */
  readonly guard?: string;
}

/** The schema defaults of authz.admin; DefaultAuthzAdmin falls back to them for a Configuration that skips the schema. */
export const ADMIN_DEFAULTS = Object.freeze({ maxBatch: 100, backend: 'MemoryAuthzAdminBackend' });

/**
 * The permission authz.admin.permissions maps `kind` at `type` to, else `fallback`.
 * Exact kind before its family ('assignment.*'); within an entry, the scope type before '*'.
 * An entry without a match for the type passes on to the next one.
 */
export function mapPermission(map: AdminPermissionMap, kind: string, type: ResourceType, fallback: Permission): Permission {
  const dot = kind.indexOf('.');
  const keys = dot > 0 ? [kind, `${kind.slice(0, dot)}.*`] : [kind];
  for (const key of keys) {
    if (!Object.hasOwn(map, key)) continue;
    const value = map[key];
    if (typeof value === 'string') return value;
    if (Object.hasOwn(value, type)) return value[type];
    if (Object.hasOwn(value, '*')) return value['*'];
  }
  return fallback;
}
