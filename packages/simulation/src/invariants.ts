export interface SimInvariant {
  name: string;
  /** Checked only after the quiescence phase, eg. "every instance finished". */
  final?: boolean;
  check(): Promise<void>;
}

export class InvariantViolation extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

export function invariant(name: string, check: () => Promise<void>, options: { final?: boolean } = {}): SimInvariant {
  return { name, check, final: options.final ?? false };
}

export function ensure(condition: boolean, message: string, details?: unknown): asserts condition {
  if (!condition) throw new InvariantViolation(message, details);
}

export function countBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** Keys seen more than `max` times, sorted. */
export function overLimit<T>(items: Iterable<T>, key: (item: T) => string, max = 1): string[] {
  return [...countBy(items, key)]
    .filter(([, n]) => n > max)
    .map(([k]) => k)
    .sort();
}

/** Values written once and never changed afterwards, eg. a journaled step result or a stored reply. */
export class WriteOnceLedger {
  protected readonly values = new Map<string, string>();

  /** Throws when `key` was observed before with a different value. */
  public observe(key: string, value: unknown): void {
    const json = JSON.stringify(value ?? null);
    const seen = this.values.get(key);
    if (seen !== undefined && seen !== json) throw new InvariantViolation(`${key} changed after it was written`, { before: seen, after: json });
    this.values.set(key, json);
  }

  /** The value recorded for `key`, or undefined. */
  public value(key: string): unknown {
    const json = this.values.get(key);
    return json === undefined ? undefined : (JSON.parse(json) as unknown);
  }

  public keys(): string[] {
    return [...this.values.keys()];
  }
}
