import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { Config } from '@spinajs/configuration';
import { Autoinject, Container, Injectable, NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Logger } from '@spinajs/log';
import type { Log } from '@spinajs/log';
import { CacheScope, CacheService, cache, cacheSettings } from '@spinajs/cache';
import type { Cache, CacheLookup, CacheOptions } from '@spinajs/cache';
import { BaseController, CacheControl, DataTransformer, IdempotencyScopePart, ParameterType, RouteClientGone, RouteMiddleware, RouteType, sendReply } from '@spinajs/http';
import type { CapturedJsonReply, IActionLocalStoregeContext, IController, IRoute, IRouteInvocation, IRouteOutcome, IRouteParameter } from '@spinajs/http';
import { ResponseCacheKeyPart, principalIn, responseCacheKey, responseCacheNamespace } from './key.js';
import { resolveResponseCacheOptions } from './options.js';
import type { ResolvedResponseCacheOptions } from './options.js';
import { CachedResponse, replayableReply, replyToStore } from './response.js';
import { RESPONSE_CACHE_DEFAULT_TIMEOUT_MS, RESPONSE_CACHE_DEFAULT_WAIT_TIMEOUT_MS } from './schema.js';
import { ResponseCacheWaits } from './waits.js';

type HttpRequest = IRouteInvocation['req'];
type HttpResponse = IRouteInvocation['res'];

// onFinish too: like onAfter it runs only for a middleware the chain entered, so a hit skips it
const HOOKS = ['onBefore', 'onAfter', 'onFinish', 'onAround'] as const;

// Route arguments whose value the key holds: the URL as sent, Accept, the container. Every other one, an application's
// own resolver included, is refused on a wider scope: the key cannot tell whether it differs per caller.
const KEYED_ARGUMENTS: ReadonlySet<string> = new Set([ParameterType.FromQuery, ParameterType.QueryField, ParameterType.FromParams, ParameterType.ParamField, ParameterType.FromDi, ParameterType.RequestType]);
const HEADER_ARGUMENTS: ReadonlyMap<string, readonly string[]> = new Map([
  [ParameterType.FromCookie, ['cookie']],
  [ParameterType.UserAgent, ['user-agent']],
  [ParameterType.Referer, ['referer', 'referrer']],
]);
const REQUEST_OBJECTS: ReadonlySet<string> = new Set([ParameterType.Req, ParameterType.Res]);
const REQ: string = ParameterType.Req;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const BODY_ARGUMENTS: ReadonlySet<string> = new Set([
  ParameterType.FromBody,
  ParameterType.BodyField,
  ParameterType.FromForm,
  ParameterType.FormField,
  ParameterType.FromFile,
  ParameterType.FromCSV,
  ParameterType.FromJSONFile,
  ParameterType.FromXml,
  ParameterType.RawBody,
  ParameterType.FromModel,
  'ContentDigestArg',
  'RequestStreamArg',
]);
const DECLARE = 'or take what it reads as @Query, @Param or @Header arguments';
const FROM_HEADER: string = ParameterType.FromHeader;

/**
 * The request headers an argument reads, undefined for one that reads no header; [] for `@Header()` without a key, whose
 * header is its argument's name, which http fills in only after the routes are registered.
 */
function headersOf({ Type, Options }: IRouteParameter): readonly string[] | undefined {
  if (Type !== FROM_HEADER) return HEADER_ARGUMENTS.get(Type);
  const options: unknown = Options;
  return typeof options === 'object' && options !== null && 'key' in options && typeof options.key === 'string' && options.key !== '' ? [options.key.toLowerCase()] : [];
}

const nameOf = ({ Name, Index }: IRouteParameter): string => (Name === '' ? `#${Index + 1}` : Name);

/** `static PerPrincipalReply = true`: the convention of a middleware whose reply depends on who asks (AuthzFieldsMiddleware). */
const repliesPerPrincipal = (type: object): boolean => 'PerPrincipalReply' in type && type.PerPrincipalReply === true;

