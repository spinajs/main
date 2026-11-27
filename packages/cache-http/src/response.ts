import { isDeepStrictEqual } from 'node:util';
import { InvalidArgument } from '@spinajs/exceptions';
import { FIELD_NAME_PATTERN, ReplayedResponse, _setHeaders } from '@spinajs/http';
import type { CapturedJsonReply, IRouteOutcome, ResponseFunction } from '@spinajs/http';
import type { ResponseCacheScope } from './options.js';

// A cookie or an authentication answer belongs to the caller it was sent to; the rest describe one connection, one
// sending or one replay, which the replay's own send sets again.
const NEVER_REPLAYED: ReadonlySet<string> = new Set([
  'set-cookie',
  'set-cookie2',
  'authentication-info',
  'proxy-authentication-info',
  'www-authenticate',
  'proxy-authenticate',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-length',
  'date',
  'age',
  'idempotent-replayed',
]);

// a reply whose route varies it on these was made for one caller
const PER_CALLER_VARY: ReadonlySet<string> = new Set(['cookie', 'authorization']);

// what a stored reply keeps, on every scope: another route header may belong to one request (X-Request-Id) or one
// session (a CSRF token), and one principal has many sessions
const KEPT_HEADERS: ReadonlySet<string> = new Set(['content-type', 'content-language', 'content-disposition', 'etag', 'last-modified', 'location', 'link', 'cache-control', 'expires', 'vary']);

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

// what node's setHeader refuses in a value
const INVALID_VALUE = /[^\t\x20-\x7e\x80-\xff]/;

const tokensOf = (value: number | string | readonly string[] | undefined): string[] => (Array.isArray(value) ? value.join(',') : String(value ?? '')).split(',').map((token) => token.trim().toLowerCase());

// a header the Connection header names is hop-by-hop too (RFC 9110 7.6.1)
function replayedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(headers);
  const hopByHop = new Set(entries.filter(([name]) => name.toLowerCase() === 'connection').flatMap(([, value]) => tokensOf(value)));
  return Object.fromEntries(entries.filter(([name]) => !NEVER_REPLAYED.has(name.toLowerCase()) && !hopByHop.has(name.toLowerCase())));
}

function headersOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    if (typeof text !== 'string' || !FIELD_NAME_PATTERN.test(name) || INVALID_VALUE.test(text)) return undefined;
    headers[name.toLowerCase()] = text;
  }
  const kept = replayedHeaders(headers);
  return JSON_TYPE.test(kept['content-type'] ?? '') ? kept : undefined;
}

function isJsonBody(body: unknown): body is string | null {
  if (body === null) return true;
  if (typeof body !== 'string') return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * A reply this cache may store and send again: status 200, a JSON content type, a body that parses, headers a response
 * can carry, without the headers no other request may get. undefined for any other value, also one read from a store.
 */
export function replayableReply(value: unknown): CapturedJsonReply | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value) || value.status !== 200) return undefined;
  const headers = 'headers' in value ? headersOf(value.headers) : undefined;
  const body = 'body' in value ? value.body : undefined;
  return headers !== undefined && isJsonBody(body) ? { status: 200, headers, body } : undefined;
}

/** The response headers `replyToStore` reads; an express response is one. */
export interface StoredResponseHeaders {
  getHeader(name: string): number | string | readonly string[] | undefined;
}

/**
 * What the response cache stores of a finished route: the JSON reply when the route answered no error, the response set
 * no cookie, did not vary on `*` (nor, on a tenant or shared route, on `Cookie` or `Authorization` in the route's own
 * `Vary`) and said neither
 * `no-store`, `no-cache` nor, on a tenant or shared route, `private`; undefined when nothing is stored. The stored reply
 * keeps only the headers that describe its body.
 */
export function replyToStore(outcome: IRouteOutcome, res: StoredResponseHeaders, scope: ResponseCacheScope): CapturedJsonReply | undefined {
  if (outcome.error !== undefined || res.getHeader('set-cookie') !== undefined || tokensOf(res.getHeader('vary')).includes('*')) return undefined;
  const directives = tokensOf(res.getHeader('cache-control')).map((directive) => directive.split('=')[0]);
  // no-cache: a stored reply may not be used without asking the origin, and a hit never asks
  if (directives.includes('no-store') || directives.includes('no-cache') || (directives.includes('private') && scope !== 'principal')) return undefined;
  const reply = replayableReply(outcome.reply);
  if (reply === undefined) return undefined;
  // the route's own Vary only: a server middleware's (intl-http's Cookie, CORS's Origin) names what it keys or sets again on a hit
  if (scope !== 'principal' && tokensOf(reply.headers.vary).some((name) => PER_CALLER_VARY.has(name))) return undefined;
  return { ...reply, headers: Object.fromEntries(Object.entries(reply.headers).filter(([name]) => KEPT_HEADERS.has(name))) };
}

/**
 * A stored reply sent again. A ReplayedResponse, so a hook that changes data and already shaped the stored body skips
 * it as it skips an idempotent replay; unlike one, it says nothing about a replay in its headers.
 */
export class CachedResponse extends ReplayedResponse {
  private readonly reply: CapturedJsonReply;

  // compared with data after the hooks: a hook may change the parsed body in place
  private readonly original: unknown;

  /** Throws InvalidArgument for a reply `replayableReply` refuses: a hit runs that check first and misses instead. */
  constructor(reply: CapturedJsonReply) {
    const sent = replayableReply(reply);
    if (sent === undefined) throw new InvalidArgument('a cached response needs a reply replayableReply accepts');
    super(sent);
    this.reply = sent;
    this.original = sent.body === null ? null : (JSON.parse(sent.body) as unknown);
  }

  public override async execute(): Promise<ResponseFunction> {
    const data = await this.prepareResponse();
    const changed = !isDeepStrictEqual(data, this.original);
    // the stored ETag names the stored body; a hook's own ETag stays
    const storedEtag = this.reply.headers.etag;
    const headers = changed ? this.headers.filter((h) => h.Name.toLowerCase() !== 'etag' || h.Value !== storedEtag) : this.headers;
    return (_req, res) => {
      res.status(this.statusCode);
      _setHeaders(res, { Headers: [...headers] });
      if (changed) {
        res.json(data);
        return;
      }
      if (this.reply.body === null) {
        res.json();
      } else {
        res.send(this.reply.body);
      }
    };
  }
}
