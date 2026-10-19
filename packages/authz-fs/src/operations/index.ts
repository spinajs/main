import { AuthzConfigError } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';

import type { FsAccessConfig } from '../access-config/index.js';
import type { FsPathKind } from '../refs/index.js';

/** One path argument of a filesystem method and what it needs. */
export interface FsPathSpec {
  readonly arg: number;
  readonly permissions: readonly Permission[];
  readonly kind: FsPathKind;
  /** The path is on the filesystem the operation's `dstFs` argument names. */
  readonly onDestination?: boolean;
  /** `string | (string | [path, entryName])[]`: zip sources. */
  readonly sources?: boolean;
  /**
   * The name the provider uses when the argument is absent; the guard computes it, checks it and passes it:
   * the basename of another argument, or the destination's `tmpname(ext)`.
   */
  readonly default?: { readonly basenameOf: number } | { readonly tmpname: string };
  /** The raw method gets the path with a trailing '/' (key stores list by prefix: 'docs' also matches 'docs.txt'). */
  readonly dirSlash?: boolean;
}

export interface FsOperation {
  readonly paths: readonly FsPathSpec[];
  /**
   * The argument naming the destination filesystem. When it is absent the destination is the called
   * filesystem ('self'), or the one the provider falls back to ('provider'; the guard places it per provider).
   */
  readonly dstFs?: { readonly arg: number; readonly absent: 'self' | 'provider' };
}

/** Pure or DI lifecycle members the guard never checks (design §13); config may not map them. */
export const FS_UNCHECKED_METHODS: ReadonlySet<string> = new Set(['resolvePath', 'tmppath', 'tmpname', 'resolve', 'dispose', '__checkInstance__', 'constructor']);

const path = (arg: number, permissions: readonly Permission[], kind: FsPathKind, extra: Omit<FsPathSpec, 'arg' | 'permissions' | 'kind'> = {}): FsPathSpec => Object.freeze({ arg, permissions: Object.freeze([...permissions]), kind, ...extra });

const op = (paths: readonly FsPathSpec[], dstFs?: FsOperation['dstFs']): FsOperation => Object.freeze({ paths: Object.freeze([...paths]), ...(dstFs ? { dstFs: Object.freeze({ ...dstFs }) } : {}) });

const on = (permissions: readonly Permission[], kind: FsPathKind = 'file'): FsOperation => op([path(0, permissions, kind)]);

function table(entries: Record<string, FsOperation>): Readonly<Record<string, FsOperation>> {
  // No prototype: a method name such as 'toString' must not find an entry.
  return Object.freeze(Object.assign(Object.create(null) as Record<string, FsOperation>, entries));
}

/** Method → checks of study §9.3 as design §13 keeps it, plus signed URLs (fs:share). */
export const FS_OPERATIONS: Readonly<Record<string, FsOperation>> = table({
  read: on(['fs:read']),
  readStream: on(['fs:read']),
  download: on(['fs:read']),
  hash: on(['fs:read']),
  metadata: on(['fs:read']),
  exists: on(['fs:stat']),
  stat: on(['fs:stat']),
  isDir: on(['fs:stat'], 'dir'),
  dirExists: on(['fs:stat'], 'dir'),
  list: op([path(0, ['fs:list'], 'dir', { dirSlash: true })]),
  write: on(['fs:write']),
  writeStream: on(['fs:write']),
  append: on(['fs:write']),
  mkdir: on(['fs:write'], 'dir'),
  // srcPath is a local file outside every filesystem.
  upload: op([path(1, ['fs:write'], 'file', { default: Object.freeze({ basenameOf: 0 }) })]),
  rm: on(['fs:delete']),
  copy: op([path(0, ['fs:read'], 'file'), path(1, ['fs:write'], 'file', { onDestination: true })], { arg: 2, absent: 'self' }),
  move: op([path(0, ['fs:read', 'fs:delete'], 'file'), path(1, ['fs:write'], 'file', { onDestination: true })], { arg: 2, absent: 'self' }),
  rename: op([path(0, ['fs:read', 'fs:delete'], 'file'), path(1, ['fs:write'], 'file')]),
  zip: op([path(0, ['fs:read'], 'file', { sources: true }), path(2, ['fs:write'], 'file', { onDestination: true, default: Object.freeze({ tmpname: '.zip' }) })], { arg: 1, absent: 'provider' }),
  unzip: op([path(0, ['fs:read'], 'file'), path(1, ['fs:write'], 'dir', { onDestination: true, default: Object.freeze({ tmpname: '' }) })], { arg: 2, absent: 'provider' }),
  signedUrl: on(['fs:share']),
  getSignedUrl: on(['fs:share']),
});

/** Method → permission, or the list when a method needs several (ResourceAdapter.operations()). */
export function fsOperationPermissions(operations: Readonly<Record<string, FsOperation>>): Readonly<Record<string, Permission | readonly Permission[]>> {
  const out: Record<string, Permission | readonly Permission[]> = Object.create(null);
  for (const [method, operation] of Object.entries(operations)) {
    const permissions = [...new Set(operation.paths.flatMap((p) => p.permissions))];
    out[method] = permissions.length === 1 ? permissions[0] : Object.freeze(permissions);
  }
  return Object.freeze(out);
}

/**
 * FS_OPERATIONS with `authz.fs.<fsName>.operations` added or replacing entries, checked on argument 0: a new
 * method as a file, a replaced one with its own kind (list, isDir, … stay dir checks). An entry that checks more than its first argument (copy, move, rename, zip, unzip, upload) cannot be
 * replaced: one check on argument 0 would drop the others.
 *
 * @throws AuthzConfigError for such a replacement or for an unchecked member (resolvePath, tmppath, …)
 */
export function effectiveFsOperations(config: FsAccessConfig, fsName: string): Readonly<Record<string, FsOperation>> {
  if (!config.operations) return FS_OPERATIONS;
  const out: Record<string, FsOperation> = Object.assign(Object.create(null), FS_OPERATIONS);
  for (const [method, permissions] of Object.entries(config.operations)) {
    const at = `authz.fs.${fsName}.operations.${method}`;
    if (FS_UNCHECKED_METHODS.has(method)) throw new AuthzConfigError(`${at}: ${method} is never checked and cannot be mapped`);
    const builtIn = FS_OPERATIONS[method];
    if (builtIn && (builtIn.paths.length > 1 || builtIn.dstFs || builtIn.paths.some((p) => p.arg !== 0 || p.default || p.sources))) {
      throw new AuthzConfigError(`${at}: ${method} checks more than its first argument, so a mapping cannot replace it`);
    }
    const list = typeof permissions === 'string' ? [permissions] : permissions;
    // A replaced directory method stays a dir check with the same path handling.
    out[method] = builtIn ? op([path(0, list, builtIn.paths[0].kind, builtIn.paths[0].dirSlash ? { dirSlash: true } : {})]) : on(list);
  }
  return Object.freeze(out);
}
