import type { AsyncLocalStorage } from 'node:async_hooks';
import type express from 'express';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UnexpectedServerError } from '@spinajs/exceptions';
import type { HttpMiddleware, IActionLocalStoregeContext, IMiddlewareContext, IReplyContext, IRouteInvocation, Request, Response, ResponseFunction } from './interfaces.js';
import { markStage, noteRouteError } from './errors/on-error.js';
import { excludeFromCapture, responseCaptureOf } from './response-capture.js';
import type { IRouteMatch, RouteIndex } from './route-index.js';

/** The reply an error gets, and the error that reply answers (an error handler may have replaced the original). */
export interface IErrorReply {
  readonly response: Response;
  readonly error: unknown;
}

/** Produces the error reply a throwing `onAfter` turns the reply into (D8). */
export type ErrorReplier = (error: unknown) => Promise<IErrorReply>;

/** Route hooks run before server hooks, in both lists inner (last entered) first. */
export type MiddlewareScope = 'route' | 'server';

export interface ISendReplyOptions {
  /** The error the reply answers; hooks see it as `ctx.error`. */
  readonly error?: unknown;
  /** Used for a throwing `onAfter` when no route set its own error replies. */
  readonly errorReply?: ErrorReplier;
}

interface IEntered {
  readonly scope: MiddlewareScope;
  readonly middleware: HttpMiddleware;
  readonly context: IMiddlewareContext;
}

interface IRouteScope {
  readonly context: IRouteInvocation;
  readonly storage?: AsyncLocalStorage<IActionLocalStoregeContext>;
  readonly errorReply?: ErrorReplier;
}

interface IReplyState {
  readonly entered: IEntered[];
  route?: IRouteScope;
  /** onAfter hooks not run yet; built when the first reply starts, so a later reply never re-runs one. */
  pending?: IEntered[];
  /** A throwing onAfter already turned the reply into an error reply: a further throw is only logged. */
  converted: boolean;
  watching: boolean;
  /** Set once `finish` or `close` fired. */
  aborted?: boolean;
  early?: Response;
  replyError?: { error: unknown };
  /** The error the sent reply answers, after any onAfter turned it. */
  answered?: { error: unknown };
  /** The one context every server hook of the request gets; with the route fields once a route matched. */
  server?: IMiddlewareContext;
  routedServer?: IMiddlewareContext;
  /** Where the server hooks' context looks up the route before routing. */
  routes?: RouteIndex;
}

const STATE = Symbol('replyPipeline');

const httpLog = () => DI.resolve(Log, ['http']);

const nameOf = (m: HttpMiddleware) => m.constructor.name;

const newState = (): IReplyState => ({ entered: [], converted: false, watching: false });

// A response without `locals` (a bare stub driving a hook directly) gets a state of its own.
function stateOf(res: express.Response): IReplyState {
  const locals = res.locals as Record<symbol, IReplyState | undefined> | undefined;
  return locals ? (locals[STATE] ??= newState()) : newState();
}

/** Called by the route chain's first handler: the context every route hook gets, the action's store and error replies. */
export function beginRoute(res: express.Response, scope: IRouteScope): void {
  const state = stateOf(res);
  state.route = scope;
}

export function routeContextOf(res: express.Response): IRouteInvocation | undefined {
  return (res.locals as Record<symbol, IReplyState | undefined> | undefined)?.[STATE]?.route?.context;
}

/**
 * Records that the chain entered `middleware`: only entered middlewares get onAfter and onFinish. A middleware entered
 * after the client went away gets its onFinish at once.
 */
export function enterMiddleware(res: express.Response, scope: MiddlewareScope, middleware: HttpMiddleware, context: IMiddlewareContext): void {
  const state = stateOf(res);
  const entry: IEntered = { scope, middleware, context };
  state.entered.push(entry);

  if (!middleware.onFinish) {
    return;
  }
  if (state.aborted !== undefined) {
    const aborted = state.aborted;
    setImmediate(() => runFinish(state, [entry], aborted));
    return;
  }
  watchFinish(res, state);
}

/** An onBefore answered: the later middlewares and the action step aside, the route's sender sends `response`. */
export function answerEarly(res: express.Response, response: Response): void {
  stateOf(res).early = response;
  res.locals.response = response;
}

