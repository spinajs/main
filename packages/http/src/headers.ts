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

const formEncode = (s: string): string => new URLSearchParams({ v: s }).toString().slice(2);

/**
 * The `Authorization` value `Basic base64(user:password)` (RFC 7617, UTF-8). `formEncode` form-urlencodes both parts
 * first, as OAuth client authentication requires (RFC 6749 §2.3.1).
 */
export function basicAuthHeader(user: string, password: string, options: { formEncode?: boolean } = {}): string {
  const encode = options.formEncode ? formEncode : (s: string) => s;
  return `Basic ${Buffer.from(`${encode(user)}:${encode(password)}`, 'utf8').toString('base64')}`;
}
