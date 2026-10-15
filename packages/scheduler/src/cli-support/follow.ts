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
import { SseMessage, SseParser } from './sse.js';

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
  /** How long a refused connection or a 502/503/504 answer is retried before giving up; default 60 s. */
  maxDownMs?: number;
  /** First retry delay after such a failure, doubled per failure up to 10 s; default 1 s. */
  retryDelayMs?: number;
}

/** Reachable streams in a row that end (closed or failed) without any event before following gives up. */
const MAX_EMPTY_CONNECTIONS = 5;
const MAX_DOWN_MS = 60_000;
const RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10_000;
/** Answers of a proxy whose backend is briefly gone, e.g. during a rolling deploy. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);
// without the JSON fallback scheduler-http answers 406 instead of the real 401/403/404
const ACCEPT = 'text/event-stream, application/json;q=0.5';

/** Reads the SSE endpoint of `@spinajs/scheduler-http` when `scheduler.cli.http.baseUrl` is set, else subscribes in-process. */
export function follow(service: SchedulerService, config: SchedulerConfig, o: FollowOptions): Promise<void> {
  if (config.cli.http?.baseUrl) return followOverSse(config.cli.http, o);
  return followInProcess(service, o);
}

/** An exception from `onEvent` or `until` ends the follow with that error, as on the SSE path. */
export function followInProcess(service: SchedulerService, o: FollowOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (o.signal?.aborted) return resolve();
    let finished = false;
    let off: (() => void) | undefined;
    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      o.signal?.removeEventListener('abort', onAbort);
      off?.();
      if (err === undefined) resolve();
      else reject(err);
    };
    const onAbort = () => finish();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    service
      .subscribe(
        o.target,
        (e) => {
          if (finished) return;
          try {
            o.onEvent(e);
            if (o.until(e)) finish();
          } catch (err) {
            finish(err ?? new Error('follow callback failed'));
          }
        },
        { after: o.after },
      )
      .then((u) => {
        off = u;
        if (finished) u();
        return u;
      })
      .catch((err) => finish(err ?? new Error('subscribe failed')));
  });
}

/**
 * Follows `GET {baseUrl}/scheduler/runs/:id/events` (or `/scheduler/schedules/:name/events`) and
 * reconnects with `Last-Event-ID` when the stream closes before `until`. Synthetic progress events
 * (R16) repeat the current position: they are delivered and show the stream is alive, but never
 * change the resume point.
 */
export async function followOverSse(http: FollowHttpOptions, o: FollowOptions): Promise<void> {
  const path =
    'runId' in o.target
      ? `scheduler/runs/${encodeURIComponent(o.target.runId)}/events`
      : `scheduler/schedules/${encodeURIComponent(o.target.schedule)}/events`;
  const url = new URL(path, http.baseUrl.endsWith('/') ? http.baseUrl : `${http.baseUrl}/`).toString();
  const maxDownMs = http.maxDownMs ?? MAX_DOWN_MS;
  const retryDelayMs = http.retryDelayMs ?? RETRY_DELAY_MS;
  let last = o.after;
  let empty = 0;
  let failures = 0;
  let downSince: number | undefined;

  while (!o.signal?.aborted) {
    const headers = {
      Accept: ACCEPT,
      ...(http.headers ?? {}),
      ...(last !== undefined ? { 'Last-Event-ID': String(last) } : {}),
    };
    let delivered = false as boolean;
    let reachable = false as boolean;
    let failure: unknown;

    /** True once following is over. */
    const handle = (m: SseMessage): boolean => {
      if (!m.data) {
        last = parseSseEventId(m.id) ?? last;
        return false;
      }
      const e = final(() => JSON.parse(m.data) as RunEvent);
      delivered = true;
      if (!(e.type === 'progress' && e.synthetic)) last = parseSseEventId(m.id) ?? last;
      return final(() => {
        o.onEvent(e);
        return o.until(e);
      });
    };

    try {
      const res = await fetch(url, { headers, signal: o.signal });
      if (GATEWAY_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`GET ${url} answered HTTP ${res.status}`);
      }
      if (!res.ok || !res.body) throw new FinalError(await streamError(res, url, o.target));
      const type = res.headers.get('content-type') ?? '';
      if (!type.toLowerCase().startsWith('text/event-stream')) {
        await res.body.cancel().catch(() => undefined);
        throw new FinalError(
          new Error(
            `GET ${url} answered '${type || 'no content type'}' instead of an event stream (text/event-stream)`,
          ),
        );
      }
      // a reachable stream ends the run of failures, whatever it delivers
      reachable = true;
      failures = 0;
      downSince = undefined;
      const parser = new SseParser();
      const decoder = new TextDecoder();
      // leaving a loop over the body cancels it, which closes the connection
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        for (const m of parser.push(decoder.decode(chunk, { stream: true }))) if (handle(m)) return;
      }
      for (const m of parser.end(decoder.decode())) if (handle(m)) return;
    } catch (err) {
      if (o.signal?.aborted) return;
      if (err instanceof FinalError) throw err.error;
      failure = err ?? new Error('event stream failed');
    }

    if (delivered) {
      empty = 0;
      failures = 0;
      downSince = undefined;
    }
    // a stream that is reachable but fails before any event would otherwise reset both budgets forever
    if (!delivered && (failure === undefined || reachable)) {
      if (++empty >= MAX_EMPTY_CONNECTIONS) {
        throw new Error(`event stream ${url} closed ${MAX_EMPTY_CONNECTIONS} times in a row without an event`);
      }
    } else if (failure !== undefined) {
      empty = 0;
    }
    if (failure === undefined) continue;
    failures++;
    downSince ??= Date.now();
    if (Date.now() - downSince >= maxDownMs) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      throw new Error(`event stream ${url} unreachable for ${Math.round(maxDownMs / 1000)} s: ${reason}`);
    }
    await delay(Math.min(retryDelayMs * 2 ** (failures - 1), MAX_RETRY_DELAY_MS), o.signal);
  }
}

/** Not retried: an HTTP error answer, a non-SSE answer, a bad event, an exception from a callback. */
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
  if (res.status === 404) {
    return 'runId' in target ? new RunNotFound(target.runId) : new ScheduleNotFound(target.schedule);
  }
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