export function answeredEarly(res: express.Response): boolean {
  return (res.locals as Record<symbol, IReplyState | undefined> | undefined)?.[STATE]?.early !== undefined;
}

/** Hands an error handler's answer, and the error it answers, to the route's sender. */
export function setErrorReply(res: express.Response, response: Response, error: unknown): void {
  stateOf(res).replyError = { error };
  res.locals.response = response;
}

export function replyErrorOf(res: express.Response): { error: unknown } | undefined {
  return (res.locals as Record<symbol, IReplyState | undefined> | undefined)?.[STATE]?.replyError;
}

/** The error the reply sent through the pipeline answers, when it was an error reply. */
export function answeredErrorOf(res: express.Response): unknown {
  return (res.locals as Record<symbol, IReplyState | undefined> | undefined)?.[STATE]?.answered?.error;
}

/** Called by HttpServer's first handler: the server hooks of the request get the route `routes` matches. */
export function lookUpRoutesIn(res: express.Response, routes: RouteIndex): void {
  stateOf(res).routes = routes;
}

/** The context of the server hooks of this request, made once. */
export function serverContextOf(req: express.Request, res: express.Response): IMiddlewareContext {
  const state = stateOf(res);
  return (state.server ??= state.routes ? preRoutedContext(req, res, state.routes) : { req, res, storage: (req as Request).storage });
}

// Looked up on the first read: most requests have no server middleware asking. Own enumerable getters, so a spread copies the match.
function preRoutedContext(req: express.Request, res: express.Response, routes: RouteIndex): IMiddlewareContext {
  let match: IRouteMatch | undefined | null = null;
  const matched = () => (match === null ? (match = routes.match(req.method, req.path)) : match);
  return {
    req,
    res,
    storage: (req as Request).storage,
    get route() {
      return matched()?.route;
    },
    get controller() {
      return matched()?.controller;
    },
    get path() {
      return matched()?.path;
    },
  };
}

// The route the router matched replaces the pre-routing match in the server onAfter and onFinish hooks.
function hookContext(state: IReplyState, entry: IEntered): IMiddlewareContext {
  if (entry.scope !== 'server' || !state.route) {
    return entry.context;
  }
  const { route, controller, path } = state.route.context;
  if (state.routedServer?.route !== route) {
    const { req, res, storage } = entry.context;
    state.routedServer = { req, res, storage, route, controller, path };
  }
  return state.routedServer;
}

function watchFinish(res: express.Response, state: IReplyState): void {
  if (state.watching) {
    return;
  }
  state.watching = true;

  const settle = (aborted: boolean) => {
    state.aborted = aborted;
    return state.entered.slice();
  };

  // finish and close fire once: a response that already ended (a client gone during an earlier onBefore) fires neither again
  if (res.writableFinished || res.destroyed || res.closed) {
    const entries = settle(!res.writableFinished);
    const aborted = state.aborted!;
    setImmediate(() => runFinish(state, entries, aborted));
    return;
  }

  const onEvent = (event: 'finish' | 'close') => {
    res.off('finish', onFinish);
    res.off('close', onClose);
    const entries = settle(event === 'close' && !res.writableFinished);
    runFinish(state, entries, state.aborted!);
  };
  const onFinish = () => onEvent('finish');
  const onClose = () => onEvent('close');
  res.once('finish', onFinish);
  res.once('close', onClose);
}

/** The entries having `hook`, route ones then server ones, each inner (last entered) first. */
function innerFirst(entries: readonly IEntered[], hook: 'onAfter' | 'onFinish'): IEntered[] {
  const route: IEntered[] = [];
  const server: IEntered[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.middleware[hook]) {
      (entry.scope === 'route' ? route : server).push(entry);
    }
  }
  return server.length === 0 ? route : route.concat(server);
}

const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';

// Started in order without awaiting each other: a slow async onFinish (an audit write) must not hold back the access
// log or the metrics of the same request.
function runFinish(state: IReplyState, entries: readonly IEntered[], aborted: boolean): void {
  for (const entry of innerFirst(entries, 'onFinish')) {
    const failed = (error: unknown) => httpLog().error({ error, middleware: nameOf(entry.middleware) }, 'onFinish of ${middleware} failed');
    try {
      const result = inScope(state, entry, () => entry.middleware.onFinish!({ ...hookContext(state, entry), aborted }));
      if (isThenable(result)) {
        result.then(undefined, failed);
      }
    } catch (error) {
      failed(error);
    }
  }
}

