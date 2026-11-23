/** A fixed-capacity buffer, oldest first; a push past `capacity` overwrites the oldest entry. */
export class RingBuffer<T> {
  private slots: T[] = [];
  private start = 0;

  public constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`ring capacity must be a positive integer, got ${capacity}`);
  }

  public get size(): number {
    return this.slots.length;
  }

  public push(item: T): void {
    if (this.slots.length < this.capacity) {
      this.slots.push(item);
      return;
    }
    this.slots[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
  }

  public toArray(): T[] {
    return [...this.slots.slice(this.start), ...this.slots.slice(0, this.start)];
  }

  public clear(): void {
    this.slots = [];
    this.start = 0;
  }
}