/** Why responseCacheKey gave a per-principal request no key; each reason asks for another fix. */
function withoutPrincipal(storage: IActionLocalStoregeContext): string {
  if (!('Principal' in storage) || storage.Principal == null) {
    return "a request without req.storage.Principal runs uncached: @spinajs/authz-http resolves it, req.storage.AuthnPrincipal of @spinajs/authn-http alone is not read; declare scope: 'shared' with its sharedBecause when the reply is the same for everyone";
  }
  if (principalIn(storage) === undefined) {
    return 'a request whose req.storage.Principal is not a principal the key can read (an id that is not a string, an authenticated that is not a boolean, a malformed ceiling or sign-in) runs uncached';
  }
  return "a request with an unauthenticated principal (the anonymous principal every caller without credentials gets) runs uncached; a page for visitors is cached with scope: 'shared'";
}

/** A route the client left, or one a deadline answered in its place, leaves no reply to store. */
async function runRoute(proceed: () => Promise<IRouteOutcome>): Promise<IRouteOutcome | undefined> {
  try {
    return await proceed();
  } catch (err) {
    if (err instanceof RouteClientGone) return undefined;
    throw err;
  }
}

/**
 * Stores the JSON reply of a GET route and answers a later request with the same key from the store, without the action
 * and the route middlewares mounted after this one. Mounted by `@ResponseCache`. Inner stage, so the policy gate runs on
 * every request, a hit included.
 */
@Injectable()
@NewInstance()
export class ResponseCacheMiddleware extends RouteMiddleware {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(AsyncLocalStorage)
  protected Storage!: AsyncLocalStorage<IActionLocalStoregeContext>;

  @Autoinject(Array.ofType(IdempotencyScopePart))
  protected ScopeParts!: IdempotencyScopePart[];

  @Autoinject(Array.ofType(ResponseCacheKeyPart))
  protected KeyParts!: ResponseCacheKeyPart[];

  @Logger('cache')
  protected Log!: Log;

  @Config('cache.http.timeout', { defaultValue: RESPONSE_CACHE_DEFAULT_TIMEOUT_MS })
  protected Timeout!: number;

  // apart from Timeout: a store answers in milliseconds, a route in seconds
  @Config('cache.http.waitTimeout', { defaultValue: RESPONSE_CACHE_DEFAULT_WAIT_TIMEOUT_MS })
  protected WaitTimeout!: number;

  @Autoinject(ResponseCacheWaits)
  protected Waits!: ResponseCacheWaits;

  /** `http:<ROUTE TYPE> <mounted path>` */
  protected namespace = '';

  protected replies!: Cache;

  // a request of another method (HEAD on a GET route) is answered from the store, never stored: the method is not in the key
  private routeMethod = '';

  // one warning per reason and route
  private readonly warned = new Set<string>();

  // when a cache call of this route (lookup, store) last logged a failure
  private readonly failedAt = new Map<string, number>();

  // settled by the first request: the route's middleware instances exist only after every onRegister ran
  private servable?: boolean;

  // keys of this route that one request of this process is refreshing; never a reply, which comes from each request's lookup
  private readonly refreshing = new Set<string>();

  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(protected readonly options: ResolvedResponseCacheOptions) {
    super();
  }

  public async onRegister(route: IRoute, path: string, controller: IController): Promise<void> {
    if (!this.resolvedByDecorator()) {
      throw new InvalidArgument(`${String(route.Type).toUpperCase()} ${path}: ResponseCacheMiddleware is mounted by @ResponseCache(), not by @Middleware(); options it cannot prove valid are refused, never read as shared`);
    }
    if (route.Type !== RouteType.GET && route.Type !== RouteType.HEAD) {
      throw new InvalidArgument(`@ResponseCache caches GET and HEAD routes, not a ${String(route.Type).toUpperCase()} route`);
    }
    const own = route.Middlewares.findIndex((m) => m.Type === ResponseCacheMiddleware);
    if (route.Middlewares.some((m, i) => m.Type === CacheControl && i > own)) {
      throw new InvalidArgument('@Middleware(CacheControl, ...) is mounted after @ResponseCache, so a stored reply would go out without its Cache-Control: write it below @ResponseCache, or on the controller');
    }
    const shaper = this.options.scope === 'principal' ? undefined : [...controller.Descriptor.Middlewares, ...route.Middlewares].find((m) => repliesPerPrincipal(m.Type));
    if (shaper !== undefined) {
      throw new InvalidArgument(`@ResponseCache scope '${this.options.scope}' would give one caller's reply to others, but ${shaper.Type.name} shapes the reply per principal: cache this route per principal or not at all`);
    }
    // without a tenant part the tenant key is the shared one
    if (this.options.scope === 'tenant' && this.ScopeParts.length === 0 && !this.Container.hasRegistered(CacheScope)) {
      throw new InvalidArgument(`${String(route.Type).toUpperCase()} ${path}: @ResponseCache scope 'tenant' needs a tenant in the key: install @spinajs/tenancy-http, or register an IdempotencyScopePart or a CacheScope`);
    }
    this.refuseUnkeyedArguments(route, `${String(route.Type).toUpperCase()} ${path}`, controller);
    const service = await this.Container.resolve(CacheService);
    cacheSettings(service.config, this.options.cache);
    this.routeMethod = String(route.Type).toUpperCase();
    this.namespace = responseCacheNamespace(String(route.Type), path);
    this.replies = cache(this.options.cache, this.Container);
  }