// D9: route hooks run inside the AsyncLocalStorage context the action ran in.
function inScope<T>(state: IReplyState, entry: IEntered, fn: () => T): T {
  const storage = entry.scope === 'route' ? state.route?.storage : undefined;
  return storage ? storage.run(entry.context.storage, fn) : fn();
}

const isResponse = (value: unknown): value is Response => typeof (value as Response | null | undefined)?.execute === 'function';

/**
 * The reply pipeline: every framework reply goes out through here. It runs the onAfter hooks of the entered middlewares
 * not run yet (route ones, then server ones, inner first), then `response.execute()`.
 *
 * A throwing onAfter turns the reply into the error reply for its error; the remaining hooks see that reply. A throw
 * once the reply was turned is logged. When the headers are already sent (an action answered `res` itself), no
 * onAfter runs. Rejects only when sending fails.
 */
export async function sendReply(req: express.Request, res: express.Response, response: Response, options: ISendReplyOptions = {}): Promise<void> {
  const state = stateOf(res);
  let current = response;
  let error = options.error;

  const pending = (state.pending ??= innerFirst(state.entered, 'onAfter'));
  if (!res.headersSent && pending.length > 0) {
    // only a captured reply needs to know which of its headers are the route's own
    const captured = responseCaptureOf(res) !== undefined;
    let own = captured ? headerNamesOf(current) : undefined;
    const watch = watchHeaderWrites(res);
    // the hooks of one scope share one base context, so they share one reply context, updated between them
    let ctx: (IReplyContext & { error?: unknown }) | undefined;
    let ctxBase: IMiddlewareContext | undefined;
    try {
      for (let entry = pending.shift(); entry; entry = pending.shift()) {
        const base = hookContext(state, entry);
        if (!ctx || ctxBase !== base) {
          ctxBase = base;
          ctx = { ...base, response: current, error };
        } else {
          ctx.response = current;
          ctx.error = error;
        }
        const replyCtx = ctx;
        try {
          const result = inScope(state, entry, () => entry.middleware.onAfter!(replyCtx));
          if (isThenable(result)) {
            await result;
          }
          if (!isResponse(replyCtx.response)) {
            throw new UnexpectedServerError(`${nameOf(entry.middleware)}.onAfter set ctx.response to something that is not a Response`);
          }
          if (replyCtx.response !== current) {
            current = replyCtx.response;
            own = captured ? headerNamesOf(current) : undefined;
          }
        } catch (err) {
          // headers the hooks set for the reply that failed must not go out with the error reply; those the error
          // handlers set are its own, so they are not watched
          const turned = await turnIntoErrorReply(req, res, state, entry, err, options, async (makeReply) => {
            restoreWatched(res, watch);
            watch.paused = true;
            try {
              return await makeReply();
            } finally {
              watch.paused = false;
            }
          });
          if (turned) {
            current = turned.response;
            own = captured ? headerNamesOf(current) : undefined;
            error = turned.error;
          }
        }
      }
    } finally {
      stopWatching(res, watch);
    }
    keepHeadersSetByHooks(res, watch.names, current, own);
  }

  if (error !== undefined) {
    state.answered = { error };
  }

  const callback = (await current.execute(req, res)) as ResponseFunction | void;
  if (callback) {
    await callback(req, res);
  }
}

function headerNamesOf(response: Response): Set<string> {
  const names = new Set<string>();
  if (typeof response.setHeader === 'function') {
    for (const h of response.headers) {
      names.add(h.Name.toLowerCase());
    }
  }
  return names;
}

interface IHeaderWatch {
  readonly setHeader: express.Response['setHeader'];
  /** Lower-case names of the headers set on `res` while watched, and the value each had before its first write. */
  readonly names: string[];
  readonly previous: unknown[];
  paused: boolean;
}

const WATCH = Symbol('headerWatch');

type Watched = express.Response & { [WATCH]?: IHeaderWatch };

