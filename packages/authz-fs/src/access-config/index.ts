import { AuthzConfigError, isPermission } from '@spinajs/authz';
import type { Permission, Policy, ResourceRef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { FS_RESOURCE_TYPES, parseFsRef } from '../refs/index.js';

export * from './schema.js';

export type FsAccessMode = 'off' | 'audit' | 'enforce';

/** `authz.fs.<name>.signedUrl` (D9). */
export interface FsSignedUrlConfig {
  /** Cap on every signed URL's lifetime. */
  readonly maxTtlSeconds?: number;
  /** Lifetime when the caller asks for no `until`; default 900 (the S3 signer's own default). */
  readonly defaultTtlSeconds?: number;
}

/** `authz.fs.<name>` (design §13). */
export interface FsAccessConfig {
  readonly mode: FsAccessMode;
  /** Authz domain the guard asks; default 'root'. */
  readonly domain: string;
  /** Class name of a FileMetadataStore. */
  readonly metadata?: string;
  readonly stampOwner?: boolean;
  /** Class name of the FsPathResolver for this filesystem. */
  readonly resolver?: string;
  /** fs permission → action checked on the resolver's domain parent. */
  readonly inherit?: Readonly<Record<Permission, string>>;
  readonly signedUrl?: FsSignedUrlConfig;
  readonly policies?: readonly Policy[];
  /** Method → permission(s), added to or replacing the operation table. */
  readonly operations?: Readonly<Record<string, Permission | readonly Permission[]>>;
  readonly list?: 'dir' | 'each';
}

const MODES: readonly unknown[] = ['off', 'audit', 'enforce'];
const FS_TYPES: readonly unknown[] = FS_RESOURCE_TYPES;

const OFF: FsAccessConfig = Object.freeze({ mode: 'off', domain: 'root' });

/**
 * `authz.fs.<fsName>` of the Configuration resolved in `container`, read on every call. A filesystem without an
 * entry is off (design §13: "any other fs: off").
 */
export function fsAccessConfig(fsName: string, container: IContainer = DI.RootContainer): FsAccessConfig {
  const all = fsSection(container, `authz.fs.${fsName}`);
  return all ? parseFsAccessConfig(fsName, Object.hasOwn(all, fsName) ? all[fsName] : undefined) : OFF;
}

/** Every `authz.fs.<name>` entry of the Configuration resolved in `container`, by filesystem name. */
export function fsAccessConfigs(container: IContainer = DI.RootContainer): ReadonlyMap<string, FsAccessConfig> {
  const all = fsSection(container, 'authz.fs');
  return new Map(Object.keys(all ?? {}).map((name) => [name, parseFsAccessConfig(name, all![name])]));
}

function fsSection(container: IContainer, at: string): Readonly<Record<string, unknown>> | undefined {
  const configuration = container.get(Configuration) as Configuration | undefined;
  if (!configuration || typeof configuration.get !== 'function') {
    throw new AuthzConfigError(`${at}: Configuration is not resolved; await DI.resolve(Configuration) first`);
  }
  const all = configuration.get<unknown>(['authz', 'fs']);
  if (all === undefined || all === null) return undefined;
  // Fail-closed floor for a section no schema checked (Configuration.set, test configurations): it would read as every filesystem off.
  if (!isRecord(all)) throw new AuthzConfigError(`authz.fs must be an object keyed by filesystem name, got ${show(all)}`);
  return all;
}

/**
 * One `authz.fs.<fsName>` entry as the guard reads it; undefined is a missing entry (off). AUTHZ_FS_CONFIGURATION_SCHEMA
 * checks the entry. This fills the domain, gives a policy without a scope the filesystem, and copies inherit and
 * operations onto objects without a prototype, so no method name reads an inherited value.
 *
 * The entry may come from a Configuration no schema checked, so a malformed mode, signedUrl TTL, operation or
 * policy still fails closed here: the guard runs any mode but 'enforce' as 'audit', an empty list checks nothing,
 * and the fs-abac model answers every check of its domain.
 * @throws AuthzConfigError for a policy scope outside the filesystem: the schema cannot compare a value with its key
 */
export function parseFsAccessConfig(fsName: string, entry: unknown): FsAccessConfig {
  if (entry === undefined) return OFF;
  const at = `authz.fs.${fsName}`;
  const mode = isRecord(entry) ? entry.mode : undefined;
  if (!MODES.includes(mode)) throw new AuthzConfigError(`${at}.mode must be one of ${MODES.join(', ')}, got ${show(isRecord(entry) ? mode : entry)}`);
  const e = entry as Record<string, unknown>;
  const out: Record<string, unknown> = { ...e, domain: e.domain ?? 'root' };
  if (e.inherit !== undefined) out.inherit = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, e.inherit));
  if (e.signedUrl !== undefined) out.signedUrl = signedUrlOf(e.signedUrl as FsSignedUrlConfig, `${at}.signedUrl`);
  if (e.operations !== undefined) out.operations = operationsOf(e.operations as Readonly<Record<string, Permission | readonly Permission[]>>, `${at}.operations`);
  if (e.policies !== undefined) out.policies = scopedPolicies(e.policies as readonly unknown[], fsName);
  return Object.freeze(out) as unknown as FsAccessConfig;
}

