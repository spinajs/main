export type ProgressInput = number | { done: number; total: number; message?: string };

export interface NormalizedProgress {
  fraction: number;
  done?: number;
  total?: number;
  message?: string;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function normalizeProgress(p: ProgressInput): NormalizedProgress {
  if (typeof p === 'number') return { fraction: clamp01(p / 100) };
  const out: NormalizedProgress = {
    fraction: p.total > 0 ? clamp01(p.done / p.total) : 0,
    done: p.done,
    total: p.total,
  };
  if (p.message !== undefined) out.message = p.message;
  return out;
}

export interface RollupState {
  completedWeight: number;
  currentWeight: number | null;
  currentFraction: number;
  plannedWeight: number;
  freeProgress: number | null;
}

export function computeRunProgress(s: RollupState): number {
  if (s.completedWeight === 0 && s.currentWeight === null) return Math.round(clamp01(s.freeProgress ?? 0) * 100);
  const seen = s.completedWeight + (s.currentWeight ?? 0);
  const total = Math.max(s.plannedWeight, seen);
  if (total <= 0) return 0;
  const done = s.completedWeight + (s.currentWeight ?? 0) * clamp01(s.currentFraction);
  // 100 is reserved for a succeeded run
  return Math.min(99, Math.floor((done / total) * 100));
}
