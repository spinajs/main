import { InvalidArgument } from '@spinajs/exceptions';

export interface IdempotentOptions {
  /** false: a request without the header runs as usual. */
  required?: boolean;
  /** How long a reply replays, a duration such as '24h'. */
  ttl?: string;
  /** 'body': a repeat must send the same body, or it is refused with 422. */
  fingerprint?: 'body' | 'none';
  /** A larger reply is not stored, and its key is released. */
  maxReplyBytes?: number;
}

export type ResolvedIdempotentOptions = Required<IdempotentOptions>;

export const DEFAULT_IDEMPOTENT_OPTIONS: Readonly<ResolvedIdempotentOptions> = Object.freeze({ required: false, ttl: '24h', fingerprint: 'body', maxReplyBytes: 1_048_576 });

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

const KEY = /^[\x21-\x7e]{1,255}$/;

export function resolveIdempotentOptions(options: IdempotentOptions = {}): ResolvedIdempotentOptions {
  const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as IdempotentOptions;
  const resolved: ResolvedIdempotentOptions = { ...DEFAULT_IDEMPOTENT_OPTIONS, ...given };

  if (typeof resolved.required !== 'boolean') {
    throw new InvalidArgument(`@Idempotent required must be true or false, got ${JSON.stringify(resolved.required)}`);
  }
  if (typeof resolved.ttl !== 'string' || resolved.ttl.trim() === '') {
    throw new InvalidArgument(`@Idempotent ttl must be a duration such as '24h', got ${JSON.stringify(resolved.ttl)}`);
  }
  if (resolved.fingerprint !== 'body' && resolved.fingerprint !== 'none') {
    throw new InvalidArgument(`@Idempotent fingerprint must be 'body' or 'none', got ${JSON.stringify(resolved.fingerprint)}`);
  }
  if (!(Number.isInteger(resolved.maxReplyBytes) && resolved.maxReplyBytes > 0)) {
    throw new InvalidArgument(`@Idempotent maxReplyBytes must be an integer above 0, got ${String(resolved.maxReplyBytes)}`);
  }
  return Object.freeze(resolved);
}

/** The key, or undefined when the header is missing, repeated (Node joins the copies with ', '), or not 1 to 255 visible ASCII characters. */
export function parseIdempotencyKey(header: string | string[] | undefined): string | undefined {
  return typeof header === 'string' && KEY.test(header) ? header : undefined;
}