  public async onAround(invocation: IRouteInvocation, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    const { req, res, storage } = invocation;
    const key = this.servesFromStore(invocation) ? this.keyOf(req, storage) : undefined;
    if (key === undefined) {
      await runRoute(proceed);
      return;
    }
    const found = await this.find(key, storage);
    // a corrupt entry, or one another version or application wrote, is a miss, never a 500
    const stored = found?.hit === true ? replayableReply(found.value) : undefined;
    // a stale hit is served while another request of this process refreshes the key: the store still holds it valid here
    if (found?.hit === true && stored !== undefined && (!found.stale || this.refreshing.has(key))) {
      await sendReply(req, res, new CachedResponse(stored));
      return;
    }
    // only the first stale hit refreshes; a hit whose value cannot be sent runs as a miss (a fresh one has no fill)
    await (found?.hit === true && found.stale && !this.refreshing.has(key) ? this.refresh(key, found, res, storage, proceed) : this.runOnce(key, found, res, storage, proceed));
  }

  /**
   * A lookup; a miss waits for a run of the key going on in this process, at most cache.http.waitTimeout, then looks
   * again in its own scope.
   */
  protected async find(key: string, storage: IActionLocalStoregeContext): Promise<CacheLookup<CapturedJsonReply> | undefined> {
    const found = await this.lookup(key, storage);
    // a lookup the store did not answer is read as a miss: waiting and looking again would cost a second timeout
    const running = found?.hit === false ? this.inFlight.get(key) : undefined;
    if (running === undefined) return found;
    // ended by the container's dispose too: the waiter then looks again and runs the route like one that gave up
    if ((await this.Waits.until(running, this.WaitTimeout)) === 'late') {
      this.failed('the run of the key by another request', `took longer than ${this.WaitTimeout} ms (cache.http.waitTimeout), so the request runs the route itself; further ones in the next minute are not logged`);
    }
    return this.lookup(key, storage);
  }

  /** False, once and for good, when a stored reply of this route would skip a middleware that shapes it (R12). */
  protected servesFromStore({ route, controller }: IRouteInvocation): boolean {
    if (this.servable === undefined) {
      const mounted = controller instanceof BaseController ? controller.MountedMiddlewares(route.Method) : [];
      const refusal = this.refusalToServe(mounted);
      this.servable = refusal === undefined;
      if (refusal !== undefined) {
        this.Log.error({ route: this.namespace, refusal }, 'Response cache of ${route} never answers from the store: ${refusal}');
      }
    }
    return this.servable;
  }

  /** undefined: the request runs uncached. A key part that throws is a cache failure (R8), never a failed request. */
  protected keyOf(req: HttpRequest, storage: IActionLocalStoregeContext): string | undefined {
    try {
      // on every scope: a stored reply is replayed without its transformer, so it would keep the view of its first caller
      // (tenant, shared) or of its caller's decision at store time (principal)
      if (this.transformedPerPrincipal(req)) {
        return this.uncached('a request whose x-data-transform shapes the reply per principal runs uncached, because a stored reply is replayed without the transformer');
      }
      const key = responseCacheKey({ namespace: this.namespace, scope: this.options.scope, vary: this.options.vary }, req, storage, this.ScopeParts, this.KeyParts);
      return key ?? this.uncached(withoutPrincipal(storage));
    } catch (error) {
      this.Log.warn({ error, route: this.namespace }, 'Response cache of ${route}: the key could not be computed, the request runs uncached');
      return undefined;
    }
  }

