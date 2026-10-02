import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { LegacyUser, SecretRowView } from '../../src/harness/index.js';

export interface MigrationResult {
  readonly rows: readonly Omit<SecretRowView, 'used_at'>[];
  readonly metadataKeys: ReadonlyMap<string, readonly string[]>;
  readonly liveCount: number;
}

type Row = Omit<SecretRowView, 'used_at'>;

const RESET_PREFIX = 'user:pwd_reset:';
const valueOf = (u: LegacyUser, key: string) => u.metadata.find((m) => m.Key === key)?.Value ?? null;
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function liveEntry(u: LegacyUser, now: Date): { token: string; startMs: number; expiresMs: number } | null {
  const token = valueOf(u, `${RESET_PREFIX}token`);
  const start = valueOf(u, `${RESET_PREFIX}start_date`);
  const wait = valueOf(u, `${RESET_PREFIX}wait_time`);
  const startAt = start ? DateTime.fromISO(start) : null;
  const waitSeconds = wait === null ? NaN : Number(wait);
  if (!token || !startAt?.isValid || !Number.isFinite(waitSeconds)) return null;
  const expiresMs = startAt.toMillis() + waitSeconds * 1000;
  return expiresMs > now.getTime() ? { token, startMs: startAt.toMillis(), expiresMs } : null;
}

/**
 * Test-only model of the 2.x to 3.0 step: live token rows become hashed secrets, every reset key is dropped.
 * Counts live entries before and rows inserted after and throws on a mismatch (design 22.18);
 * `insert` lets a test plant a failing write.
 */
export function migrateA32(users: readonly LegacyUser[], now: Date, insert: (rows: Row[]) => Row[] = (r) => r): MigrationResult {
  const live = users.map((u) => ({ u, e: liveEntry(u, now) })).filter((x) => x.e !== null);
  const liveCount = live.length;

  const rows = insert(
    live.map(({ u, e }) => ({
      identity: `user:${u.Uuid}`,
      purpose: valueOf(u, 'user:invite:pending') === 'true' ? 'invite' : 'reset',
      secret_hash: sha256hex(e!.token),
      expires_at: new Date(e!.expiresMs),
      created_at: new Date(e!.startMs),
    })),
  );
  if (rows.length !== liveCount) throw new Error(`A32 migration: ${liveCount} live entries but ${rows.length} rows inserted`);

  const metadataKeys = new Map<string, readonly string[]>();
  for (const u of users) {
    metadataKeys.set(
      u.Uuid,
      u.metadata.map((m) => m.Key).filter((k) => !k.startsWith(RESET_PREFIX) && k !== 'user:pwd:reset'),
    );
  }

  return { rows, metadataKeys, liveCount };
}
