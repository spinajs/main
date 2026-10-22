export class LruCache<V> {
  protected readonly Items = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    protected readonly maxEntries: number,
    protected readonly now: () => number = Date.now,
  ) {}

  public get size(): number {
    return this.Items.size;
  }

  public get(key: string): V | undefined {
    const entry = this.Items.get(key);
    if (!entry) return undefined;
    this.Items.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.Items.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0 || this.maxEntries <= 0) return;
    this.Items.delete(key);
    this.Items.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.Items.size > this.maxEntries) {
      this.Items.delete(this.Items.keys().next().value as string);
    }
  }

  public clear(): void {
    this.Items.clear();
  }
}
