import { InvalidArgument } from '@spinajs/exceptions';
import { TimeSpan, TimeSpanLike } from './timespan.js';

/* -------------------------------------------------------------------------- */
/*                              async / timing                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolves after the given time span. A promise-based `setTimeout`.
 *
 * @param ts - how long to wait ( any {@link TimeSpanLike}: ms number, ISO-ish string, TimeSpan, ... )
 * @example
 * await sleep(250);                    // 250 ms
 * await sleep(TimeSpan.fromSeconds(2)); // 2 s
 */
export function sleep(ts: TimeSpanLike): Promise<void> {
  const span = TimeSpan.parse(ts) ?? TimeSpan.ZERO;
  const ms = Math.max(0, span.totalMilliseconds);
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Yields control back to the event loop, resolving on the next iteration.
 * Useful to break up long synchronous work so I/O and timers can run.
 */
export function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Races a promise against a time span. If the span elapses first, rejects with
 * `error` ( or a default {@link InvalidArgument}-free `Error` ).
 *
 * NOTE: this does not cancel the underlying operation - it only stops waiting.
 * For cancellable timeouts use the resilience `timeoutStrategy`.
 *
 * @param promise - operation to bound
 * @param ts - maximum time to wait
 * @param error - error to reject with on timeout ( defaults to a generic timeout Error )
 * @example
 * const data = await withTimeout(fetchData(), TimeSpan.fromSeconds(5));
 */
export function withTimeout<T>(promise: Promise<T>, ts: TimeSpanLike, error?: Error): Promise<T> {
  const span = TimeSpan.parse(ts) ?? TimeSpan.ZERO;
  const ms = Math.max(0, span.totalMilliseconds);

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(error ?? new Error(`Operation timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/*                             graceful shutdown                              */
/* -------------------------------------------------------------------------- */

/**
 * A teardown callback run during graceful shutdown. May be async; its rejection
 * is caught and reported so one failing handler never blocks the others.
 */
export type ShutdownHandler = () => void | Promise<void>;

interface IShutdownEntry {
  name: string;
  handler: ShutdownHandler;
}

/** Signals that trigger a graceful shutdown when handlers are registered. */
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

const _handlers: IShutdownEntry[] = [];
let _listenersAttached = false;
let _shutdownPromise: Promise<void> | null = null;
const _signalListeners = new Map<NodeJS.Signals, () => void>();

function _attachSignalListeners() {
  if (_listenersAttached) {
    return;
  }
  _listenersAttached = true;

  for (const signal of SHUTDOWN_SIGNALS) {
    const listener = () => {
      // run handlers, then exit cleanly ( 0 = graceful )
      void runShutdown().finally(() => process.exit(0));
    };
    _signalListeners.set(signal, listener);
    process.once(signal, listener);
  }
}

/**
 * Registers a teardown callback to run on graceful shutdown ( `SIGINT` / `SIGTERM` or a manual
 * {@link runShutdown} call ). Handlers run in LIFO order - the last registered runs first -
 * mirroring nested resource acquisition.
 *
 * Signal listeners are attached lazily on the first registration, so importing this module has
 * no side effects.
 *
 * @param handler - teardown callback ( sync or async )
 * @param opts - optional `name` used in error reporting
 * @returns an unregister function that removes this handler
 * @example
 * const off = onShutdown(async () => { await db.close(); }, { name: 'db' });
 * // ... later, to cancel: off();
 */
export function onShutdown(handler: ShutdownHandler, opts?: { name?: string }): () => void {
  const entry: IShutdownEntry = { handler, name: opts?.name ?? handler.name ?? 'anonymous' };
  _handlers.push(entry);
  _attachSignalListeners();

  return () => {
    const idx = _handlers.indexOf(entry);
    if (idx !== -1) {
      _handlers.splice(idx, 1);
    }
  };
}

/**
 * Runs all registered shutdown handlers once, in LIFO order. Each handler is awaited and its
 * errors are isolated ( reported to `onError`, never rethrown ) so a single failure can't abort
 * the rest of the teardown. Repeated calls return the same in-flight / settled promise.
 *
 * @param onError - optional reporter for a failing handler ( defaults to `console.error` )
 */
export function runShutdown(onError?: (err: unknown, name: string) => void): Promise<void> {
  if (_shutdownPromise) {
    return _shutdownPromise;
  }

  const report = onError ?? ((err, name) => console.error(`Shutdown handler "${name}" failed`, err));

  _shutdownPromise = (async () => {
    // LIFO: last registered tears down first
    for (const entry of [..._handlers].reverse()) {
      try {
        await entry.handler();
      } catch (err) {
        report(err, entry.name);
      }
    }
  })();

  return _shutdownPromise;
}

/**
 * Clears the shutdown registry and detaches signal listeners, resetting shutdown state.
 * Intended for tests and for hosts that manage their own process lifecycle.
 */
export function clearShutdownHandlers(): void {
  _handlers.length = 0;
  _shutdownPromise = null;

  for (const [signal, listener] of _signalListeners) {
    process.removeListener(signal, listener);
  }
  _signalListeners.clear();
  _listenersAttached = false;
}

/* -------------------------------------------------------------------------- */
/*                               env parsing                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reads a string environment variable.
 *
 * @param name - variable name
 * @param defaultValue - value returned when the variable is unset
 * @returns the variable value, the default, or `undefined`
 */
export function envString(name: string, defaultValue?: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined ? defaultValue : raw;
}

/**
 * Reads a required string environment variable.
 *
 * @param name - variable name
 * @returns the non-empty variable value
 * @throws InvalidArgument when the variable is unset or empty
 */
export function envRequired(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    throw new InvalidArgument(`Required environment variable ${name} is not set`, name, 'ENV_MISSING');
  }
  return raw;
}

/**
 * Reads an integer environment variable.
 *
 * @param name - variable name
 * @param defaultValue - value returned when the variable is unset
 * @returns the parsed integer, the default, or `undefined`
 * @throws InvalidArgument when the variable is set but not a valid integer
 */
export function envInt(name: string, defaultValue?: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgument(`Environment variable ${name} must be an integer, got "${raw}"`, name, 'ENV_TYPE_MISMATCH');
  }
  return parsed;
}

const ENV_TRUE = new Set(['true', '1', 'yes', 'on']);
const ENV_FALSE = new Set(['false', '0', 'no', 'off', '']);

/**
 * Reads a boolean environment variable. Accepts ( case-insensitive )
 * `true/1/yes/on` and `false/0/no/off` ( and empty string = false ).
 *
 * @param name - variable name
 * @param defaultValue - value returned when the variable is unset
 * @returns the parsed boolean, the default, or `undefined`
 * @throws InvalidArgument when the variable is set but not a recognized boolean
 */
export function envBool(name: string, defaultValue?: boolean): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (ENV_TRUE.has(normalized)) {
    return true;
  }
  if (ENV_FALSE.has(normalized)) {
    return false;
  }

  throw new InvalidArgument(`Environment variable ${name} must be a boolean, got "${raw}"`, name, 'ENV_TYPE_MISMATCH');
}
