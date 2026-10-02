/** Runs tasks one at a time per key; different keys run side by side. */
export class SerialQueue {
  protected tails = new Map<string, Promise<void>>();

  public run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return result;
  }

  /** Keys with queued or running work. */
  public get Size(): number {
    return this.tails.size;
  }
}
