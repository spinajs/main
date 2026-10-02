import * as fc from 'fast-check';

import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';

/**
 * Pool options all follow one rule: absent means the default pool, `[]` means none. Where an
 * arbitrary can do without a pool it drops the part that needs it; where it cannot, it throws.
 */
export const fromPool = <T>(pool: readonly T[], what = 'pool'): fc.Arbitrary<T> => {
  if (pool.length === 0) throw new Error(`arbitraries: ${what} is empty`);
  return fc.constantFrom(...pool);
};

// Small pools on purpose: generated values collide often, which is what the properties need.
export const DEFAULT_IDS: readonly string[] = ['a', 'b', 'c', 'd'];
export const DEFAULT_TYPES: readonly string[] = ['org', 'project', 'file', 'dir'];
export const DEFAULT_ROLES: readonly string[] = ['viewer', 'editor', 'manager', 'owner', 'guest'];
export const DEFAULT_PERMISSIONS: readonly string[] = ['file:read', 'file:write', 'file:delete', 'project:read', 'project:write'];
export const DEFAULT_FIELDS: readonly string[] = ['name', 'status', 'owner', 'n'];
export const DEFAULT_VALUES: readonly (string | number)[] = ['a', 'b', 'c', 1, 2, 3];

const WORD = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/);
export const word = (): fc.Arbitrary<string> => WORD;

export const idOf = (pool?: readonly string[]): fc.Arbitrary<string> => fromPool(pool ?? DEFAULT_IDS, 'ids');

export const typeOf = (pool?: readonly string[]): fc.Arbitrary<string> => fromPool(pool ?? DEFAULT_TYPES, 'types');

export interface RefOptions {
  readonly types?: readonly string[];
  readonly ids?: readonly string[];
}

/** Dates are drawn within 30 days either side of `now`; without it, from a fixed absolute range. */
export interface NowOption {
  readonly now?: Date;
}

/** Always carries an id; GLOBAL is the one id-less scope and is mixed in only on request. */
export function scopeRef(opts: RefOptions & { readonly global?: boolean } = {}): fc.Arbitrary<ResourceRef> {
  const ref = fc.record({ type: typeOf(opts.types), id: idOf(opts.ids) }) as fc.Arbitrary<ResourceRef>;
  return opts.global ? fc.oneof({ weight: 1, arbitrary: fc.constant(GLOBAL) }, { weight: 4, arbitrary: ref }) : ref;
}

export const optional = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arb, { nil: undefined });

/** `arb` with the given chance (percent) of being present; absent (undefined) is what it shrinks to. */
export function withOdds<T>(arb: fc.Arbitrary<T>, percent: number): fc.Arbitrary<T | undefined> {
  if (percent >= 100) return arb;
  if (percent <= 0) return fc.constant(undefined);
  return fc.oneof({ weight: 100 - percent, arbitrary: fc.constant(undefined) }, { weight: percent, arbitrary: arb });
}

/** A record whose keys are each present with their own chance (percent, `fallback` by default); undefined values are dropped. */
export function sparse(spec: Readonly<Record<string, fc.Arbitrary<unknown>>>, odds: Readonly<Record<string, number>> = {}, fallback = 30): fc.Arbitrary<Record<string, unknown>> {
  const keys = Object.keys(spec);
  return fc.tuple(...keys.map((k) => withOdds(spec[k], odds[k] ?? fallback))).map((values) => {
    const out: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      if (values[i] !== undefined) out[k] = values[i];
    });
    return out;
  });
}

export const subset = <T>(pool: readonly T[], maxLength = pool.length): fc.Arbitrary<T[]> => fc.shuffledSubarray([...pool], { minLength: 1, maxLength: Math.max(1, Math.min(maxLength, pool.length)) });

const DAY = 24 * 60 * 60 * 1000;

export const dateInRange = (now?: Date): fc.Arbitrary<Date> =>
  now ? fc.date({ min: new Date(now.getTime() - 30 * DAY), max: new Date(now.getTime() + 30 * DAY), noInvalidDate: true }) : fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2035-01-01T00:00:00Z'), noInvalidDate: true });

/** `tags.0` resolves through readPath but cannot be written in SQL, so user-supplied pools may not hold it. */
export function assertFieldPaths(fields: readonly string[]): void {
  for (const f of fields) if (f.split('.').some((segment) => /^\d+$/.test(segment))) throw new Error(`arbitraries: field path "${f}" has an array index`);
}