  protected cacheOptions(): CacheOptions {
    return { ttl: this.options.ttl, swr: this.options.swr, tags: this.options.tags, layer: 'http' };
  }

  protected lookup(key: string, storage: IActionLocalStoregeContext): Promise<CacheLookup<CapturedJsonReply> | undefined> {
    return this.inStore(storage, 'lookup', () => this.replies.lookup<CapturedJsonReply>(key, this.cacheOptions()));
  }

  protected async runAndStore(found: CacheLookup<CapturedJsonReply> | undefined, res: HttpResponse, storage: IActionLocalStoregeContext, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    const outcome = await runRoute(proceed);
    const reply = outcome === undefined ? undefined : this.storableReply(outcome, res);
    if (outcome !== undefined && reply === undefined && /\bno-store\b/i.test(String(res.getHeader('cache-control') ?? ''))) {
      this.uncached('a reply that says Cache-Control: no-store is not stored; @spinajs/authn-http sets it on every request it signs in, so for a signed-in caller only a route that sets its own Cache-Control is stored');
    }
    if (found !== undefined && reply !== undefined) {
      // a miss; a fresh hit runs only when its value could not be sent, and has no fill
      await this.inStore(storage, 'store', async () => found.fill?.(reply));
    }
  }

  /** The first stale hit of a key in this process runs the route again and fills through the hit (plan A, K20). */
  private async refresh(key: string, found: CacheLookup<CapturedJsonReply>, res: HttpResponse, storage: IActionLocalStoregeContext, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    this.refreshing.add(key);
    try {
      await this.runAndStore(found, res, storage, proceed);
    } finally {
      this.refreshing.delete(key);
    }
  }

  /** A miss runs the route; a miss of the same key meanwhile waits for it in find(). */
  private async runOnce(key: string, found: CacheLookup<CapturedJsonReply> | undefined, res: HttpResponse, storage: IActionLocalStoregeContext, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    const flight = this.runAndStore(found, res, storage, proceed);
    const settled = flight.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(key, settled);
    try {
      await flight;
    } finally {
      // a waiter that gave up runs its own flight, which the first one must not drop
      if (this.inFlight.get(key) === settled) this.inFlight.delete(key);
    }
  }

  /** What replyToStore keeps, for a request of the route's own method only (CH2-D16). */
  protected storableReply(outcome: IRouteOutcome, res: HttpResponse): CapturedJsonReply | undefined {
    return res.req.method === this.routeMethod ? replyToStore(outcome, res, this.options.scope) : undefined;
  }

