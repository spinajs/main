import { AsyncLocalStorage } from "node:async_hooks";
import { DI } from "@spinajs/di";

/**
 * Ambient log context backed by `node:async_hooks` AsyncLocalStorage.
 *
 * It deliberately resolves the SAME DI-singleton AsyncLocalStorage instance the
 * @spinajs/http module runs per action ( `als.run(req.storage, ...)` ). Because
 * that instance is a shared DI singleton, any log emitted anywhere inside a
 * request automatically inherits the request store ( requestId, realIp, ... )
 * with zero threading — the log package wires `setLogContextProvider(() =>
 * LogContext.active())` so `createLogMessageObject` merges it at lowest
 * precedence.
 *
 * The store type is a plain `Record<string, unknown>` — a superset of http's
 * `IActionLocalStoregeContext` — so log stays independent of http.
 */
class LogContextImpl {
  /**
   * Resolve the shared AsyncLocalStorage from DI. Resolved as a bare concrete
   * class it is a shared singleton, so this is the very instance http drives per
   * action. We deliberately do NOT cache the reference: DI returns the same
   * singleton on every call ( cheap lookup ), and NOT caching keeps LogContext
   * consistent with the current DI instance even if the container is reset /
   * re-registered ( a stale cached reference would silently diverge — e.g. after
   * a `DI.clearCache()` the store written via a freshly-resolved instance would
   * be invisible here ).
   */
  private storage(): AsyncLocalStorage<Record<string, unknown>> {
    return DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>;
  }

  /**
   * The current ambient store, or an empty object when outside any context.
   */
  public active(): Record<string, unknown> {
    return this.storage().getStore() ?? {};
  }

  /**
   * Run `fn` with `vars` merged ( copy-on-write ) onto the current store, so
   * nesting accumulates and http's already-set fields ( eg. requestId ) survive.
   */
  public with<T>(vars: Record<string, unknown>, fn: () => T): T {
    return this.storage().run({ ...this.active(), ...vars }, fn);
  }

  /**
   * Mutate the current store in place ( late-bound values ). No-op when called
   * outside any active context.
   */
  public set(key: string, value: unknown): void {
    const store = this.storage().getStore();
    if (store) {
      store[key] = value;
    }
  }

  /**
   * Capture the current store and re-attach it whenever the returned function is
   * invoked. Use to carry context across detached callbacks / EventEmitter
   * handlers that would otherwise lose it.
   */
  public bind<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
    const store = this.storage().getStore();
    if (!store) {
      return fn;
    }
    return (...args: A): R => this.storage().run(store, () => fn(...args));
  }
}

/**
 * Shared ambient log context. See {@link LogContextImpl}.
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
