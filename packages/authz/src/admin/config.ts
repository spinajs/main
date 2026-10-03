import { AuthzConfigError } from '../contracts/errors.js';
import { isPermission } from '../contracts/permission.js';
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

export const ADMIN_DEFAULTS = Object.freeze({ maxBatch: 100, backend: 'MemoryAuthzAdminBackend' });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const q = (v: unknown): string => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
};

/** Reads the `authz.admin` section; `where` prefixes the error messages. */
export function readAdminConfig(section: unknown, where: string): AdminConfig {
  const fail = (key: string, expected: string, got: unknown): never => {
    throw new AuthzConfigError(`${where}: configuration key authz.admin${key} must be ${expected}, got ${q(got)}`);
  };
  if (section === undefined) return { ...ADMIN_DEFAULTS, permissions: {} };
  if (!isObject(section)) fail('', 'an object', section);
  const s = section as Record<string, unknown>;

  const maxBatch = s.maxBatch ?? ADMIN_DEFAULTS.maxBatch;
  if (typeof maxBatch !== 'number' || !Number.isInteger(maxBatch) || maxBatch < 1) fail('.maxBatch', 'an integer >= 1', maxBatch);

  const backend = s.backend ?? ADMIN_DEFAULTS.backend;
  if (typeof backend !== 'string' || backend === '') fail('.backend', 'a non-empty class name', backend);

  let guard: string | undefined;
  if (s.guard !== undefined) {
    if (!isObject(s.guard)) fail('.guard', 'an object', s.guard);
    const name = (s.guard as Record<string, unknown>).service;
    if (name !== undefined && (typeof name !== 'string' || name === '')) fail('.guard.service', 'a non-empty class name', name);
    guard = name as string | undefined;
  }

  const permissions: Record<string, Permission | Record<string, Permission>> = {};
  if (s.permissions !== undefined) {
    if (!isObject(s.permissions)) fail('.permissions', 'an object', s.permissions);
    for (const [kind, value] of Object.entries(s.permissions as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (!isPermission(value)) fail(`.permissions.${kind}`, 'a permission name', value);
        permissions[kind] = value;
        continue;
      }
      if (!isObject(value)) fail(`.permissions.${kind}`, 'a permission name or an object of them by scope type', value);
      const byType: Record<string, Permission> = Object.create(null);
      for (const [type, p] of Object.entries(value as Record<string, unknown>)) {
        if (!isPermission(p)) fail(`.permissions.${kind}.${type}`, 'a permission name', p);
        byType[type] = p as Permission;
      }
      permissions[kind] = byType;
    }
  }

  return Object.freeze({ maxBatch: maxBatch as number, backend: backend as string, permissions: Object.freeze(permissions), ...(guard === undefined ? {} : { guard }) });
}

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
