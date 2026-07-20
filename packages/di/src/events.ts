/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Platform-free EventEmitter implementation.
 *
 * The DI container extends EventEmitter, so it cannot DI-inject its own emitter
 * ( chicken-and-egg ). Node's `events` module is not available in the browser,
 * so we ship a small drop-in with the same public surface used across the
 * framework. Behaviour mirrors Node's EventEmitter closely enough for our needs:
 *
 * - `this`-returning mutators ( on / off / emit / ... )
 * - listener ordering ( prepend variants )
 * - once wrappers
 * - per-instance max listeners tracking
 *
 * Intentional deviation from Node: no throw-on-unhandled-'error'. The container
 * never relies on that behaviour and throwing would be surprising in a browser.
 */

type Listener = (...args: any[]) => void;

interface WrappedListener extends Listener {
  listener?: Listener;
}

const DEFAULT_MAX_LISTENERS = 10;

export class EventEmitter {
  private _events: Map<string | symbol, Listener[]> = new Map();
  private _maxListeners: number = DEFAULT_MAX_LISTENERS;

  public setMaxListeners(n: number): this {
    this._maxListeners = n;
    return this;
  }

  public getMaxListeners(): number {
    return this._maxListeners;
  }

  public addListener(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, false);
  }

  public on(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, false);
  }

  public prependListener(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, true);
  }

  public once(event: string | symbol, listener: Listener): this {
    return this._add(event, this._onceWrap(event, listener), false);
  }

  public prependOnceListener(event: string | symbol, listener: Listener): this {
    return this._add(event, this._onceWrap(event, listener), true);
  }

  public removeListener(event: string | symbol, listener: Listener): this {
    const list = this._events.get(event);
    if (!list) {
      return this;
    }

    for (let i = list.length - 1; i >= 0; i--) {
      const current = list[i] as WrappedListener;
      if (current === listener || current.listener === listener) {
        list.splice(i, 1);
        break;
      }
    }

    if (list.length === 0) {
      this._events.delete(event);
    }

    return this;
  }

  public off(event: string | symbol, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  public removeAllListeners(event?: string | symbol): this {
    if (event === undefined) {
      this._events.clear();
    } else {
      this._events.delete(event);
    }
    return this;
  }

  public emit(event: string | symbol, ...args: any[]): boolean {
    const list = this._events.get(event);
    if (!list || list.length === 0) {
      return false;
    }

    // copy to allow mutation ( once removal, removeListener ) during emit
    const listeners = list.slice();
    for (const listener of listeners) {
      listener.apply(this, args);
    }

    return true;
  }

  public listeners(event: string | symbol): Listener[] {
    const list = this._events.get(event);
    if (!list) {
      return [];
    }
    return list.map((l) => (l as WrappedListener).listener ?? l);
  }

  public rawListeners(event: string | symbol): Listener[] {
    const list = this._events.get(event);
    return list ? list.slice() : [];
  }

  public listenerCount(event: string | symbol): number {
    const list = this._events.get(event);
    return list ? list.length : 0;
  }

  public eventNames(): (string | symbol)[] {
    return Array.from(this._events.keys());
  }

  private _add(event: string | symbol, listener: Listener, prepend: boolean): this {
    let list = this._events.get(event);
    if (!list) {
      list = [];
      this._events.set(event, list);
    }

    if (prepend) {
      list.unshift(listener);
    } else {
      list.push(listener);
    }

    if (this._maxListeners > 0 && list.length > this._maxListeners) {
      // mirror Node's soft warning without depending on `process`
      // eslint-disable-next-line no-console
      console.warn(
        `Possible EventEmitter memory leak detected. ${list.length} ${String(event)} listeners added. Use setMaxListeners() to increase limit`,
      );
    }

    return this;
  }

  private _onceWrap(event: string | symbol, listener: Listener): WrappedListener {
    const self = this;
    const wrapped: WrappedListener = function (this: unknown, ...args: any[]) {
      self.removeListener(event, wrapped);
      listener.apply(this, args);
    };
    wrapped.listener = listener;
    return wrapped;
  }
}
