export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export interface BurstResult<T> {
  readonly outcomes: readonly Outcome<T>[];
  fulfilled(): readonly T[];
  rejected(): readonly unknown[];
  count(pred: (v: T) => boolean): number;
}

/** Calls fn(0..n-1) synchronously in one tick (each call starts before any is awaited), then settles all. */
export async function burst<T>(n: number, fn: (i: number) => Promise<T>): Promise<BurstResult<T>> {
  const pending: Promise<T>[] = [];
  for (let i = 0; i < n; i++) {
    pending.push((async () => fn(i))());
  }
  const settled = await Promise.allSettled(pending);
  const outcomes: Outcome<T>[] = settled.map((s) => (s.status === 'fulfilled' ? { ok: true, value: s.value } : { ok: false, error: s.reason }));
  const fulfilled = (): T[] => outcomes.flatMap((o) => (o.ok ? [o.value] : []));
  return {
    outcomes,
    fulfilled,
    rejected: () => outcomes.flatMap((o) => (o.ok ? [] : [o.error])),
    count: (pred) => fulfilled().filter(pred).length,
  };
}