function signedUrlOf(value: FsSignedUrlConfig, at: string): FsSignedUrlConfig {
  for (const [key, ttl] of Object.entries(value)) {
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw new AuthzConfigError(`${at}.${key} must be a positive finite number, got ${show(ttl)}`);
  }
  return Object.freeze({ ...value });
}

function operationsOf(value: Readonly<Record<string, Permission | readonly Permission[]>>, at: string): Readonly<Record<string, Permission | readonly Permission[]>> {
  const out: Record<string, Permission | readonly Permission[]> = Object.create(null);
  for (const [method, permissions] of Object.entries(value)) {
    const list: readonly unknown[] = Array.isArray(permissions) ? permissions : [permissions];
    if (list.length === 0 || !list.every(isPermission)) throw new AuthzConfigError(`${at}.${method} must be a permission name or a non-empty list of them, got ${show(permissions)}`);
    out[method] = Array.isArray(permissions) ? Object.freeze([...(permissions as readonly Permission[])]) : (permissions as Permission);
  }
  return Object.freeze(out);
}

/**
 * The policies of one filesystem stay on it (design §13: fs-only policies). The fs-abac model holds the policies of
 * every filesystem of a domain, so each policy gets the filesystem as its scope; a scope elsewhere (a resolver parent
 * such as a task, which is no ancestor of a path) would never match.
 */
function scopedPolicies(policies: readonly unknown[], fsName: string): readonly Policy[] {
  return Object.freeze(
    policies.map((value, i) => {
      const policy = isRecord(value) ? value : {};
      const fail = (text: string): never => {
        throw new AuthzConfigError(`authz.fs.${fsName}.policies: policy ${show(policy.id ?? `#${i}`)}: ${text}`);
      };
      if (!fsOnly(policy)) fail('permissions must be a non-empty list of fs permissions or globs (fs:<op>), resourceTypes only fs types');
      const scope = policy.scope ?? { type: 'fs', id: fsName };
      const ref = isRecord(scope) && typeof scope.id === 'string' ? parseFsRef(scope as unknown as ResourceRef) : undefined;
      if (ref?.fs !== fsName) fail(`scope ${show(scope)} is not this filesystem or a path of it`);
      return Object.freeze({ ...policy, scope });
    }),
  ) as unknown as readonly Policy[];
}

const fsOnly = ({ permissions, resourceTypes }: Record<string, unknown>): boolean =>
  Array.isArray(permissions) &&
  permissions.length > 0 &&
  permissions.every((p) => typeof p === 'string' && p.startsWith('fs:')) &&
  (resourceTypes === undefined || (Array.isArray(resourceTypes) && resourceTypes.every((t) => FS_TYPES.includes(t))));

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};
