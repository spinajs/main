import type { ControllerEntry, MiddlewareRef, RouteEntry } from '@spinajs/manifest';
import type { OpenAPIV3_1 } from 'openapi-types';
import { REPLAYED_HEADER, REPLAYED_HEADER_NAME } from './idempotency.js';

type Header = OpenAPIV3_1.HeaderObject;

// The two names, the methods CacheControl mounts on, its directive order and the Vary merge repeat CacheControl, NoStore
// and mergeVary of @spinajs/http, which is only a devDependency here; test/cache-headers.test.ts compares the values.
const CACHE_CONTROL = 'CacheControl';
const NO_STORE = 'NoStore';
// also the methods on which Express and send answer a matching If-None-Match with 304 (a file route is a GET)
const CACHE_CONTROL_METHODS: ReadonlySet<RouteEntry['method']> = new Set(['get', 'head', 'file']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

const header = (description: string, example?: string): Header => ({ description, schema: { type: 'string' }, ...(example === undefined ? {} : { example }) });

interface Declaration {
  /** `Cache-Control` as `CacheControl` writes it on a reply nothing makes private. */
  value: string;
  vary: string[];
}

function scopeOf(options: Record<string, unknown>): string[] {
  if (options.public === true) return ['public'];
  return options.private === true ? ['private'] : [];
}

/** Undefined when an argument is not a literal the build could record. */
function declarationOf(ref: MiddlewareRef): Declaration | undefined {
  if (ref.options === undefined) return undefined;
  const [maxAge = 0, options = {}] = ref.options;
  if (!isSeconds(maxAge) || !isRecord(options)) return undefined;
  const parts = [...scopeOf(options), `max-age=${maxAge}`];
  if (isSeconds(options.staleWhileRevalidate)) parts.push(`stale-while-revalidate=${options.staleWhileRevalidate}`);
  if (options.immutable === true) parts.push('immutable');
  const vary = Array.isArray(options.vary) ? options.vary.filter((f): f is string => typeof f === 'string') : [];
  return { value: parts.join(', '), vary };
}

function mergeVary(fields: readonly string[]): string[] {
  const out: string[] = [];
  for (const field of fields) {
    if (field === '*') return ['*'];
    if (!out.some((f) => f.toLowerCase() === field.toLowerCase())) out.push(field);
  }
  return out;
}

/**
 * In the order their `onAfter` hooks run: the route's before the controller's, the upper decorator first. The first
 * one sets `Cache-Control`, every one adds its `vary`.
 */
function cacheControlsOf(route: RouteEntry, controller: ControllerEntry): MiddlewareRef[] {
  if (!CACHE_CONTROL_METHODS.has(route.method)) return [];
  return [...route.middlewares, ...controller.middlewares].filter((m) => m.type === CACHE_CONTROL);
}

function cachingHeadersOf(route: RouteEntry, controller: ControllerEntry): Record<string, Header> | undefined {
  const noStore = [...route.middlewares, ...controller.middlewares].some((m) => m.type === NO_STORE);
  const refs = cacheControlsOf(route, controller);
  if (!noStore && refs.length === 0) return undefined;
  const declarations = refs.map(declarationOf);
  const out: Record<string, Header> = noStore
    ? { 'Cache-Control': header('No cache may keep the reply.', 'no-store'), Pragma: header('For HTTP/1.0 caches.', 'no-cache') }
    : {
        'Cache-Control': header(
          'How long caches may keep the reply. A reply to a request with Authorization, or one that sets a cookie, is private; a Cache-Control set before the route answered (an authenticated reply marked no-store) is kept.',
          declarations[0]?.value,
        ),
      };
  const vary = mergeVary(declarations.flatMap((d) => d?.vary ?? []));
  if (vary.length > 0) out.Vary = header('Request headers the reply depends on; CORS and other middlewares may add more.', vary.join(', '));
  return out;
}

const ETAG = header('Validator of the reply: send it back in If-None-Match to get 304 while it is current.');

/**
 * The headers of a route that carries `CacheControl` or `NoStore`, on its 2xx responses, and the `ETag` Express puts
 * on every reply with a body unless the app runs with `http.etag: false`; with it, the 304 of a GET or HEAD route. Adds
 * to the headers a response already documents, so it runs after the steps that document theirs.
 */
export function applyCacheHeaders(responses: OpenAPIV3_1.ResponsesObject, route: RouteEntry, controller: ControllerEntry, etag: boolean): void {
  const headers = cachingHeadersOf(route, controller);
  if (!headers) return;
  let tagged = false;
  for (const [status, response] of Object.entries(responses)) {
    if (!status.startsWith('2') || '$ref' in response) continue;
    const withBody = etag && status !== '204';
    response.headers = { ...response.headers, ...headers, ...(withBody ? { ETag: ETAG } : {}) };
    tagged ||= withBody;
  }
  if (!tagged || !CACHE_CONTROL_METHODS.has(route.method)) return;
  // a replay of a repeated Idempotency-Key is answered 304 by the same check
  const replayed: Record<string, Header> = route.idempotency ? { [REPLAYED_HEADER_NAME]: REPLAYED_HEADER } : {};
  responses['304'] = { description: 'Not modified: If-None-Match names the current ETag. No body.', headers: { ...replayed, ...headers, ETag: ETAG } };
}
