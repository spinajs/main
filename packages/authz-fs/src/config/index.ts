import { AuthzConfigError, isPermission } from '@spinajs/authz';
import type { Permission, Policy, ResourceRef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { FS_RESOURCE_TYPES, parseFsRef } from '../refs/index.js';

export type FsAccessMode = 'off' | 'audit' | 'enforce';

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
  readonly signedUrl?: { readonly maxTtlSeconds?: number };
  readonly policies?: readonly Policy[];
  /** Method → permission(s), added to or replacing the operation table. */
  readonly operations?: Readonly<Record<string, Permission | readonly Permission[]>>;
  readonly list?: 'dir' | 'each';
}

const MODES: readonly FsAccessMode[] = ['off', 'audit', 'enforce'];
const LISTS: readonly string[] = ['dir', 'each'];
const KEYS = new Set(['mode', 'domain', 'metadata', 'stampOwner', 'resolver', 'inherit', 'signedUrl', 'policies', 'operations', 'list']);

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const OFF: FsAccessConfig = Object.freeze({ mode: 'off', domain: 'root' });

/**
 * `authz.fs.<fsName>` of the Configuration resolved in `container`, read on every call. A filesystem without an
 * entry is off (design §13: "any other fs: off").
 */
export function fsAccessConfig(fsName: string, container: IContainer = DI.RootContainer): FsAccessConfig {
  const all = fsSection(container, `authz.fs.${fsName}`);
  return all ? parseFsAccessConfig(fsName, Object.hasOwn(all, fsName) ? all[fsName] : undefined) : OFF;
}

/** Every `authz.fs.<name>` entry of the Configuration resolved in `container`, validated, by filesystem name. */
export function fsAccessConfigs(container: IContainer = DI.RootContainer): ReadonlyMap<string, FsAccessConfig> {
  const all = fsSection(container, 'authz.fs');
  return new Map(Object.keys(all ?? {}).map((name) => [name, parseFsAccessConfig(name, all![name])]));
}

function fsSection(container: IContainer, at: string): Record<string, unknown> | undefined {
  const configuration = container.get(Configuration) as Configuration | undefined;
  if (!configuration || typeof configuration.get !== 'function') {
    throw new AuthzConfigError(`${at}: Configuration is not resolved; await DI.resolve(Configuration) first`);
  }
  const all: unknown = configuration.get(['authz', 'fs']);
  if (all === undefined || all === null) {
    return undefined;
  }
  if (!isRecord(all)) {
    throw new AuthzConfigError(`authz.fs must be an object keyed by filesystem name, got ${show(all)}`);
  }
  return all;
}

/** Validates one `authz.fs.<fsName>` entry; undefined is a missing entry. */
export function parseFsAccessConfig(fsName: string, entry: unknown): FsAccessConfig {
  const at = `authz.fs.${fsName}`;
  if (entry === undefined) {
    return OFF;
  }
  if (!isRecord(entry)) {
    throw new AuthzConfigError(`${at} must be an object, got ${show(entry)}`);
  }
  for (const key of Object.keys(entry)) {
    if (!KEYS.has(key)) throw new AuthzConfigError(`${at}.${key} is not a known key (expected one of ${[...KEYS].join(', ')})`);
  }

  // A present entry must say its mode: an entry with policies but a mistyped or missing mode must not be silently off.
  if (!MODES.includes(entry.mode as FsAccessMode)) {
    throw new AuthzConfigError(`${at}.mode must be one of ${MODES.join(', ')}, got ${show(entry.mode)}`);
  }
  const out: Record<string, unknown> = { mode: entry.mode, domain: 'root' };

  if (entry.domain !== undefined) out.domain = nonEmptyString(entry.domain, `${at}.domain`);
  if (entry.metadata !== undefined) out.metadata = nonEmptyString(entry.metadata, `${at}.metadata`);
  if (entry.resolver !== undefined) out.resolver = nonEmptyString(entry.resolver, `${at}.resolver`);
  if (entry.stampOwner !== undefined) {
    if (typeof entry.stampOwner !== 'boolean') throw new AuthzConfigError(`${at}.stampOwner must be a boolean, got ${show(entry.stampOwner)}`);
    out.stampOwner = entry.stampOwner;
    if (entry.stampOwner && out.metadata === undefined) throw new AuthzConfigError(`${at}.stampOwner needs ${at}.metadata, the FileMetadataStore that keeps the owners`);
  }
  if (entry.inherit !== undefined) out.inherit = parseInherit(entry.inherit, `${at}.inherit`);
  if (entry.signedUrl !== undefined) out.signedUrl = parseSignedUrl(entry.signedUrl, `${at}.signedUrl`);
  if (entry.policies !== undefined) out.policies = parsePolicies(entry.policies, `${at}.policies`, fsName);
  if (entry.operations !== undefined) out.operations = parseOperations(entry.operations, `${at}.operations`);
  if (entry.list !== undefined) {
    if (!LISTS.includes(entry.list as string)) throw new AuthzConfigError(`${at}.list must be one of ${LISTS.join(', ')}, got ${show(entry.list)}`);
    out.list = entry.list;
  }
  return Object.freeze(out) as unknown as FsAccessConfig;
}

