import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import type { TrailConfig } from './contracts.js';
import { AuditConfigError } from './errors.js';
import { isRecord, quoted } from './guards.js';
import { assertMaskPaths } from './mask.js';

export const DEFAULT_TRAIL = 'default';

/** The identifiers of a security event; the `data` members are the ones `@spinajs/audit-authn` writes. */
export const SECURITY_HASH_PATHS: readonly string[] = ['actor', 'onBehalfOf', 'origin', 'data.identity', 'data.actor', 'data.ip', 'data.session'];

const BUILT_IN = new Map<string, Readonly<Record<string, unknown>>>([
  [DEFAULT_TRAIL, { table: 'audit_event' }],
  ['history', { table: 'orm_history' }],
  ['security', { store: 'LogAuditStore', hash: SECURITY_HASH_PATHS }],
]);

export interface DeferredConfig {
  readonly flushMs: number;
  readonly maxBatch: number;
  readonly maxBuffered: number;
  readonly timeoutMs: number;
  /** How long a target may stay blocked behind an append that does not settle before its order is given up; default 10 × timeoutMs. */
  readonly blockCeilingMs: number;
}

// The resolved Configuration nearest to `container` in its lineage; with none, every trail is the built-in one.
const section = (name: string, container: IContainer): Record<string, unknown> => {
  const value = container.get(Configuration)?.get<unknown>(['audit', name]);
  return isRecord(value) ? value : {};
};

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const list = (v: unknown): readonly string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
// Bounded so that audit_<trail> fits the schema's 63-character table names.
const DERIVABLE = /^[a-z][a-z0-9_]{0,56}$/;

function tableOf(name: string, raw: Record<string, unknown>): string {
  const own = text(raw.table);
  if (own !== undefined) return own;
  if (!DERIVABLE.test(name)) throw new AuditConfigError(`audit: trail ${quoted(name)} has no table, and its name is not a plain identifier (${DERIVABLE.source}) to derive audit_<trail> from; set audit.trails.${name}.table`);
  return `audit_${name}`;
}

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback);

function delayMs(value: unknown, trail: string): number {
  if (value === undefined) return 100;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  const match = typeof value === 'string' ? /^(\d+)(ms|s|m)?$/.exec(value) : null;
  if (!match) throw new AuditConfigError(`audit: trail ${quoted(trail)}: retry.delay must be milliseconds or a duration like "100ms", "2s" or "1m"`);
  return Number(match[1]) * (match[2] === 's' ? 1000 : match[2] === 'm' ? 60000 : 1);
}

/** The built-in trails, then the configured ones. */
export function trailNames(container: IContainer = DI.RootContainer): readonly string[] {
  return [...new Set([...BUILT_IN.keys(), ...Object.keys(section('trails', container))])];
}

export function deferredConfig(container: IContainer = DI.RootContainer): DeferredConfig {
  const raw = section('deferred', container);
  const timeoutMs = positive(raw.timeoutMs, 2000);
  return { flushMs: positive(raw.flushMs, 1000), maxBatch: positive(raw.maxBatch, 500), maxBuffered: positive(raw.maxBuffered, 10000), timeoutMs, blockCeilingMs: positive(raw.blockCeilingMs, 10 * timeoutMs) };
}

/** The trail as `container` configures it, laid over the built-in trail of the same name and the defaults. Read on every call. */
export function trailConfig(name: string = DEFAULT_TRAIL, container: IContainer = DI.RootContainer): TrailConfig {
  const trails = section('trails', container);
  const own: unknown = Object.hasOwn(trails, name) ? trails[name] : undefined;
  const builtIn = BUILT_IN.get(name);
  if (!isRecord(own) && builtIn === undefined) throw new AuditConfigError(`audit: no trail named ${quoted(name)} (configured: ${trailNames(container).join(', ')})`);

  const raw: Record<string, unknown> = { ...builtIn, ...(isRecord(own) ? own : {}) };
  const retry = isRecord(raw.retry) ? raw.retry : {};
  const config: TrailConfig = {
    name,
    store: text(raw.store) ?? 'TableAuditStore',
    table: tableOf(name, raw),
    connection: text(raw.connection) ?? 'default',
    onFailure: raw.onFailure === 'reject' ? 'reject' : 'continue',
    retry: { attempts: positive(retry.attempts, 3), delayMs: delayMs(retry.delay, name) },
    integrity: raw.integrity === 'sealed' ? 'sealed' : 'none',
    omit: list(raw.omit),
    mask: list(raw.mask),
    hash: list(raw.hash),
    retentionDays: typeof raw.retentionDays === 'number' ? raw.retentionDays : undefined,
    sink: text(raw.sink),
    reader: text(raw.reader),
    archiveConnection: text(raw.archiveConnection),
  };
  assertMaskPaths(`trail ${quoted(name)}`, { omit: config.omit, mask: config.mask, hash: config.hash });
  return config;
}
