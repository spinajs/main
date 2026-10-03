import { BlockList, isIP } from 'node:net';
import { DI } from '@spinajs/di';

import { ConditionFunction } from './contracts.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Principal } from '../contracts/principal.js';
import { matchGlob, matchWildcard } from '../engine/evaluate.js';

export type ConditionFunctionContext = { principal: Principal; actor?: Principal; env: Readonly<Record<string, unknown>> };

const BUILTIN = Symbol.for('spinajs.authz.builtinConditionFunction');

/**
 * A ConditionFunction that can answer UNKNOWN (`undefined`), which the core compiler keeps as
 * Kleene UNKNOWN instead of guessing true or false, and that checks its literal args at boot.
 * `evaluate` (the contract) throws where the answer is UNKNOWN.
 */
export abstract class KleeneConditionFunction extends ConditionFunction {
  abstract evaluateKleene(args: unknown, ctx: ConditionFunctionContext): boolean | undefined;

  /** Throws AuthzConfigError for literal args the function can never use; `{ ref }` values are checked when read. */
  checkArgs?(args: Readonly<Record<string, unknown>>, where: string): void;

  evaluate(args: unknown, ctx: ConditionFunctionContext): boolean {
    const v = this.evaluateKleene(args, ctx);
    if (v === undefined) throw new Error(`condition function ${JSON.stringify(this.name)} cannot decide on these args`);
    return v;
  }
}

/**
 * True for an instance of one of the built-in classes themselves, also from a second copy of
 * this module sharing one DI root; a subclass (an override) is not a built-in.
 */
export const isBuiltinConditionFunction = (f: unknown): boolean => {
  try {
    if (typeof f !== 'object' || f === null) return false;
    const ctor = (f as { constructor: Record<symbol, unknown> }).constructor;
    // The tag holds the name, so an instance renamed in plain JS is no built-in either.
    return Object.hasOwn(ctor, BUILTIN) && ctor[BUILTIN] === (f as { name?: unknown }).name;
  } catch {
    return false;
  }
};

// The parser's rule: an object whose only key is a string `ref`.
const isRef = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { ref?: unknown }).ref === 'string';
const argsOf = (args: unknown): Record<string, unknown> => (typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {});

function only(args: Readonly<Record<string, unknown>>, keys: readonly string[], where: string, name: string): void {
  for (const k of Object.keys(args)) if (!keys.includes(k)) throw new AuthzConfigError(`${where}: ${name} takes ${keys.join(', ')}, not ${JSON.stringify(k)}`);
}

/** A FIFO-bounded map: entries computed from request data must not grow without limit. */
class Bounded<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    return this.map.get(k);
  }
  has(k: string): boolean {
    return this.map.has(k);
  }
  set(k: string, v: V): void {
    if (!this.map.has(k) && this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(k, v);
  }
  get size(): number {
    return this.map.size;
  }
}

// ---- time.between ----

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string): number => {
  const m = CLOCK.exec(hhmm)!;
  return Number(m[1]) * 60 + Number(m[2]);
};
// Intl takes any casing, aliases and offsets of a zone, and tz may come from a ref, so the raw
// spellings are bounded and share one formatter per canonical zone.
const bySpelling = new Bounded<Intl.DateTimeFormat | null>(256);
const byZone = new Bounded<Intl.DateTimeFormat>(1024);

function formatter(tz: string): Intl.DateTimeFormat | null {
  const hit = bySpelling.get(tz);
  if (hit !== undefined) return hit;
  let f: Intl.DateTimeFormat | null;
  try {
    const made = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const zone = made.resolvedOptions().timeZone;
    f = byZone.get(zone) ?? made;
    byZone.set(zone, f);
  } catch {
    f = null;
  }
  bySpelling.set(tz, f);
  return f;
}

/** Sizes of the time-zone caches (tests). */
export const conditionFunctionCaches = { zones: (): { spellings: number; zones: number } => ({ spellings: bySpelling.size, zones: byZone.size }) };