function parseInherit(value: unknown, at: string): Readonly<Record<Permission, string>> {
  if (!isRecord(value)) throw new AuthzConfigError(`${at} must be an object of permission → action, got ${show(value)}`);
  const out: Record<string, string> = Object.create(null);
  for (const [permission, action] of Object.entries(value)) {
    if (!isPermission(permission)) throw new AuthzConfigError(`${at}.${permission}: the key must be a permission name`);
    if (!permission.startsWith('fs:')) throw new AuthzConfigError(`${at}.${permission}: the key must be an fs permission (fs:<op>)`);
    out[permission] = nonEmptyString(action, `${at}.${permission}`);
    // fs-inherit checks `<parent type>:<action>`, so the action alone must complete a permission name.
    if (!isPermission(`x:${action as string}`)) throw new AuthzConfigError(`${at}.${permission} must be an action name such as 'read', got ${show(action)}`);
  }
  return Object.freeze(out);
}

function parseSignedUrl(value: unknown, at: string): { readonly maxTtlSeconds?: number } {
  if (!isRecord(value)) throw new AuthzConfigError(`${at} must be an object, got ${show(value)}`);
  for (const key of Object.keys(value)) {
    if (key !== 'maxTtlSeconds') throw new AuthzConfigError(`${at}.${key} is not a known key (expected maxTtlSeconds)`);
  }
  if (value.maxTtlSeconds === undefined) return Object.freeze({});
  const ttl = value.maxTtlSeconds;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw new AuthzConfigError(`${at}.maxTtlSeconds must be a positive finite number, got ${show(ttl)}`);
  return Object.freeze({ maxTtlSeconds: ttl });
}

const FS_TYPES = new Set<string>(FS_RESOURCE_TYPES);

/**
 * The policies of one filesystem stay on it (design §13: fs-only policies). The fs-abac model holds the policies of
 * every filesystem of a domain and also answers the domain's other checks (fs-inherit's parent checks), so each
 * policy names only `fs:` permissions and fs types, and gets the filesystem as its scope. A scope elsewhere (a
 * resolver parent such as a task, which is no ancestor of a path) would never match. The fs-abac model validates
 * the rest.
 */
function parsePolicies(value: unknown, at: string, fsName: string): readonly Policy[] {
  if (!Array.isArray(value)) throw new AuthzConfigError(`${at} must be a list of policies, got ${show(value)}`);
  return Object.freeze(
    value.map((policy, i) => {
      if (!isRecord(policy)) throw new AuthzConfigError(`${at}[${i}] must be a policy object, got ${show(policy)}`);
      const fail = (text: string): never => {
        throw new AuthzConfigError(`${at}: policy ${show(policy.id ?? `#${i}`)}: ${text}`);
      };
      const permissions = policy.permissions;
      if (!Array.isArray(permissions) || permissions.length === 0) fail('permissions must be a non-empty list');
      for (const p of permissions as unknown[]) if (typeof p !== 'string' || !p.startsWith('fs:')) fail(`${show(p)} is not an fs permission or glob (fs:<op>)`);
      if (policy.resourceTypes !== undefined) {
        if (!Array.isArray(policy.resourceTypes) || !policy.resourceTypes.every((t) => FS_TYPES.has(t as string))) fail(`resourceTypes must list only ${[...FS_TYPES].join(', ')}`);
      }
      const scope = policy.scope ?? { type: 'fs', id: fsName };
      const ref = isRecord(scope) && typeof scope.id === 'string' ? parseFsRef(scope as unknown as ResourceRef) : undefined;
      if (ref?.fs !== fsName) fail(`scope ${show(scope)} is not this filesystem or a path of it`);
      return Object.freeze({ ...policy, scope });
    }),
  ) as readonly Policy[];
}

function parseOperations(value: unknown, at: string): Readonly<Record<string, Permission | readonly Permission[]>> {
  if (!isRecord(value)) throw new AuthzConfigError(`${at} must be an object of method → permission(s), got ${show(value)}`);
  // No prototype, so a method name such as 'toString' never reads an inherited value; a JSON '__proto__' key would set one.
  const out: Record<string, Permission | readonly Permission[]> = Object.create(null);
  for (const [method, permissions] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(method)) throw new AuthzConfigError(`${at}.${method} is not allowed as a method name`);
    const list: unknown[] = Array.isArray(permissions) ? permissions : [permissions];
    if (list.length === 0 || !list.every(isPermission)) {
      throw new AuthzConfigError(`${at}.${method} must be a permission name or a non-empty list of them, got ${show(permissions)}`);
    }
    out[method] = Array.isArray(permissions) ? Object.freeze([...(permissions as Permission[])]) : (permissions as Permission);
  }
  return Object.freeze(out);
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value === '') throw new AuthzConfigError(`${at} must be a non-empty string, got ${show(value)}`);
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};
