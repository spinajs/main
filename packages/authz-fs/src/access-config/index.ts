import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { isPlainObject } from '@spinajs/util';

import { show } from '../checks.js';

export * from './schema.js';
export * from './acl-config.js';

export type FsAccessMode = 'off' | 'audit' | 'enforce';

/** `authz.fs.<name>.signedUrl` (D9). */
export interface FsSignedUrlConfig {
  /** Cap on every signed URL's lifetime. */
  readonly maxTtlSeconds?: number;
  /** Lifetime when the caller asks for no `until`; default 900 (the S3 signer's own default). */
  readonly defaultTtlSeconds?: number;
}

/** `authz.fs.<name>` (fs middleware design §2). */
export interface FsAccessConfig {
  readonly mode: FsAccessMode;
  /** Authz domain the checks run in; default 'root'. Another domain must exist: authz-fs never creates one. */
  readonly domain: string;
  /** Record the first writer of a path an action creates as its `owner` ACL row. */
  readonly stampOwner?: boolean;
  readonly list?: 'dir' | 'each';
  readonly signedUrl?: FsSignedUrlConfig;
}

const MODES: readonly unknown[] = ['off', 'audit', 'enforce'];
const KEYS: ReadonlySet<string> = new Set(['mode', 'domain', 'stampOwner', 'list', 'signedUrl']);

const OFF: FsAccessConfig = Object.freeze({ mode: 'off', domain: 'root' });

/**
 * `authz.fs.<fsName>` of the Configuration resolved in `container`, read on every call. A filesystem without an
 * entry is off.
 */
export function fsAccessConfig(fsName: string, container: IContainer = DI.RootContainer): FsAccessConfig {
  const all = fsSection(container);
  return all ? parseFsAccessConfig(fsName, Object.hasOwn(all, fsName) ? all[fsName] : undefined) : OFF;
}

function fsSection(container: IContainer): Readonly<Record<string, unknown>> | undefined {
  const configuration = container.get(Configuration) as Configuration | undefined;
  if (!configuration || typeof configuration.get !== 'function') {
    throw new AuthzConfigError('authz.fs: Configuration is not resolved; await DI.resolve(Configuration) first');
  }
  const all = configuration.get<unknown>(['authz', 'fs']);
  if (all === undefined || all === null) return undefined;
  // Fail-closed floor for a section no schema checked (Configuration.set, test configurations): it would read as every filesystem off.
  if (!isPlainObject(all)) throw new AuthzConfigError(`authz.fs must be an object keyed by filesystem name, got ${show(all)}`);
  return all;
}

/**
 * One `authz.fs.<fsName>` entry; undefined is a missing entry (off). AUTHZ_FS_CONFIGURATION_SCHEMA checks the entry
 * at boot; it may also come from a Configuration no schema checked, so every value is checked here too.
 * @throws AuthzConfigError for a malformed value or an unknown key: a removed key such as `policies` must not be
 *   dropped silently, since a dropped deny policy would open files
 */
export function parseFsAccessConfig(fsName: string, entry: unknown): FsAccessConfig {
  if (entry === undefined) return OFF;
  const at = `authz.fs.${fsName}`;
  const mode = isPlainObject(entry) ? entry.mode : undefined;
  if (!MODES.includes(mode)) throw new AuthzConfigError(`${at}.mode must be one of ${MODES.join(', ')}, got ${show(isPlainObject(entry) ? mode : entry)}`);
  const e = entry as Record<string, unknown>;
  for (const key of Object.keys(e)) if (!KEYS.has(key)) throw new AuthzConfigError(`${at}.${key} is not an authz.fs option (${[...KEYS].join(', ')})`);
  if (e.domain !== undefined && (typeof e.domain !== 'string' || e.domain === '')) throw new AuthzConfigError(`${at}.domain must be a non-empty string, got ${show(e.domain)}`);
  if (e.stampOwner !== undefined && typeof e.stampOwner !== 'boolean') throw new AuthzConfigError(`${at}.stampOwner must be a boolean, got ${show(e.stampOwner)}`);
  if (e.list !== undefined && e.list !== 'dir' && e.list !== 'each') throw new AuthzConfigError(`${at}.list must be 'dir' or 'each', got ${show(e.list)}`);
  const out: Record<string, unknown> = { ...e, domain: e.domain ?? 'root' };
  if (e.signedUrl !== undefined) out.signedUrl = signedUrlOf(e.signedUrl, `${at}.signedUrl`);
  return Object.freeze(out) as unknown as FsAccessConfig;
}

function signedUrlOf(value: unknown, at: string): FsSignedUrlConfig {
  if (!isPlainObject(value)) throw new AuthzConfigError(`${at} must be an object, got ${show(value)}`);
  for (const [key, ttl] of Object.entries(value)) {
    if (key !== 'maxTtlSeconds' && key !== 'defaultTtlSeconds') throw new AuthzConfigError(`${at}.${key} is not a signedUrl option`);
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw new AuthzConfigError(`${at}.${key} must be a positive finite number, got ${show(ttl)}`);
  }
  return Object.freeze({ ...value }) as FsSignedUrlConfig;
}
