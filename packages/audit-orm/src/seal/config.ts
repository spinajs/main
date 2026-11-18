import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

const DEFAULT_SEAL_BATCH = 1000;
const MAX_SEAL_BATCH = 5000;
const DEFAULT_SETTLE_SECONDS = 30;
const DEFAULT_MAX_SEALS = 100;

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : fallback);

export function sealConfig(): { settleMs: number; batchSize: number; maxSeals: number } {
  const cfg = DI.get(Configuration)?.get<{ settleSeconds?: unknown; batchSize?: unknown; maxSeals?: unknown } | undefined>(['audit', 'seal']);
  const settle = typeof cfg?.settleSeconds === 'number' && cfg.settleSeconds >= 0 ? cfg.settleSeconds : DEFAULT_SETTLE_SECONDS;
  return { settleMs: settle * 1000, batchSize: Math.min(positive(cfg?.batchSize, DEFAULT_SEAL_BATCH), MAX_SEAL_BATCH), maxSeals: positive(cfg?.maxSeals, DEFAULT_MAX_SEALS) };
}
