// RFC 6750 §2.1: the scheme in any case, then a b64token.
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

/**
 * The token of an `Authorization: Bearer <token>` header, or null when the header is absent, malformed or an array.
 * A header sent twice and joined with ", " (see {@link normalizeHeaders}) never matches.
 */
export function parseBearer(header: string | readonly string[] | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  return BEARER.exec(header.trim())?.[1] ?? null;
}

/**
 * The cookies of a `Cookie` request header. A pair without `=` is skipped, as cookie-parser skips it, and so is one with
 * an empty name. The first of a repeated name wins, surrounding quotes are dropped and the value is URI-decoded (kept
 * raw when the escape is malformed).
 */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const cookies = Object.create(null) as Record<string, string>;
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || name in cookies) continue;

    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // malformed escape: keep the raw value
    }
    cookies[name] = value;
  }
  return cookies;
}

/**
 * Lower-cased request headers built from `rawHeaders`, a repeated header joined with ", ". Node's `req.headers` keeps
 * only the first of a repeated `Authorization`, which would hide a second credential.
 */
export function normalizeHeaders(req: { readonly rawHeaders?: readonly string[] }): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);
  const raw = req.rawHeaders ?? [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    headers[name] = name in headers ? `${headers[name]}, ${raw[i + 1]}` : raw[i + 1];
  }
  return headers;
}

export interface StrictHeaderOptions {
  /** The longest value accepted. Node decodes header bytes as latin1, so this counts bytes too. */
  readonly maxLength: number;
  /** Matched against the whole value. It must start with `^`, end with `$` and have no `g`, `y` or `m` flag. */
  readonly pattern?: RegExp;
}

/** The request parts {@link strictHeader} reads: an express request, a Node `IncomingMessage` or a socket handshake. */
export interface HeaderSource {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawHeaders?: readonly string[];
}

/** RFC 9110 token, which is also a field name. */
export const FIELD_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function endsWithAnchor(source: string): boolean {
  if (!source.endsWith('$')) return false;
  let backslashes = 0;
  for (let i = source.length - 2; i >= 0 && source[i] === '\\'; i--) backslashes++;
  // an odd run escapes the $
  return backslashes % 2 === 0;
}

function assertAnchored(pattern: RegExp): void {
  const { source, flags } = pattern;
  // `m` makes ^ and $ match at line breaks; `g` and `y` make exec() start where the previous call left lastIndex.
  if (!source.startsWith('^') || !endsWithAnchor(source) || /[gym]/.test(flags)) {
    throw new TypeError(`strictHeader pattern ${String(pattern)} must be anchored with ^ and $ and have no g, y or m flag`);
  }
}

function sentTimes(rawHeaders: readonly string[], name: string): number {
  let times = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].length === name.length && rawHeaders[i].toLowerCase() === name) times++;
  }
  return times;
}

/**
 * Request header `name` when the client sent it exactly once, at most `maxLength` long and, with `pattern`, matching it
 * in full; otherwise undefined. Node joins most repeated headers with ", " and keeps only the first of others, so a
 * repeat is found in `rawHeaders`; a value the app itself put in `headers` is read as it is.
 *
 * `pattern` runs on client input: keep it free of nested or overlapping quantifiers (`(a+)+`, `(a|ab)*`, `\s*\s*`).
 * `maxLength` bounds the input, not the time of a pattern that backtracks.
 */
export function strictHeader(req: HeaderSource, name: string, options: StrictHeaderOptions): string | undefined {
  assertStrictOptions(options);
  return readStrictHeader(req, name, options);
}

function assertStrictOptions({ maxLength, pattern }: StrictHeaderOptions): void {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
    throw new TypeError(`strictHeader maxLength must be a non-negative integer, got ${String(maxLength)}`);
  }
  if (pattern !== undefined) assertAnchored(pattern);
}

/** {@link strictHeader} with the options checked once, for a header read on every request. */
export function strictHeaderReader(name: string, options: StrictHeaderOptions): (req: HeaderSource) => string | undefined {
  assertStrictOptions(options);
  return (req) => readStrictHeader(req, name, options);
}

function readStrictHeader(req: HeaderSource, name: string, { maxLength, pattern }: StrictHeaderOptions): string | undefined {
  const key = name.toLowerCase();
  const value = req.headers[key];
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  if (req.rawHeaders !== undefined && sentTimes(req.rawHeaders, key) > 1) return undefined;
  if (pattern === undefined) return value;

  // A top-level alternation (`^a|b$`) anchors each side once only, so the match must also span the whole value.
  const match = pattern.exec(value);
  return match !== null && match.index === 0 && match[0].length === value.length ? value : undefined;
}

const formEncode = (s: string): string => new URLSearchParams({ v: s }).toString().slice(2);

/**
 * The `Authorization` value `Basic base64(user:password)` (RFC 7617, UTF-8). `formEncode` form-urlencodes both parts
 * first, as OAuth client authentication requires (RFC 6749 §2.3.1).
 */
export function basicAuthHeader(user: string, password: string, options: { formEncode?: boolean } = {}): string {
  const encode = options.formEncode ? formEncode : (s: string) => s;
  return `Basic ${Buffer.from(`${encode(user)}:${encode(password)}`, 'utf8').toString('base64')}`;
}