/**
 * `{ from: 'HH:MM', to: 'HH:MM', tz?: 'Europe/Warsaw' }`: `env.now` at or after `from` and before
 * `to` on the wall clock of `tz` (an IANA zone or an offset such as '+01:00'; default UTC);
 * `from` after `to` wraps past midnight. It reads the wall clock: on a night the clocks go back
 * the repeated hour counts twice, on a night they go forward the skipped hour never comes.
 * `from` equal to `to` is refused at boot and UNKNOWN when refs give it.
 */
export class TimeBetween extends KleeneConditionFunction {
  static readonly [BUILTIN]: string = 'time.between';
  readonly name: string = 'time.between';

  checkArgs(args: Readonly<Record<string, unknown>>, where: string): void {
    only(args, ['from', 'to', 'tz'], where, this.name);
    for (const k of ['from', 'to']) {
      const v = args[k];
      if (!isRef(v) && (typeof v !== 'string' || !CLOCK.test(v))) throw new AuthzConfigError(`${where}: time.between ${k} must be "HH:MM" (00:00-23:59) or a {ref}`);
    }
    if (typeof args.from === 'string' && args.from === args.to) throw new AuthzConfigError(`${where}: time.between from and to are both ${args.from}, an empty range`);
    const tz = args.tz;
    if (tz !== undefined && !isRef(tz) && (typeof tz !== 'string' || !formatter(tz))) throw new AuthzConfigError(`${where}: time.between tz ${JSON.stringify(tz)} is not a time zone`);
  }

  evaluateKleene(args: unknown, ctx: ConditionFunctionContext): boolean | undefined {
    const { from, to, tz = 'UTC' } = argsOf(args);
    const now = ctx.env.now;
    if (typeof from !== 'string' || typeof to !== 'string' || !CLOCK.test(from) || !CLOCK.test(to) || from === to || typeof tz !== 'string') return undefined;
    const f = formatter(tz);
    if (!f || !(now instanceof Date) || Number.isNaN(now.getTime())) return undefined;
    const parts = f.formatToParts(now);
    const t = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
    const a = minutesOf(from);
    const b = minutesOf(to);
    return a < b ? a <= t && t < b : t >= a || t < b;
  }
}

// ---- ip.in ----

const MAX_CACHED_RANGES = 1024;
const lists = new Bounded<BlockList | null>(256);

function toBigInt(address: string, version: 4 | 6): bigint {
  if (version === 4) return address.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
  let text = address;
  let tail: bigint[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = toBigInt(dotted[1], 4);
    tail = [v4 >> 16n, v4 & 0xffffn];
    text = text.slice(0, -dotted[1].length) + 'x';
  }
  const [head, rest] = text.split('::');
  const groups = (s: string | undefined) => (s ? s.split(':').filter((g) => g !== 'x') : []);
  const left = groups(head).map((g) => BigInt(parseInt(g, 16)));
  const right = rest === undefined ? [] : groups(rest).map((g) => BigInt(parseInt(g, 16)));
  const fill = 8 - left.length - right.length - tail.length;
  const all = [...left, ...(rest === undefined ? [] : Array<bigint>(fill).fill(0n)), ...right, ...tail];
  return all.reduce((n, g) => (n << 16n) | g, 0n);
}

/**
 * `10.0.0.0/8`, `2001:db8::/32`, or a single address; null when malformed, when it carries a
 * zone id (`%eth0`), or when host bits are set (`10.0.0.1/8`: strict, so a typo cannot widen it).
 */
function parseRange(s: unknown): { network: string; prefix: number; type: 'ipv4' | 'ipv6' } | null {
  if (typeof s !== 'string' || s.includes('%')) return null;
  const [network, bits, ...rest] = s.split('/');
  const v = isIP(network);
  if (v === 0 || rest.length > 0) return null;
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
  if (!(prefix >= 0 && prefix <= max)) return null;
  const host = (1n << BigInt(max - prefix)) - 1n;
  if ((toBigInt(network, v as 4 | 6) & host) !== 0n) return null;
  return { network, prefix, type: v === 4 ? 'ipv4' : 'ipv6' };
}

