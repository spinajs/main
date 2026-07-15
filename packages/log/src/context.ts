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
  private als: AsyncLocalStorage<Record<string, unknown>> | null = null;

  /**
   * Lazily resolve and cache the shared AsyncLocalStorage from DI. Resolved as a
   * bare concrete class it is a shared singleton, so this is the very instance
   * http drives per action.
   */
  private storage(): AsyncLocalStorage<Record<string, unknown>> {
    if (!this.als) {
      this.als = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>;
    }
    return this.als;
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
