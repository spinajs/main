import type { AsyncLocalStorage } from 'node:async_hooks';
import type express from 'express';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UnexpectedServerError } from '@spinajs/exceptions';
import type { HttpMiddleware, IActionLocalStoregeContext, IMiddlewareContext, IReplyContext, IRouteInvocation, Response, ResponseFunction } from './interfaces.js';
import { markStage, noteRouteError } from './errors/on-error.js';

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
}

const STATE = Symbol('replyPipeline');

const httpLog = () => DI.resolve(Log, ['http']);

const nameOf = (m: HttpMiddleware) => m.constructor.name;

function stateOf(res: express.Response): IReplyState {
  const locals = res.locals as Record<symbol, IReplyState | undefined>;
  return (locals[STATE] ??= { entered: [], converted: false, watching: false });
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
    setImmediate(() => void runFinish(state, [entry], true));
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

function watchFinish(res: express.Response, state: IReplyState): void {
  if (state.watching) {
    return;
  }
  state.watching = true;

  const settle = (event: 'finish' | 'close') => {
    res.off('finish', onFinish);
    res.off('close', onClose);
    state.aborted = event === 'close' && !res.writableFinished;
    void runFinish(state, [...state.entered].reverse(), state.aborted);
  };
  const onFinish = () => settle('finish');
  const onClose = () => settle('close');
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
      await inScope(state, entry, () => entry.middleware.onFinish!({ ...entry.context, aborted }));
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
  let error = options.error;

  const pending = (state.pending ??= ordered([...state.entered].reverse()).filter((e) => e.middleware.onAfter));
  if (!res.headersSent && pending.length > 0) {
    const before = { ...res.getHeaders() };
    for (let entry = pending.shift(); entry; entry = pending.shift()) {
      if (!entry.middleware.onAfter) {
        continue;
      }
      const ctx: IReplyContext = { ...entry.context, response: current, error };
      try {
        await inScope(state, entry, () => entry.middleware.onAfter!(ctx));
        if (!isResponse(ctx.response)) {
          throw new UnexpectedServerError(`${nameOf(entry.middleware)}.onAfter set ctx.response to something that is not a Response`);
        }
        current = ctx.response;
      } catch (err) {
        const turned = await turnIntoErrorReply(req, res, state, entry, err, options);
        if (turned) {
          current = turned.response;
          error = turned.error;
        }
      }
    }
    keepHeadersSetByHooks(res, before, current);
  }

  const callback = (await current.execute(req, res)) as ResponseFunction | void;
  if (callback) {
    await callback(req, res);
  }
}

/**
 * `execute()` sets the response's own headers (`IResponseOptions.Headers`) on `res` and would overwrite a header a hook
 * set on `res`: the hooks' headers join the response's, so they win.
 */
function keepHeadersSetByHooks(res: express.Response, before: Record<string, unknown>, response: Response): void {
  if (typeof response.setHeader !== 'function') {
    return;
  }
  for (const [name, value] of Object.entries(res.getHeaders())) {
    // res.cookie() appends, so the response's own cookies never overwrite a hook's
    if (name !== 'set-cookie' && value !== undefined && before[name] !== value) {
      response.setHeader(name, value as string | number | readonly string[]);
    }
  }
}

async function turnIntoErrorReply(req: express.Request, res: express.Response, state: IReplyState, entry: IEntered, err: unknown, options: ISendReplyOptions): Promise<IErrorReply | undefined> {
  const log = httpLog();
  const errorReply = state.route?.errorReply ?? options.errorReply;
  if (state.converted || !errorReply) {
    log.error({ error: err, middleware: nameOf(entry.middleware), url: req.originalUrl }, 'onAfter of ${middleware} failed on an error reply; the reply is sent as it is');
    return undefined;
  }

  state.converted = true;
  markStage(res, 'after');
  try {
    const turned = await errorReply(err);
    noteRouteError(res, turned.error);
    return turned;
  } catch (replyError) {
    log.error({ error: replyError, middleware: nameOf(entry.middleware) }, 'No error reply could be made for the failure of onAfter of ${middleware}; the reply is sent as it is');
    return undefined;
  }
}
