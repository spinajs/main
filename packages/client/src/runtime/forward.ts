import type { ClientOptions } from './http.js';
import { checkHeader } from './wire.js';

/** The incoming request's headers: a `Headers` (Next.js `await headers()`), a record such as Node's `req.headers`, or anything with `get(name)`. */
export type IncomingHeaders = Headers | Record<string, string | string[] | undefined> | { get(name: string): string | null };

export const DEFAULT_FORWARDED_HEADERS: readonly string[] = Object.freeze(['cookie', 'authorization']);

// Defence in depth: `forward` is the control, and this refuses names that are wrong to forward whatever the app means.
// Hop-by-hop headers (RFC 9110 7.6.1); the incoming message's own framing, representation and conditions, which would
// break or reshape the API call; and client-address, routing and method headers an API or its proxy may trust.
const NEVER_FORWARDED = new Set([
  ...['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate'],
  ...['host', 'content-length', 'content-type', 'content-encoding', 'expect', 'range', 'accept', 'set-cookie'],
  ...['forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip', 'x-original-url', 'x-rewrite-url', 'x-http-method-override', 'x-http-method', 'x-method-override'],
]);

const NEVER_FORWARDED_PREFIXES = ['x-forwarded-', 'if-'];

const isNeverForwarded = (name: string) => NEVER_FORWARDED.has(name) || NEVER_FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix));

function checkedNames(names: readonly string[]): string[] {
  return names.map((listed) => {
    checkHeader(listed, '');
    const name = listed.toLowerCase();
    if (isNeverForwarded(name)) throw new TypeError(`forwardedHeaders: '${name}' is never forwarded; remove it from forward`);
    return name;
  });
}

// Repeated fields combine with `, ` (RFC 9110 5.3), except cookies, which combine with `; ` (RFC 6265 5.4).
const scalarText = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined);

function headerText(name: string, value: unknown): string | undefined {
  if (!Array.isArray(value)) return scalarText(value);
  const parts = (value as unknown[]).map(scalarText).filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(name === 'cookie' ? '; ' : ', ') : undefined;
}

type Lookup = (name: string) => string | undefined;

function lookup(incoming: IncomingHeaders): Lookup {
  if (typeof incoming.get === 'function') {
    const source = incoming as { get(name: string): unknown };
    return (name) => headerText(name, source.get(name));
  }
  const record = incoming as Record<string, unknown>;
  return (name) => {
    const key = Object.keys(record).find((k) => k.toLowerCase() === name && record[k] !== undefined);
    return key === undefined ? undefined : headerText(name, record[key]);
  };
}

/** Copies the listed headers from an incoming request, for a server-side client that calls the API on that request's behalf. */
export function forwardedHeaders(incoming: IncomingHeaders | undefined, names: readonly string[]): Record<string, string> {
  const listed = checkedNames(names);
  if (!incoming) return {};
  const read = lookup(incoming);
  // A header the request's own `Connection` names is hop-by-hop too.
  const nominated = new Set((read('connection') ?? '').split(',').map((n) => n.trim().toLowerCase()));
  const forwarded: Record<string, string> = {};
  for (const name of listed) {
    const value = nominated.has(name) ? undefined : read(name);
    if (value === undefined) continue;
    checkHeader(name, value);
    forwarded[name] = value;
  }
  return forwarded;
}

export interface ServerClientOptions extends Omit<ClientOptions, 'headers' | 'credentials'> {
  /** Absolute `http:` or `https:` URL of the API; a relative URL has no origin on the server. */
  baseUrl: string;
  incoming?: IncomingHeaders;
  /** Header names forwarded from `incoming`, replacing the default `['cookie', 'authorization']`. */
  forward?: readonly string[];
  /** Extra headers, added after the forwarded ones. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Passed to every fetch; `'error'` keeps the forwarded credentials from following a redirect. Fetch's default follows. */
  redirect?: RequestRedirect;
}

function checkBaseUrl(baseUrl: string): void {
  let url: URL | undefined;
  try {
    url = new URL(baseUrl);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw new TypeError(`createServerAppClient: baseUrl must be an absolute http: or https: URL without credentials, got '${baseUrl}'`);
  }
}

function withRedirect(fetch: ClientOptions['fetch'], redirect: RequestRedirect): typeof globalThis.fetch {
  return (input, init) => (fetch ?? globalThis.fetch)(input, { ...init, redirect });
}

export type ServerClientResult<O extends ServerClientOptions> = Omit<O, 'incoming' | 'forward' | 'headers' | 'redirect'> & Pick<ClientOptions, 'headers' | 'fetch'>;

/** Client options for a per-request client on the server. The incoming headers are read once, when it is created. */
export function serverClientOptions<O extends ServerClientOptions>(options: O): ServerClientResult<O> {
  const { incoming, forward = DEFAULT_FORWARDED_HEADERS, headers, redirect, ...client } = options;
  checkBaseUrl(client.baseUrl);
  const forwarded = forwardedHeaders(incoming, forward);
  const extra = async () => (typeof headers === 'function' ? await headers() : headers);
  return { ...client, ...(redirect === undefined ? {} : { fetch: withRedirect(client.fetch, redirect) }), headers: async () => ({ ...forwarded, ...(await extra()) }) };
}
