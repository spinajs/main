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
  /** Usable with list helpers (`.accessible()`); boot rule 12 checks every model can plan it. */
  readonly list?: boolean;
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
// No adjacent stars: '**' stays free for a later meaning.
const GLOB = /^(?:\*|(?:[A-Za-z0-9_.-]|\*(?!\*))+:(?:[A-Za-z0-9_.-]|\*(?!\*))+)$/;

export const PERMISSION_PATTERN: RegExp = Object.freeze(new RegExp(NAME.source));
export const PERMISSION_GLOB_PATTERN: RegExp = Object.freeze(new RegExp(GLOB.source));

export const isPermission = (name: unknown): name is Permission => typeof name === 'string' && NAME.test(name);

export const parsePermission = (name: string): { readonly resource: string; readonly action: string } => {
  assertPermission(name);
  const at = name.indexOf(':');
  return Object.freeze({ resource: name.slice(0, at), action: name.slice(at + 1) });
};

export const isPermissionGlob = (glob: unknown): glob is string => typeof glob === 'string' && GLOB.test(glob);

export const compilePermissionGlob = (glob: string): ((name: Permission) => boolean) => {
  if (!isPermissionGlob(glob)) {
    throw new AuthzConfigError(`Invalid permission glob ${quote(glob)}: expected '*' or <resource-glob>:<action-glob>, each a run of [A-Za-z0-9_.*-] without '**'`);
  }

  if (glob === '*') {
    return (name) => {
      assertPermission(name);
      return true;
    };
  }

  const split = glob.indexOf(':');
  const resource = glob.slice(0, split);
  const action = glob.slice(split + 1);

  return (name) => {
    assertPermission(name);
    const at = name.indexOf(':');
    return matchPart(resource, name, 0, at) && matchPart(action, name, at + 1, name.length);
  };
};

export const matchesPermission = (glob: string, name: Permission): boolean => compilePermissionGlob(glob)(name);

const assertPermission = (name: Permission): void => {
  if (!isPermission(name)) {
    throw new AuthzConfigError(`Invalid permission name ${quote(name)}: expected <resource>:<action>, each [A-Za-z][A-Za-z0-9_.-]*`);
  }
};

// Greedy wildcard match of glob against text[from, to): on a mismatch, retry
// from the last '*' one character later. Worst case O(|glob| * |text|); the
// text is a valid (registered, short) name. A regex built from the glob would
// backtrack exponentially on globs such as 'a*a*a*...c'.
const matchPart = (glob: string, text: string, from: number, to: number): boolean => {
  let g = 0;
  let i = from;
  let star = -1;
  let mark = from;

  while (i < to) {
    if (glob[g] === '*') {
      star = g++;
      mark = i;
    } else if (g < glob.length && glob[g] === text[i]) {
      g++;
      i++;
    } else if (star >= 0) {
      g = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }

  while (glob[g] === '*') {
    g++;
  }

  return g === glob.length;
};

const quote = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value) : String(value));
