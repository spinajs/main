/**
 * Browser fallback for {@link LogContext}. The browser has no
 * `node:async_hooks` / AsyncLocalStorage, so this keeps a single module-level
 * `current` object and swaps it synchronously around `with`.
 *
 * LIMITATION: there is NO async isolation here. `with` only holds the context
 * for the synchronous portion of `fn`; anything that runs after an `await` or a
 * deferred callback ( unless wrapped with {@link LogContextImpl.bind} ) will not
 * see it. This mirrors the Node API surface so callers write the same code, but
 * on the browser ambient context is best-effort and synchronous only.
 */
class LogContextImpl {
  private current: Record<string, unknown> = {};

  /**
   * The current ambient store.
   */
  public active(): Record<string, unknown> {
    return this.current;
  }

  /**
   * Synchronously set the context to `{ ...current, ...vars }` for the duration
   * of `fn`, restoring the previous value afterwards. No async isolation.
   */
  public with<T>(vars: Record<string, unknown>, fn: () => T): T {
    const previous = this.current;
    this.current = { ...previous, ...vars };
    try {
      return fn();
    } finally {
      this.current = previous;
    }
  }

  /**
   * Mutate the current store in place ( late-bound values ).
   */
  public set(key: string, value: unknown): void {
    this.current[key] = value;
  }

  /**
   * Capture the current store and restore it around each invocation of the
   * returned function.
   */
  public bind<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
    const captured = this.current;
    return (...args: A): R => {
      const previous = this.current;
      this.current = captured;
      try {
        return fn(...args);
      } finally {
        this.current = previous;
      }
    };
  }
}

/**
 * Shared ambient log context ( browser, synchronous fallback ).
 */
export const LogContext = new LogContextImpl();

/**
 * Projects only primitive scalar values ( string / number / boolean / bigint )
 * from an ambient-context object, dropping objects, arrays, Dates, functions,
 * null and undefined. Ambient context is meant for correlation ids ( requestId,
 * traceId, ... ) that belong on every log line; structured payloads should be
 * passed explicitly per call ( log.info({ obj }, ... ) ), not via ambient context.
 */
export function scalarContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
      out[k] = v;
    }
  }
  return out;
}
