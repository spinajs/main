import type { ClientOptions } from './http.js';
import { checkHeader } from './wire.js';

/** The incoming request's headers: a `Headers` (Next.js `await headers()`), a record such as Node's `req.headers`, or anything with `get(name)`. */
export type IncomingHeaders = Headers | Record<string, string | string[] | undefined> | { get(name: string): string | null };

export const DEFAULT_FORWARDED_HEADERS: readonly string[] = ['cookie', 'authorization'];

// Hop-by-hop headers (RFC 9110 7.6.1), headers that describe the incoming message itself, and the proxy headers an
// API may base trust decisions on: forwarding them would hand the browser's host and client address to the API.
const NEVER_FORWARDED = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'content-length', 'set-cookie', 'forwarded', 'x-real-ip']);

const isNeverForwarded = (name: string) => NEVER_FORWARDED.has(name) || name.startsWith('x-forwarded-');

type Lookup = (name: string) => string | undefined;

function lookup(incoming: IncomingHeaders): Lookup {
  if (typeof incoming.get === 'function') {
    const source = incoming as { get(name: string): string | null };
    return (name) => source.get(name) ?? undefined;
  }
  const record = incoming as Record<string, string | string[] | undefined>;
  return (name) => {
    const key = Object.keys(record).find((k) => k.toLowerCase() === name);
    const value = key === undefined ? undefined : record[key];
    if (!Array.isArray(value)) return value;
    return value.length > 0 ? value.join(name === 'cookie' ? '; ' : ', ') : undefined;
  };
}

/** Copies the listed headers from an incoming request, for a server-side client that calls the API on that request's behalf. */
export function forwardedHeaders(incoming: IncomingHeaders | undefined, names: readonly string[]): Record<string, string> {
  if (!incoming) return {};
  const read = lookup(incoming);
  // A header the request's own `Connection` names is hop-by-hop too.
  const nominated = new Set((read('connection') ?? '').split(',').map((n) => n.trim().toLowerCase()));
  const forwarded: Record<string, string> = {};
  for (const name of names.map((n) => n.toLowerCase())) {
    if (isNeverForwarded(name) || nominated.has(name)) continue;
    const value = read(name);
    if (value === undefined) continue;
    checkHeader(name, value);
    forwarded[name] = value;
  }
  return forwarded;
}

export interface ServerClientOptions extends Omit<ClientOptions, 'headers' | 'credentials'> {
  /** Absolute URL of the API; a relative URL has no origin on the server. */
  baseUrl: string;
  incoming?: IncomingHeaders;
  /** Header names forwarded from `incoming`, replacing the default `['cookie', 'authorization']`. */
  forward?: readonly string[];
  /** Extra headers, added after the forwarded ones. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
}

/** Client options for a per-request client on the server. The incoming headers are read once, when it is created. */
export function serverClientOptions(options: ServerClientOptions): ClientOptions {
  const { incoming, forward = DEFAULT_FORWARDED_HEADERS, headers, ...client } = options;
  if (!URL.canParse(client.baseUrl)) throw new TypeError(`createServerAppClient: baseUrl must be an absolute URL, got '${client.baseUrl}'`);
  const forwarded = forwardedHeaders(incoming, forward);
  return { ...client, headers: async () => ({ ...forwarded, ...(typeof headers === 'function' ? await headers() : headers) }) };
}