function blockList(ranges: readonly unknown[]): BlockList | null {
  const build = (): BlockList | null => {
    const list = new BlockList();
    for (const r of ranges) {
      const p = parseRange(r);
      if (!p) return null;
      list.addSubnet(p.network, p.prefix, p.type);
    }
    return list;
  };
  if (ranges.length > MAX_CACHED_RANGES) return build();
  const key = JSON.stringify(ranges);
  if (!lists.has(key)) lists.set(key, build());
  return lists.get(key)!;
}

/**
 * `{ cidrs: ['10.0.0.0/8', '2001:db8::/32'], ip?: address }`: `ip` (default `env.ip`) lies in one
 * of the ranges. IPv4 and IPv4-mapped IPv6 forms match each other, so an IPv6 range that covers
 * `::ffff:0:0/96` (`::/0` does) matches IPv4 clients too.
 */
export class IpIn extends KleeneConditionFunction {
  static readonly [BUILTIN]: string = 'ip.in';
  readonly name: string = 'ip.in';

  checkArgs(args: Readonly<Record<string, unknown>>, where: string): void {
    only(args, ['cidrs', 'ip'], where, this.name);
    const { cidrs, ip } = args;
    if (!isRef(cidrs)) {
      if (!Array.isArray(cidrs) || cidrs.length === 0) throw new AuthzConfigError(`${where}: ip.in cidrs must be a non-empty list or a {ref}`);
      cidrs.forEach((c, i) => {
        if (!parseRange(c)) throw new AuthzConfigError(`${where}: ip.in cidrs[${i}] ${JSON.stringify(c)} is not an IP range (an address, or a network with no host bits set, and no zone id)`);
      });
    }
    if (ip !== undefined && !isRef(ip) && (typeof ip !== 'string' || ip.includes('%') || isIP(ip) === 0)) throw new AuthzConfigError(`${where}: ip.in ip ${JSON.stringify(ip)} is not an IP address`);
  }

  evaluateKleene(args: unknown, ctx: ConditionFunctionContext): boolean | undefined {
    const a = argsOf(args);
    const ip = Object.hasOwn(a, 'ip') ? a.ip : ctx.env.ip;
    if (typeof ip !== 'string' || ip.includes('%') || !Array.isArray(a.cidrs) || a.cidrs.length === 0) return undefined;
    const v = isIP(ip);
    const list = blockList(a.cidrs);
    if (v === 0 || !list) return undefined;
    return list.check(ip, v === 4 ? 'ipv4' : 'ipv6');
  }
}

// ---- glob, wildcard ----

/** `{ value, pattern }`: `value` matches the glob (`*` stops at `/`, `**` crosses it), as the cmp `glob` does. */
export class GlobMatch extends KleeneConditionFunction {
  static readonly [BUILTIN]: string = 'glob';
  readonly name: string = 'glob';
  protected match = matchGlob;

  checkArgs(args: Readonly<Record<string, unknown>>, where: string): void {
    only(args, ['value', 'pattern'], where, this.name);
    for (const k of ['value', 'pattern']) {
      const v = args[k];
      if (!isRef(v) && typeof v !== 'string') throw new AuthzConfigError(`${where}: ${this.name} ${k} must be a string or a {ref}`);
    }
  }

  evaluateKleene(args: unknown): boolean | undefined {
    const { value, pattern } = argsOf(args);
    return typeof value === 'string' && typeof pattern === 'string' ? this.match(pattern, value) : undefined;
  }
}

/** `{ value, pattern }`: `*` is any run of characters, `/` included, as the cmp `wildcard` does. */
export class WildcardMatch extends GlobMatch {
  static readonly [BUILTIN]: string = 'wildcard';
  readonly name: string = 'wildcard';
  protected match = matchWildcard;
}

export const BUILTIN_CONDITION_FUNCTIONS: readonly ConditionFunction[] = Object.freeze([new TimeBetween(), new IpIn(), new GlobMatch(), new WildcardMatch()]);

for (const f of [TimeBetween, IpIn, GlobMatch, WildcardMatch]) DI.register(f).as(ConditionFunction);
