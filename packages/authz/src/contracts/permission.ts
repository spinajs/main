import { AuthzConfigError } from './errors.js';
import type { ResourceType } from './principal.js';

export type Permission = string;

export interface PermissionDef {
  readonly name: Permission; // 'fs:write'
  readonly resource: string; // 'fs'      (parsed)
  readonly action: string; // 'write'   (parsed)
  readonly types: readonly ResourceType[]; // resource types it may be checked on; default [resource]
  readonly implies?: readonly Permission[]; // 'fs:write' implies 'fs:stat'
  readonly fields?: boolean; // grants/policies may carry field sets
  readonly description?: string;
  readonly source: string; // 'config' | 'adapter:orm' | 'model:rbac' ...
}

export abstract class PermissionRegistry {
  abstract get(name: Permission): PermissionDef | undefined;
  abstract require(name: Permission): PermissionDef; // throws UnknownPermission (B02)
  abstract match(glob: string): readonly PermissionDef[];
  abstract impliedBy(name: Permission): readonly Permission[];
  abstract all(): readonly PermissionDef[];
}

// The functions use private copies so that nothing done to the exported
// RegExp objects (compile(), lastIndex) can change how names are checked.
const NAME = /^[A-Za-z][A-Za-z0-9_.-]*:[A-Za-z][A-Za-z0-9_.-]*$/;
const GLOB = /^(?:\*|[A-Za-z0-9_.*-]+:[A-Za-z0-9_.*-]+)$/;

export const PERMISSION_PATTERN: RegExp = Object.freeze(new RegExp(NAME.source));
export const PERMISSION_GLOB_PATTERN: RegExp = Object.freeze(new RegExp(GLOB.source));

export const isPermission = (name: unknown): name is Permission => typeof name === 'string' && NAME.test(name);

export const parsePermission = (name: string): { readonly resource: string; readonly action: string } => {
  if (!isPermission(name)) {
    throw new AuthzConfigError(`Invalid permission name ${quote(name)}: expected <resource>:<action>, each [A-Za-z][A-Za-z0-9_.-]*`);
  }

  const at = name.indexOf(':');
  return Object.freeze({ resource: name.slice(0, at), action: name.slice(at + 1) });
};

export const isPermissionGlob = (glob: unknown): glob is string => typeof glob === 'string' && GLOB.test(glob);

export const compilePermissionGlob = (glob: string): ((name: Permission) => boolean) => {
  if (!isPermissionGlob(glob)) {
    throw new AuthzConfigError(`Invalid permission glob ${quote(glob)}: expected '*' or <resource-glob>:<action-glob>, each [A-Za-z0-9_.*-]+`);
  }

  if (glob === '*') {
    return () => true;
  }

  if (!glob.includes('*')) {
    return (name) => name === glob;
  }

  const pattern = new RegExp(`^${glob.split('*').map(escapeRegExp).join('[^:]*')}$`);
  return (name) => pattern.test(name);
};

export const matchesPermission = (glob: string, name: Permission): boolean => compilePermissionGlob(glob)(name);

const escapeRegExp = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const quote = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value) : String(value));
