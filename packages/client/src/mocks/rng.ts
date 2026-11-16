// FNV-1a over the key's UTF-16 units, mixed into the parent seed: a child depends on its own key only.
function derive(seed: number, key: string): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A seeded mulberry32 generator. The same seed always gives the same sequence. */
export class Rng {
  private state: number;

  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** A float in [0, 1). */
  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max]; both bounds must be safe integers, min not above max. */
  public int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  public pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  public chance(): boolean {
    return this.next() < 0.5;
  }

  /** A generator seeded from this one's seed and `key`, independent of how much of this one was used. */
  public child(key: string | number): Rng {
    return new Rng(derive(this.seed, String(key)));
  }
}
