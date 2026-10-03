import type { ThrottleFlow } from '@spinajs/authn/contracts';
import { InvalidOption } from '@spinajs/exceptions';

// Same shape and rules as N1's `@spinajs/authn` throttle params reader, so this file can give way to that export.

export interface BackoffParams {
  readonly free: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** A key kind without params does not gate in that flow. */
export interface ThrottleFlowParams {
  readonly account?: BackoffParams;
  readonly ip?: BackoffParams;
}

export interface ThrottleParams {
  readonly login: ThrottleFlowParams;
  readonly mfa: ThrottleFlowParams;
  readonly reset: ThrottleFlowParams;
  readonly reauth: ThrottleFlowParams;
  readonly resetAfterSeconds: number;
  /** Off (null) unless configured: one attacker could slow every login. */
  readonly global?: BackoffParams | null;
}

export const THROTTLE_FLOWS: readonly ThrottleFlow[] = Object.freeze(['login', 'mfa', 'reset', 'reauth']);

const backoff = (free: number, baseDelayMs: number, maxDelayMs: number): BackoffParams => Object.freeze({ free, baseDelayMs, maxDelayMs });

/** Design §22.5 `authn.throttle`. */
export const DEFAULT_THROTTLE_PARAMS: ThrottleParams = Object.freeze({
  login: Object.freeze({ account: backoff(5, 1000, 60000), ip: backoff(20, 1000, 300000) }),
  mfa: Object.freeze({ account: backoff(3, 1000, 300000), ip: backoff(20, 1000, 300000) }),
  reset: Object.freeze({ account: backoff(1, 60000, 3600000), ip: backoff(5, 10000, 900000) }),
  reauth: Object.freeze({ account: backoff(3, 1000, 300000) }),
  resetAfterSeconds: 86400,
  global: null,
});

/** The wait after counted attempt n (1-based): 0 until n reaches free, then min(baseDelayMs × 2^(n − free), maxDelayMs). */
export function backoffDelayMs(p: BackoffParams, n: number): number {
  return n < p.free ? 0 : Math.min(p.baseDelayMs * 2 ** (n - p.free), p.maxDelayMs);
}

const TOP_KEYS = new Set<string>(['service', ...THROTTLE_FLOWS, 'resetAfterSeconds', 'global']);
// maxRows belongs to MemoryAuthnThrottle; accepted here so one config serves both services.
const CONFIG_KEYS = new Set<string>([...TOP_KEYS, 'maxRows']);
const KINDS = ['account', 'ip'] as const;
const FIELDS = ['free', 'baseDelayMs', 'maxDelayMs'] as const;
const MIN: Record<(typeof FIELDS)[number], number> = { free: 0, baseDelayMs: 0, maxDelayMs: 1 };

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function record(v: unknown, at: string, allowed: ReadonlySet<string> | readonly string[]): Record<string, unknown> {
  if (!isRecord(v)) throw new InvalidOption(`${at} must be an object, got ${kindOf(v)}`);
  const known = new Set(allowed);
  const unknown = Object.keys(v).filter((k) => !known.has(k));
  if (unknown.length > 0) throw new InvalidOption(`${at}: unknown key(s) ${unknown.map((k) => JSON.stringify(k)).join(', ')}`);
  return v;
}

function readBackoff(raw: unknown, base: BackoffParams | undefined, at: string): BackoffParams {
  const o = record(raw, at, FIELDS);
  const out: Record<string, number> = {};
  for (const f of FIELDS) {
    const v = o[f] ?? base?.[f];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < MIN[f]) {
      throw new InvalidOption(`${at}.${f} must be an integer >= ${MIN[f]}, got ${v === undefined ? 'nothing' : kindOf(v)}${typeof v === 'number' ? ` ${v}` : ''}`);
    }
    out[f] = v;
  }
  return Object.freeze(out as unknown as BackoffParams);
}

function readFlow(raw: unknown, defaults: ThrottleFlowParams | undefined, at: string): ThrottleFlowParams {
  if (raw === undefined && defaults) return defaults;
  const o = record(raw, at, KINDS);
  const out: { account?: BackoffParams; ip?: BackoffParams } = {};
  for (const k of KINDS) {
    const base = defaults?.[k];
    if (o[k] !== undefined) out[k] = readBackoff(o[k], base, `${at}.${k}`);
    else if (base) out[k] = base;
  }
  return Object.freeze(out);
}

function readResetAfter(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
    throw new InvalidOption(`${at} must be an integer >= 1, got ${kindOf(v)}${typeof v === 'number' ? ` ${v}` : ''}`);
  }
  return v;
}

/**
 * `authn.throttle` merged over the §22.5 defaults: per flow and key kind, fields given replace the default's. Throws
 * InvalidOption on an unknown key or a bad value, so a typo cannot silently turn a gate off.
 */
export function readThrottleConfig(raw: unknown): ThrottleParams {
  if (raw === undefined || raw === null) return DEFAULT_THROTTLE_PARAMS;
  const o = record(raw, 'authn.throttle', CONFIG_KEYS);
  const d = DEFAULT_THROTTLE_PARAMS;
  return Object.freeze({
    login: readFlow(o.login, d.login, 'authn.throttle.login'),
    mfa: readFlow(o.mfa, d.mfa, 'authn.throttle.mfa'),
    reset: readFlow(o.reset, d.reset, 'authn.throttle.reset'),
    reauth: readFlow(o.reauth, d.reauth, 'authn.throttle.reauth'),
    resetAfterSeconds: o.resetAfterSeconds === undefined ? d.resetAfterSeconds : readResetAfter(o.resetAfterSeconds, 'authn.throttle.resetAfterSeconds'),
    global: o.global === undefined || o.global === null ? null : readBackoff(o.global, undefined, 'authn.throttle.global'),
  });
}

/** Explicit params, taken as complete: a flow or kind left out does not gate. */
export function checkThrottleParams(p: ThrottleParams): ThrottleParams {
  const o = record(p, 'throttle params', TOP_KEYS);
  const flow = (f: ThrottleFlow): ThrottleFlowParams => {
    if (o[f] === undefined) throw new InvalidOption(`throttle params.${f} is missing`);
    return readFlow(o[f], undefined, `throttle params.${f}`);
  };
  return Object.freeze({
    login: flow('login'),
    mfa: flow('mfa'),
    reset: flow('reset'),
    reauth: flow('reauth'),
    resetAfterSeconds: readResetAfter(o.resetAfterSeconds, 'throttle params.resetAfterSeconds'),
    global: o.global === undefined || o.global === null ? null : readBackoff(o.global, undefined, 'throttle params.global'),
  });
}
