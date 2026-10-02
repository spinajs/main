import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { LegacyUser, SecretRowView } from '../../src/harness/index.js';

export interface MigrationResult {
  readonly rows: readonly Omit<SecretRowView, 'used_at'>[];
  readonly metadataKeys: ReadonlyMap<string, readonly string[]>;
}

const RESET_PREFIX = 'user:pwd_reset:';
const valueOf = (u: LegacyUser, key: string) => u.metadata.find((m) => m.Key === key)?.Value ?? null;
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');


/** Test-only model of the 2.x to 3.0 step: live token rows become hashed secrets, every reset key is dropped. */
export function migrateA32(users: readonly LegacyUser[], now: Date): MigrationResult {
  const rows: Omit<SecretRowView, 'used_at'>[] = [];
  const metadataKeys = new Map<string, readonly string[]>();

  for (const u of users) {
    const token = valueOf(u, `${RESET_PREFIX}token`);
    const start = valueOf(u, `${RESET_PREFIX}start_date`);
    const wait = valueOf(u, `${RESET_PREFIX}wait_time`);
    const startAt = start ? DateTime.fromISO(start) : null;
    const waitSeconds = wait === null ? NaN : Number(wait);

    if (token && startAt?.isValid && Number.isFinite(waitSeconds)) {
      const expires = startAt.toMillis() + waitSeconds * 1000;
      if (expires > now.getTime()) {
        rows.push({
          identity: `user:${u.Uuid}`,
          purpose: valueOf(u, 'user:invite:pending') === 'true' ? 'invite' : 'reset',
          secret_hash: sha256hex(token),
          expires_at: new Date(expires),
          created_at: new Date(startAt.toMillis()),
        });
      }
    }

    metadataKeys.set(
      u.Uuid,
      u.metadata.map((m) => m.Key).filter((k) => !k.startsWith(RESET_PREFIX) && k !== 'user:pwd:reset'),
    );
  }

  return { rows, metadataKeys };
}
