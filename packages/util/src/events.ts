/**
 * A set of listeners for one kind of value. A listener's throw or rejected promise goes to `onError` and never
 * stops delivery to the others.
 */
export class ListenerSet<T> {
  private readonly listeners = new Set<(value: T) => unknown>();

  /** @param onError - reporter for a failed listener ( defaults to `console.error` ) */
  constructor(private readonly onError: (err: unknown) => void = (err) => console.error('Listener failed', err)) {}

  get size(): number {
    return this.listeners.size;
  }

  /** Adds `fn` and returns its unsubscribe function. Adding one function twice makes two independent subscriptions. */
  add(fn: (value: T) => unknown): () => void {
    const entry = (value: T) => fn(value);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** Calls every listener added before this call, in the order they were added; async listeners are not awaited. */
  emit(value: T): void {
    // Snapshot: a listener may unsubscribe (or subscribe) while we deliver.
    for (const fn of [...this.listeners]) {
      try {
        const r = fn(value);
        if (r !== null && typeof r === 'object' && typeof (r as PromiseLike<unknown>).then === 'function') (r as PromiseLike<unknown>).then(undefined, this.onError);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
