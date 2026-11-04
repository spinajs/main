const GOLDEN_GAMMA = 0x9e3779b9;

/** Expands one 32-bit seed into well-mixed words, so neighbouring seeds start from unrelated states. */
export function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + GOLDEN_GAMMA) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** xoshiro128**, the only source of randomness in a simulation. */
export class SimRandom {
  protected readonly s = new Uint32Array(4);

  constructor(public readonly seed: number) {
    const words = splitmix32(seed);
    for (let i = 0; i < 4; i++) this.s[i] = words();
    // the all-zero state is the generator's only fixed point
    if (this.s.every((w) => w === 0)) this.s[0] = 1;
  }

  public static fromState(state: readonly [number, number, number, number]): SimRandom {
    const random = new SimRandom(0);
    random.s.set(state);
    return random;
  }

  public nextUint32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** Uniform in [0, 1). */
  public next(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  public int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError(`SimRandom.int: maxExclusive must be a positive integer, got ${maxExclusive}`);
    }
    return Math.floor(this.next() * maxExclusive);
  }

  public pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('SimRandom.pick: the list is empty');
    return items[this.int(items.length)];
  }

  public chance(probability: number): boolean {
    return this.next() < probability;
  }
}