  /**
   * onAround runs outside the action's AsyncLocalStorage context, and a CacheScope provider (the tenant) reads that
   * context. Bounded by cache.http.timeout: a store that does not answer (a Redis client queueing while it reconnects)
   * must not hold the request.
   */
  protected async inStore<T>(storage: IActionLocalStoregeContext, what: string, op: () => Promise<T>): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`the cache did not answer within ${this.Timeout} ms`)), this.Timeout);
    });
    try {
      return await Promise.race([this.Storage.run(storage, op), late]);
    } catch (error) {
      this.failed(what, 'failed and is read as a miss; further failures of it in the next minute are not logged', error);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A store that is down fails every request: one warning per call and minute, not one per request. */
  private failed(what: string, outcome: string, error?: unknown): void {
    const now = Date.now();
    const last = this.failedAt.get(what);
    if (last === undefined || now - last >= FAILURE_LOG_INTERVAL_MS) {
      this.failedAt.set(what, now);
      // what and outcome are this class's own texts, written into the template so the logger does not quote them
      this.Log.warn({ error, route: this.namespace, what }, `Response cache of \${route}: ${what} ${outcome}`);
    }
  }

  private refusalToServe(mounted: readonly RouteMiddleware[]): string | undefined {
    const own = mounted.indexOf(this);
    if (own < 0) return 'the middlewares mounted on the route cannot be read';
    // outer and beforePolicy middlewares run before this one wherever they are written
    const skipped = mounted.slice(own + 1).find((m) => !(m instanceof ResponseCacheMiddleware) && m.Stage !== 'outer' && m.Stage !== 'beforePolicy' && HOOKS.some((hook) => hook in m));
    if (skipped !== undefined) {
      return `${skipped.constructor.name} is mounted after @ResponseCache, so a stored reply would skip it: write its decorator below @ResponseCache`;
    }
    // a global route middleware is not among the descriptors onRegister checked
    const shaper = this.options.scope === 'principal' ? undefined : mounted.find((m) => repliesPerPrincipal(m.constructor));
    return shaper === undefined ? undefined : `${shaper.constructor.name} shapes the reply per principal, which scope '${this.options.scope}' would share`;
  }

  /** A request body on every scope (a GET body is in no key); on a wider scope any input of one caller the key does not hold. */
  private refuseUnkeyedArguments(route: IRoute, at: string, controller: IController): void {
    const body = [...route.Parameters.values()].find((param) => BODY_ARGUMENTS.has(param.Type));
    if (body !== undefined) {
      throw new InvalidArgument(`${at}: @ResponseCache keys no request body, but the route reads the argument ${nameOf(body)} of type '${body.Type}': a route that reads a body is not cached`);
    }
    const unkeyed = this.options.scope === 'principal' ? undefined : this.unkeyedArgument(route, controller);
    if (unkeyed !== undefined) {
      throw new InvalidArgument(`${at}: @ResponseCache scope '${this.options.scope}' would give one caller's reply to others, but the route reads ${unkeyed[0]}: cache it with scope 'principal', ${unkeyed[1]}`);
    }
  }

  /** What a route argument reads of the request that the key of a wider scope does not hold, and what to do about it. */
  private unkeyedArgument(route: IRoute, controller: IController): readonly [string, string] | undefined {
    const keyed = new Set(['accept', 'x-data-transform', ...this.options.vary.map((name) => name.toLowerCase())]);
    for (const param of route.Parameters.values()) {
      if (REQUEST_OBJECTS.has(param.Type)) return [`the ${param.Type === REQ ? 'request' : 'response'} object of the argument ${nameOf(param)}, whose reads the key cannot see`, DECLARE];
      const headers = headersOf(param);
      if (headers?.length === 0) return [`the header of the argument ${nameOf(param)}, which @Header() does not name`, "or write @Header('<name>') and name the header in vary"];
      if (headers === undefined && !KEYED_ARGUMENTS.has(param.Type)) return [`the argument ${nameOf(param)} of type '${param.Type}', which is not in the key`, 'or read the value from the URL'];
      const unkeyed = headers?.find((header) => !keyed.has(header));
      if (unkeyed !== undefined) return [`the header ${unkeyed}, which is not in the key`, 'or name the header in vary'];
    }
    // http calls the action with req, res and next after the declared arguments; a default or rest parameter does not count in length
    const action: unknown = Reflect.get(controller, route.Method);
    const declared = route.Parameters.size;
    if (typeof action === 'function' && action.length > declared) return [`the request http passes after the ${declared} declared argument${declared === 1 ? '' : 's'} (the action takes ${action.length}), whose reads the key cannot see`, DECLARE];
    return undefined;
  }

  /** http resolves the transformer of `x-data-transform` at each reply, so it is looked up here the same way. */
  private transformedPerPrincipal(req: HttpRequest): boolean {
    const asked = req.headers['x-data-transform'];
    if (typeof asked !== 'string') return false;
    const transformer = this.Container.resolve(Array.ofType(DataTransformer)).find((t) => t.Type === asked);
    return transformer !== undefined && repliesPerPrincipal(transformer.constructor);
  }

  // options that did not pass @ResponseCache are refused: a scope typo would share one caller's reply
  private resolvedByDecorator(): boolean {
    try {
      return isDeepStrictEqual(resolveResponseCacheOptions(this.options), this.options);
    } catch {
      return false;
    }
  }

  private uncached(reason: string): undefined {
    if (!this.warned.has(reason)) {
      this.warned.add(reason);
      this.Log.warn({ route: this.namespace, reason }, 'Response cache of ${route}: ${reason}');
    }
    return undefined;
  }
}
