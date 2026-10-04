import type { Decision } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

// Internal to the guard: the barrel does not export this module.

export const SIGNING_METHODS: ReadonlySet<string> = new Set(['signedUrl', 'getSignedUrl']);

/** The until the caller asks for: `signedUrl(path, { until })`, `getSignedUrl(path, until)`. */
export function askedUntil(method: string, args: readonly unknown[]): DateTime | undefined {
  const opts = args[1];
  const asked: unknown = method === 'getSignedUrl' ? opts : opts !== null && typeof opts === 'object' ? (opts as { until?: unknown }).until : undefined;
  if (asked === undefined || asked === null) return undefined;
  // An until that cannot be compared would drop out of the minimum and widen the URL's lifetime.
  if (!DateTime.isDateTime(asked) || !asked.isValid) throw new InvalidArgument(`${method}: until must be a valid luxon DateTime`, 'until');
  return asked;
}

export interface SigningTerms {
  readonly asked?: DateTime;
  readonly maxTtlSeconds?: number;
  readonly now?: Date;
  readonly decisions: readonly Decision[];
}

/** min(asked, now + maxTtlSeconds, decision.validUntil); absent terms are ignored, undefined when none is present. */
export function signingUntil({ asked, maxTtlSeconds, now, decisions }: SigningTerms): DateTime | undefined {
  const terms: number[] = [];
  if (asked) terms.push(asked.toMillis());
  if (maxTtlSeconds !== undefined && now) terms.push(now.getTime() + maxTtlSeconds * 1000);
  for (const d of decisions) {
    const until = d.validUntil instanceof Date ? d.validUntil.getTime() : NaN;
    if (Number.isFinite(until)) terms.push(until);
  }
  if (terms.length === 0) return undefined;
  const min = Math.min(...terms);
  return asked && asked.toMillis() === min ? asked : DateTime.fromMillis(min);
}

/**
 * The raw call that signs with `until`: `signedUrl(path, { ...opts, until })`; `getSignedUrl` goes through the raw
 * `signedUrl` when the provider has one (fsS3 does the same), else gets `until` as its second argument.
 */
export function signingCall(raw: object, method: string, fn: (...args: unknown[]) => unknown, args: readonly unknown[], until: DateTime | undefined): { fn: (...args: unknown[]) => unknown; args: unknown[] } {
  const signedUrl: unknown = Reflect.get(raw, 'signedUrl', raw);
  if (method === 'getSignedUrl') {
    if (typeof signedUrl === 'function') return { fn: signedUrl as (...args: unknown[]) => unknown, args: [args[0], until ? { until } : {}] };
    return { fn, args: until ? [args[0], until, ...args.slice(2)] : [...args] };
  }
  if (!until) return { fn, args: [...args] };
  const opts = args[1] !== null && typeof args[1] === 'object' ? args[1] : {};
  return { fn, args: [args[0], { ...opts, until }, ...args.slice(2)] };
}
