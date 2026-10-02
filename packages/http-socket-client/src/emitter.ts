type Listener = (...args: any[]) => void;
type Registered = Listener & { original?: Listener };
type Args<F> = F extends (...args: infer A) => void ? A : never;

export type ListenerMap<E> = { [K in keyof E]: (...args: any[]) => void };

/** A minimal typed emitter; `node:events` is not available in browsers. */
export class Emitter<E extends ListenerMap<E>> {
  private readonly listeners = new Map<keyof E, Set<Registered>>();

  constructor(private readonly onListenerError: (error: unknown) => void = rethrowAsync) {}

  public on<K extends keyof E>(event: K, listener: E[K]): () => void {
    return this.add(event, listener as Registered);
  }

  public once<K extends keyof E>(event: K, listener: E[K]): () => void {
    const wrapper: Registered = (...args: unknown[]) => {
      this.remove(event, wrapper);
      (listener as Listener)(...args);
    };
    wrapper.original = listener as Listener;
    return this.add(event, wrapper);
  }

  public off<K extends keyof E>(event: K, listener: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const registered of set) {
      if (registered === listener || registered.original === listener) set.delete(registered);
    }
    if (set.size === 0) this.listeners.delete(event);
  }

  public emit<K extends keyof E>(event: K, ...args: Args<E[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        try {
          this.onListenerError(error);
        } catch {
          // a faulty error handler must not stop the remaining listeners or the emitting code path
        }
      }
    }
  }

  public listenerCount(event: keyof E): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  public clear(): void {
    this.listeners.clear();
  }

  private add(event: keyof E, listener: Registered): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.remove(event, listener);
  }

  private remove(event: keyof E, listener: Registered): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(event);
  }
}

/** Surfaces a listener error as an uncaught error without breaking the code path that emitted. */
export function rethrowAsync(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}
