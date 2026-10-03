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

/** True for the built-ins, also when two copies of this module are loaded (ESM and CJS). */
export const isBuiltinConditionFunction = (f: unknown): boolean => typeof f === 'object' && f !== null && (f as Record<symbol, unknown>)[BUILTIN] === true;

const isRef = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { ref?: unknown }).ref === 'string';
const argsOf = (args: unknown): Record<string, unknown> => (typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {});

function only(args: Readonly<Record<string, unknown>>, keys: readonly string[], where: string, name: string): void {
  for (const k of Object.keys(args)) if (!keys.includes(k)) throw new AuthzConfigError(`${where}: ${name} takes ${keys.join(', ')}, not ${JSON.stringify(k)}`);
}

abstract class Builtin extends KleeneConditionFunction {
  readonly [BUILTIN] = true;
}

// ---- time.between ----

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string): number => {
  const m = CLOCK.exec(hhmm)!;
  return Number(m[1]) * 60 + Number(m[2]);
};
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  return f;
}

function validZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * `{ from: 'HH:MM', to: 'HH:MM', tz?: 'Europe/Warsaw' }`: `env.now` at or after `from` and before
 * `to` on the wall clock of `tz` (default UTC); `from` after `to` wraps past midnight.
 */
export class TimeBetween extends Builtin {
  readonly name = 'time.between';

  checkArgs(args: Readonly<Record<string, unknown>>, where: string): void {
    only(args, ['from', 'to', 'tz'], where, this.name);
    for (const k of ['from', 'to']) {
      const v = args[k];
      if (!isRef(v) && (typeof v !== 'string' || !CLOCK.test(v))) throw new AuthzConfigError(`${where}: time.between ${k} must be "HH:MM" (00:00-23:59) or a {ref}`);
    }
    if (typeof args.from === 'string' && args.from === args.to) throw new AuthzConfigError(`${where}: time.between from and to are both ${args.from}, an empty range`);
    const tz = args.tz;
    if (tz !== undefined && !isRef(tz) && (typeof tz !== 'string' || !validZone(tz))) throw new AuthzConfigError(`${where}: time.between tz ${JSON.stringify(tz)} is not an IANA time zone`);
  }

  evaluateKleene(args: unknown, ctx: ConditionFunctionContext): boolean | undefined {
    const { from, to, tz = 'UTC' } = argsOf(args);
    const now = ctx.env.now;
    if (typeof from !== 'string' || typeof to !== 'string' || !CLOCK.test(from) || !CLOCK.test(to) || typeof tz !== 'string' || !validZone(tz)) return undefined;
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return undefined;
    const parts = formatter(tz).formatToParts(now);
    const t = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
    const a = minutesOf(from);
    const b = minutesOf(to);
    if (a === b) return false;
    return a < b ? a <= t && t < b : t >= a || t < b;
  }
}

// ---- ip.in ----

const MAX_LISTS = 256;
const lists = new Map<string, BlockList | null>();

/** `10.0.0.0/8`, `2001:db8::/32`, or a single address; null when malformed. */
function parseRange(s: unknown): { network: string; prefix: number; type: 'ipv4' | 'ipv6' } | null {
  if (typeof s !== 'string') return null;
  const [network, bits, ...rest] = s.split('/');
  const v = isIP(network);
  if (v === 0 || rest.length > 0) return null;
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
  if (!(prefix >= 0 && prefix <= max)) return null;
  return { network, prefix, type: v === 4 ? 'ipv4' : 'ipv6' };
}

function blockList(ranges: readonly unknown[]): BlockList | null {
  const key = JSON.stringify(ranges);
  if (lists.has(key)) return lists.get(key)!;
  let list: BlockList | null = new BlockList();
  for (const r of ranges) {
    const p = parseRange(r);
    if (!p) {
      list = null;
      break;
    }
    list.addSubnet(p.network, p.prefix, p.type);
  }
  if (lists.size >= MAX_LISTS) lists.delete(lists.keys().next().value!);
  lists.set(key, list);
  return list;
}

/** `{ cidrs: ['10.0.0.0/8', '2001:db8::/32'], ip?: address }`: `ip` (default `env.ip`) lies in one of the ranges. */
export class IpIn extends Builtin {
  readonly name = 'ip.in';

  checkArgs(args: Readonly<Record<string, unknown>>, where: string): void {
    only(args, ['cidrs', 'ip'], where, this.name);
    const { cidrs, ip } = args;
    if (!isRef(cidrs)) {
      if (!Array.isArray(cidrs) || cidrs.length === 0) throw new AuthzConfigError(`${where}: ip.in cidrs must be a non-empty list or a {ref}`);
      cidrs.forEach((c, i) => {
        if (!parseRange(c)) throw new AuthzConfigError(`${where}: ip.in cidrs[${i}] ${JSON.stringify(c)} is not an IP range`);
      });
    }
    if (ip !== undefined && !isRef(ip) && (typeof ip !== 'string' || isIP(ip) === 0)) throw new AuthzConfigError(`${where}: ip.in ip ${JSON.stringify(ip)} is not an IP address`);
  }

  evaluateKleene(args: unknown, ctx: ConditionFunctionContext): boolean | undefined {
    const a = argsOf(args);
    const ip = Object.hasOwn(a, 'ip') ? a.ip : ctx.env.ip;
    if (typeof ip !== 'string' || !Array.isArray(a.cidrs) || a.cidrs.length === 0) return undefined;
    const v = isIP(ip);
    const list = blockList(a.cidrs);
    if (v === 0 || !list) return undefined;
    return list.check(ip, v === 4 ? 'ipv4' : 'ipv6');
  }
}

// ---- glob, wildcard ----

/** `{ value, pattern }`: `value` matches the glob (`*` stops at `/`, `**` crosses it), as the cmp `glob` does. */
export class GlobMatch extends Builtin {
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
  readonly name: string = 'wildcard';
  protected match = matchWildcard;
}

export const BUILTIN_CONDITION_FUNCTIONS: readonly ConditionFunction[] = Object.freeze([new TimeBetween(), new IpIn(), new GlobMatch(), new WildcardMatch()]);

for (const f of [TimeBetween, IpIn, GlobMatch, WildcardMatch]) DI.register(f).as(ConditionFunction);
