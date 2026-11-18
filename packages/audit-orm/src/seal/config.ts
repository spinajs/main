import { AuditConfigError } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

import { AUDIT_SEAL_KEY_ID_WIDTH } from './table.js';

const DEFAULT_SEAL_BATCH = 1000;
const MAX_SEAL_BATCH = 5000;
const DEFAULT_SETTLE_SECONDS = 30;
const DEFAULT_MAX_SEALS = 100;
// A seal row holds the HMAC and every input to it, so a short secret can be guessed offline.
export const MIN_SEAL_SECRET_LENGTH = 32;

export interface SealKey {
  readonly id: string;
  readonly secret: string;
}

/** Per table, the seq up to which its seals may be keyless: one for every connection, or one per connection name. */
export type KeylessUpTo = ReadonlyMap<string, number | ReadonlyMap<string, number>>;

export interface SealConfig {
  readonly settleMs: number;
  readonly batchSize: number;
  readonly maxSeals: number;
  /** The first signs, every one verifies. */
  readonly keys: readonly SealKey[];
  readonly keylessUpTo: KeylessUpTo;
}

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : fallback);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// Validated here as well as by the schema: a key that is silently dropped would make the sealer seal without it.
function keysOf(v: unknown): SealKey[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new AuditConfigError('audit: audit.seal.keys must be a list of { id, secret }');
  const keys = v.map((entry: unknown, i): SealKey => {
    const id = isRecord(entry) ? entry.id : undefined;
    const secret = isRecord(entry) ? entry.secret : undefined;
    if (typeof id !== 'string' || id === '' || id.length > AUDIT_SEAL_KEY_ID_WIDTH) throw new AuditConfigError(`audit: audit.seal.keys[${i}].id must be a text of 1 to ${AUDIT_SEAL_KEY_ID_WIDTH} characters`);
    if (typeof secret !== 'string' || secret.length < MIN_SEAL_SECRET_LENGTH) throw new AuditConfigError(`audit: audit.seal.keys[${i}].secret (key ${JSON.stringify(id)}) must be a text of at least ${MIN_SEAL_SECRET_LENGTH} characters`);
    return { id, secret };
  });
  const twice = keys.find((k, i) => keys.findIndex((o) => o.id === k.id) !== i);
  if (twice) throw new AuditConfigError(`audit: audit.seal.keys lists the key id ${JSON.stringify(twice.id)} twice`);
  return keys;
}

const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function seqsOf(v: unknown): Map<string, number> | undefined {
  if (!isRecord(v)) return undefined;
  const seqs = Object.entries(v).filter((e): e is [string, number] => isSeq(e[1]));
  return seqs.length === Object.keys(v).length ? new Map(seqs) : undefined;
}

// Validated here as well as by the schema: a dropped entry would turn a lawful keyless prefix into tampering.
function keylessUpToOf(v: unknown): KeylessUpTo {
  const out = new Map<string, number | Map<string, number>>();
  if (v === undefined) return out;
  const invalid = new AuditConfigError('audit: audit.seal.keylessUpTo must map a table to a seq, or to { [connection]: seq }');
  if (!isRecord(v)) throw invalid;
  for (const [table, entry] of Object.entries(v)) {
    const seq = isSeq(entry) ? entry : seqsOf(entry);
    if (seq === undefined) throw invalid;
    out.set(table, seq);
  }
  return out;
}

/** The seq up to which the seals of `table` on `connection` may be keyless; undefined when the configuration names none. */
export function keylessUpToFor(cfg: SealConfig, connection: string, table: string): number | undefined {
  const entry = cfg.keylessUpTo.get(table);
  return typeof entry === 'number' ? entry : entry?.get(connection);
}

export function sealConfig(): SealConfig {
  const cfg = DI.get(Configuration)?.get<{ settleSeconds?: unknown; batchSize?: unknown; maxSeals?: unknown; keys?: unknown; keylessUpTo?: unknown } | undefined>(['audit', 'seal']);
  const settle = typeof cfg?.settleSeconds === 'number' && cfg.settleSeconds >= 0 ? cfg.settleSeconds : DEFAULT_SETTLE_SECONDS;
  return { settleMs: settle * 1000, batchSize: Math.min(positive(cfg?.batchSize, DEFAULT_SEAL_BATCH), MAX_SEAL_BATCH), maxSeals: positive(cfg?.maxSeals, DEFAULT_MAX_SEALS), keys: keysOf(cfg?.keys), keylessUpTo: keylessUpToOf(cfg?.keylessUpTo) };
}
