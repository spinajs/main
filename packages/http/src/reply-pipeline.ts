import type { AsyncLocalStorage } from 'node:async_hooks';
import type express from 'express';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UnexpectedServerError } from '@spinajs/exceptions';
import type { HttpMiddleware, IActionLocalStoregeContext, IMiddlewareContext, IReplyContext, IRouteInvocation, Response, ResponseFunction } from './interfaces.js';
import { markStage, noteRouteError } from './errors/on-error.js';
import { excludeFromCapture } from './response-capture.js';

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
    setImmediate(() => void runFinish(state, [entry], aborted));
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

// A server middleware is entered before routing; its onAfter and onFinish still get the route the request matched.
function hookContext(state: IReplyState, entry: IEntered): IMiddlewareContext {
  if (entry.scope !== 'server' || !state.route) {
    return entry.context;
  }
  const { route, controller, path } = state.route.context;
  return { ...entry.context, route, controller, path };
}

function watchFinish(res: express.Response, state: IReplyState): void {
  if (state.watching) {
    return;
  }
  state.watching = true;

  const settle = (aborted: boolean) => {
    state.aborted = aborted;
    return [...state.entered].reverse();
  };

  // finish and close fire once: a response that already ended (a client gone during an earlier onBefore) fires neither again
  if (res.writableFinished || res.destroyed || res.closed) {
    const entries = settle(!res.writableFinished);
    const aborted = state.aborted!;
    setImmediate(() => void runFinish(state, entries, aborted));
    return;
  }

  const onEvent = (event: 'finish' | 'close') => {
    res.off('finish', onFinish);
    res.off('close', onClose);
    const entries = settle(event === 'close' && !res.writableFinished);
    void runFinish(state, entries, state.aborted!);
  };
  const onFinish = () => onEvent('finish');
  const onClose = () => onEvent('close');
  res.once('finish', onFinish);
  res.once('close', onClose);
}

const ordered = (entries: IEntered[]): IEntered[] => [...entries.filter((e) => e.scope === 'route'), ...entries.filter((e) => e.scope === 'server')];

async function runFinish(state: IReplyState, entries: IEntered[], aborted: boolean): Promise<void> {
  for (const entry of ordered(entries)) {
    if (!entry.middleware.onFinish) {
      continue;
    }
    try {
      await inScope(state, entry, () => entry.middleware.onFinish!({ ...hookContext(state, entry), aborted }));
    } catch (error) {
      httpLog().error({ error, middleware: nameOf(entry.middleware) }, 'onFinish of ${middleware} failed');
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
  let own = headerNamesOf(current);
  let error = options.error;

  const pending = (state.pending ??= ordered([...state.entered].reverse()).filter((e) => e.middleware.onAfter));
  if (!res.headersSent && pending.length > 0) {
    const before = { ...res.getHeaders() };
    const written = watchHeaderWrites(res);
    try {
      for (let entry = pending.shift(); entry; entry = pending.shift()) {
        if (!entry.middleware.onAfter) {
          continue;
        }
        const ctx: IReplyContext = { ...hookContext(state, entry), response: current, error };
        try {
          await inScope(state, entry, () => entry.middleware.onAfter!(ctx));
          if (!isResponse(ctx.response)) {
            throw new UnexpectedServerError(`${nameOf(entry.middleware)}.onAfter set ctx.response to something that is not a Response`);
          }
          if (ctx.response !== current) {
            current = ctx.response;
            own = headerNamesOf(current);
          }
        } catch (err) {
          // headers the hooks set for the reply that failed must not go out with the error reply; those the error
          // handlers set are its own, so they are not watched
          const turned = await turnIntoErrorReply(req, res, state, entry, err, options, async (makeReply) => {
            restoreHeaders(res, before, written.names);
            written.names.clear();
            written.paused = true;
            try {
              return await makeReply();
            } finally {
              written.paused = false;
            }
          });
          if (turned) {
            current = turned.response;
            own = headerNamesOf(current);
            error = turned.error;
          }
        }
      }
    } finally {
      written.stop();
    }
    keepHeadersSetByHooks(res, written.names, current, own);
  }

  if (error !== undefined) {
    state.answered = { error };
  }

  const callback = (await current.execute(req, res)) as ResponseFunction | void;
  if (callback) {
    await callback(req, res);
  }
}

const headerNamesOf = (response: Response): Set<string> => new Set((typeof response.setHeader === 'function' ? response.headers : []).map((h) => h.Name.toLowerCase()));

/** Records the names of the headers set on `res` until `stop()`; express's `set`, `header`, `append` and `cookie` all end in `setHeader`. */
function watchHeaderWrites(res: express.Response): { names: Set<string>; paused: boolean; stop: () => void } {
  const names = new Set<string>();
  const own = Object.prototype.hasOwnProperty.call(res, 'setHeader');
  const setHeader = res.setHeader;
  const watch = {
    names,
    paused: false,
    stop: () => {
      if (own) {
        res.setHeader = setHeader;
      } else {
        delete (res as Partial<express.Response>).setHeader;
      }
    },
  };
  res.setHeader = function (this: express.Response, name: string, value: number | string | readonly string[]) {
    if (!watch.paused) {
      names.add(name.toLowerCase());
    }
    return setHeader.call(this, name, value);
  } as express.Response['setHeader'];
  return watch;
}

function restoreHeaders(res: express.Response, before: Record<string, unknown>, names: Iterable<string>): void {
  for (const name of names) {
    const value = before[name];
    if (value === undefined) {
      res.removeHeader(name);
    } else {
      res.setHeader(name, value as string | number | readonly string[]);
    }
  }
}

/**
 * `execute()` sets the response's own headers (`IResponseOptions.Headers`) on `res` and would overwrite a header a hook
 * set on `res`: the hooks' headers join the response's, so they win. The names the hooks added are kept out of a
 * response capture: an idempotent replay restores the route's own headers only.
 */
function keepHeadersSetByHooks(res: express.Response, written: Set<string>, response: Response, own: Set<string>): void {
  if (typeof response.setHeader !== 'function') {
    return;
  }
  for (const name of written) {
    const value = res.getHeader(name);
    // res.cookie() appends, so the response's own cookies never overwrite a hook's
    if (name !== 'set-cookie' && value !== undefined) {
      response.setHeader(name, value as string | number | readonly string[]);
    }
  }
  const added = new Set([...written, ...headerNamesOf(response)].filter((name) => !own.has(name)));
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
