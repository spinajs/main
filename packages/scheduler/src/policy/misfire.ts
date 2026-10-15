export type OccurrencePlan =
  | { kind: 'run'; scheduledAt: number; trigger: 'schedule' | 'catch-up'; next: number | null; skipped: number }
  | { kind: 'misfire'; scheduledAt: number; next: number | null; skipped: number };
