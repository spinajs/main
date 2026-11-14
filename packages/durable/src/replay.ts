export interface JournalRecord {
  key: string;
  status: 'succeeded' | 'skipped' | 'failed' | 'running' | 'aborted';
  result?: unknown;
  /** `false`: the value was not kept, so the operation has to run again. Absent counts as stored. */
  resultStored?: boolean;
  attempt: number;
  seq: number;
}

/**
 * Results of completed records by key. With `fromKey`, that record and everything after it in the
 * latest attempt that reached it are left out (their keys in every attempt); so are records whose value
 * was not stored.
 */
export function buildReplayMap(rows: JournalRecord[], fromKey?: string): Map<string, unknown> {
  const sorted = [...rows].sort((a, b) => a.attempt - b.attempt || a.seq - b.seq);

  let excluded = new Set<string>();
  if (fromKey !== undefined) {
    const attempts = [...new Set(sorted.map((r) => r.attempt))].reverse();
    for (const a of attempts) {
      const inAttempt = sorted.filter((r) => r.attempt === a);
      const idx = inAttempt.findIndex((r) => r.key === fromKey);
      if (idx >= 0) {
        excluded = new Set(inAttempt.slice(idx).map((r) => r.key));
        break;
      }
    }
  }

  const map = new Map<string, unknown>();
  for (const row of sorted) {
    if (excluded.has(row.key)) continue;
    if ((row.status === 'succeeded' || row.status === 'skipped') && row.resultStored !== false) map.set(row.key, row.result);
  }
  return map;
}
