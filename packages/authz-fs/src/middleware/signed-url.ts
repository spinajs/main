import type { Decision } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';
import { DateTime } from 'luxon';
import type { Zone } from 'luxon';

/** The lifetime of a URL nobody asked an until for: the S3 signer's own default (D9 rev.). */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;

/** An asked until, read once: the middleware signs this value, never the caller's object. */
export interface AskedUntil {
  readonly millis: number;
  readonly zone?: Zone;
}

/** The `until` of `signedUrl(path, opts)`'s options. */
export function askedUntil(opts: unknown): AskedUntil | undefined {
  const asked: unknown = opts !== null && typeof opts === 'object' ? (opts as { until?: unknown }).until : undefined;
  if (asked === undefined || asked === null) return undefined;
  const refused = () => new InvalidArgument('signedUrl: until must be a valid luxon DateTime', 'until');
  // An until that cannot be compared would drop out of the minimum and widen the URL's lifetime.
  if (!DateTime.isDateTime(asked) || !asked.isValid) throw refused();
  const millis = asked.toMillis();
  if (!Number.isFinite(millis)) throw refused();
  return { millis, zone: asked.zone };
}

export interface SigningTerms {
  readonly asked?: AskedUntil;
  readonly defaultTtlSeconds?: number;
  readonly maxTtlSeconds?: number;
  readonly now: Date;
  readonly decisions: readonly Decision[];
}

/** min(asked, else now + defaultTtlSeconds; now + maxTtlSeconds; decision.validUntil), in the asked zone. */
export function signingUntil({ asked, defaultTtlSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS, maxTtlSeconds, now, decisions }: SigningTerms): DateTime {
  const terms: number[] = [asked ? asked.millis : now.getTime() + defaultTtlSeconds * 1000];
  if (maxTtlSeconds !== undefined) terms.push(now.getTime() + maxTtlSeconds * 1000);
  for (const d of decisions) {
    const until = d.validUntil instanceof Date ? d.validUntil.getTime() : NaN;
    if (Number.isFinite(until)) terms.push(until);
  }
  return DateTime.fromMillis(Math.min(...terms), asked?.zone ? { zone: asked.zone } : {});
}