// One function for every request, reading the watch from `res`: no closure is made per reply.
function watchedSetHeader(this: Watched, name: string, value: number | string | readonly string[]): express.Response {
  const watch = this[WATCH]!;
  if (!watch.paused) {
    const key = name.toLowerCase();
    if (!watch.names.includes(key)) {
      watch.names.push(key);
      watch.previous.push(this.getHeader(key));
    }
  }
  return watch.setHeader.call(this, name, value) as express.Response;
}

/**
 * Records the headers set on `res` until `stopWatching()`; express's `set`, `header`, `append` and `cookie` all end in
 * `setHeader`. `setHeader` is put back by assignment, never `delete`: a deleted property puts `res` into dictionary
 * mode, which slows every later property access on it and Node's write path for every response.
 */
function watchHeaderWrites(res: Watched): IHeaderWatch {
  const watch: IHeaderWatch = { setHeader: res.setHeader, names: [], previous: [], paused: false };
  res[WATCH] = watch;
  res.setHeader = watchedSetHeader as express.Response['setHeader'];
  return watch;
}

function stopWatching(res: Watched, watch: IHeaderWatch): void {
  res.setHeader = watch.setHeader;
  res[WATCH] = undefined;
}

/** Puts back the value each watched header had before its first watched write, and forgets the writes. */
function restoreWatched(res: express.Response, watch: IHeaderWatch): void {
  watch.names.forEach((name, i) => {
    const value = watch.previous[i];
    if (value === undefined) {
      res.removeHeader(name);
    } else {
      watch.setHeader.call(res, name, value as string | number | readonly string[]);
    }
  });
  watch.names.length = 0;
  watch.previous.length = 0;
}

/**
 * `execute()` sets the response's own headers (`IResponseOptions.Headers`) on `res` and would overwrite a header a hook
 * set on `res` under the same name: those hook headers join the response's, so they win. With a response capture
 * (`own` given), the names the hooks added are kept out of it: an idempotent replay restores the route's own headers
 * only.
 */
function keepHeadersSetByHooks(res: express.Response, written: readonly string[], response: Response, own: Set<string> | undefined): void {
  if (typeof response.setHeader !== 'function') {
    return;
  }
  const headers = response.headers;
  if (headers.length > 0) {
    for (const name of written) {
      // res.cookie() appends, so the response's own cookies never overwrite a hook's
      if (name === 'set-cookie' || !headers.some((h) => h.Name.toLowerCase() === name)) {
        continue;
      }
      const value = res.getHeader(name);
      if (value !== undefined) {
        response.setHeader(name, value as string | number | readonly string[]);
      }
    }
  }
  if (!own) {
    return;
  }
  const added = new Set<string>();
  for (const name of written) {
    if (!own.has(name)) {
      added.add(name);
    }
  }
  for (const h of response.headers) {
    const name = h.Name.toLowerCase();
    if (!own.has(name)) {
      added.add(name);
    }
  }
  if (added.size > 0) {
    excludeFromCapture(res, added);
  }
}

async function turnIntoErrorReply(
  req: express.Request,
  res: express.Response,
  state: IReplyState,
  entry: IEntered,
  err: unknown,
  options: ISendReplyOptions,
  around: (makeReply: () => Promise<IErrorReply>) => Promise<IErrorReply>,
): Promise<IErrorReply | undefined> {
  const log = httpLog();
  if (state.converted) {
    log.error({ error: err, middleware: nameOf(entry.middleware), url: req.originalUrl }, 'onAfter of ${middleware} failed on the error reply of an earlier onAfter failure; that reply is sent as it is');
    return undefined;
  }
  const errorReply = state.route?.errorReply ?? options.errorReply;
  if (!errorReply) {
    log.error({ error: err, middleware: nameOf(entry.middleware), url: req.originalUrl }, 'onAfter of ${middleware} failed and no error reply can be made here; the reply is sent as it is');
    return undefined;
  }

  state.converted = true;
  markStage(res, 'after');
  try {
    const turned = await around(() => errorReply(err));
    noteRouteError(res, turned.error);
    return turned;
  } catch (replyError) {
    log.error({ error: replyError, middleware: nameOf(entry.middleware) }, 'No error reply could be made for the failure of onAfter of ${middleware}; the reply is sent as it is');
    return undefined;
  }
}
