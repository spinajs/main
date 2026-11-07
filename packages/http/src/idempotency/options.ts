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

// Visible ASCII without ',' and ';', which would start a list member or a parameter of the structured field.
const TOKEN_KEY = /^(?:(?![,;])[\x21-\x7e]){1,255}$/;

// RFC 8941 sf-string, the form draft-ietf-httpapi-idempotency-key-header defines; nothing may follow it, so no parameters.
const QUOTED_KEY = /^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/;

function givenOptions(options: unknown): IdempotentOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new InvalidArgument(`@Idempotent options must be an object, got ${JSON.stringify(options)}`);
  }
  const unknown = Object.keys(options).filter((name) => !Object.hasOwn(DEFAULT_IDEMPOTENT_OPTIONS, name));
  if (unknown.length > 0) {
    throw new InvalidArgument(`@Idempotent has no option ${unknown.join(', ')}`);
  }
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

export function resolveIdempotentOptions(options: IdempotentOptions = {}): ResolvedIdempotentOptions {
  const given = givenOptions(options);
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

/**
 * The key, or undefined when the header is missing, repeated (Node joins the copies with ', ') or malformed. A key is
 * 1 to 255 characters: a quoted string ('"k 1"', printable ASCII with `\"` and `\\` escapes) or bare visible ASCII
 * without ',' and ';'. '"k-1"' and 'k-1' are the same key.
 */
export function parseIdempotencyKey(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }
  if (!header.startsWith('"')) {
    return TOKEN_KEY.test(header) ? header : undefined;
  }
  const quoted = QUOTED_KEY.exec(header);
  const key = quoted?.[1].replace(/\\(["\\])/g, '$1');
  return key !== undefined && key.length >= 1 && key.length <= 255 ? key : undefined;
}
