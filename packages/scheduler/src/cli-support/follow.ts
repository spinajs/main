import {
  InvalidRunParams,
  parseSseEventId,
  RunEvent,
  RunNotFound,
  ScheduleNotFound,
  SchedulerService,
  SubscribeTarget,
} from '../contract.js';
import type { SchedulerConfig } from '../interfaces.js';
import { SseParser } from './sse.js';

export interface FollowOptions {
  target: SubscribeTarget;
  /** Last seen `seq` (run target) or `id` (schedule target). */
  after?: number;
  onEvent(e: RunEvent): void;
  /** Following stops after the first event for which this is true. */
  until(e: RunEvent): boolean;
  signal?: AbortSignal;
}

export interface FollowHttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
}

/** Connections in a row that may end without delivering an event before following gives up. */
const MAX_CONNECTIONS = 5;
const RECONNECT_DELAY_MS = 1000;
// without the JSON fallback scheduler-http answers 406 instead of the real 401/403/404
const ACCEPT = 'text/event-stream, application/json;q=0.5';

/** Reads the SSE endpoint of `@spinajs/scheduler-http` when `scheduler.cli.http.baseUrl` is set, else subscribes in-process. */
export function follow(service: SchedulerService, config: SchedulerConfig, o: FollowOptions): Promise<void> {
  if (config.cli.http?.baseUrl) return followOverSse(config.cli.http, o);
  return followInProcess(service, o);
}

export function followInProcess(service: SchedulerService, o: FollowOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (o.signal?.aborted) return resolve();
    let finished = false;
    let off: (() => void) | undefined;
    const done = () => {
      if (finished) return;
      finished = true;
      o.signal?.removeEventListener('abort', done);
      off?.();
      resolve();
    };
    o.signal?.addEventListener('abort', done, { once: true });
    service
      .subscribe(
        o.target,
        (e) => {
          if (finished) return;
          o.onEvent(e);
          if (o.until(e)) done();
        },
        { after: o.after },
      )
      .then((u) => {
        off = u;
        if (finished) u();
        return u;
      })
      .catch((err) => {
        finished = true;
        reject(err);
      });
  });
}

/**
 * Follows `GET {baseUrl}/scheduler/runs/:id/events` (or `/scheduler/schedules/:name/events`) and
 * reconnects with `Last-Event-ID` when the stream closes before `until`. Synthetic progress events
 * (R16) repeat the current position: they are delivered, and never change the resume point.
 */
export async function followOverSse(http: FollowHttpOptions, o: FollowOptions): Promise<void> {
  const path =
    'runId' in o.target
      ? `scheduler/runs/${encodeURIComponent(o.target.runId)}/events`
      : `scheduler/schedules/${encodeURIComponent(o.target.schedule)}/events`;
  const url = new URL(path, http.baseUrl.endsWith('/') ? http.baseUrl : `${http.baseUrl}/`).toString();
  let last = o.after;
  let lastError: unknown;

  for (let idle = 0; idle < MAX_CONNECTIONS; ) {
    if (o.signal?.aborted) return;
    const headers = {
      Accept: ACCEPT,
      ...(http.headers ?? {}),
      ...(last !== undefined ? { 'Last-Event-ID': String(last) } : {}),
    };
    let delivered = false;
    try {
      const res = await fetch(url, { headers, signal: o.signal });
      if (!res.ok || !res.body) throw new FinalError(await streamError(res, url, o.target));
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        for (const m of parser.push(decoder.decode(chunk, { stream: true }))) {
          if (!m.data) {
            last = parseSseEventId(m.id) ?? last;
            continue;
          }
          const e = final(() => JSON.parse(m.data) as RunEvent);
          if (!(e.type === 'progress' && e.synthetic)) {
            last = parseSseEventId(m.id) ?? last;
            delivered = true;
          }
          const stop = final(() => {
            o.onEvent(e);
            return o.until(e);
          });
          // leaving the loop cancels the body, which closes the connection
          if (stop) return;
        }
      }
      lastError = undefined;
    } catch (err) {
      if (o.signal?.aborted) return;
      if (err instanceof FinalError) throw err.error;
      lastError = err;
    }
    idle = delivered ? 0 : idle + 1;
    if (lastError !== undefined && idle < MAX_CONNECTIONS) await delay(RECONNECT_DELAY_MS * idle, o.signal);
  }
  const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`event stream ${url} closed ${MAX_CONNECTIONS} times without a new event${reason}`);
}

/** Only a dropped or refused connection is retried; an HTTP error answer, a bad event or a callback error is not. */
class FinalError extends Error {
  constructor(public readonly error: unknown) {
    super(error instanceof Error ? error.message : String(error));
  }
}

function final<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new FinalError(err);
  }
}

async function streamError(res: Response, url: string, target: SubscribeTarget): Promise<Error> {
  if (res.status === 404)
    return 'runId' in target ? new RunNotFound(target.runId) : new ScheduleNotFound(target.schedule);
  const body = (await res.text().catch(() => '')).trim().slice(0, 500);
  const message = `GET ${url} failed: HTTP ${res.status}${body ? ` ${body}` : ''}`;
  return res.status === 400 ? new InvalidRunParams(message, []) : new Error(message);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
