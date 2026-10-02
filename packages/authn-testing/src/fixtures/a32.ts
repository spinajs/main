import { createHash } from 'node:crypto';
import type { LegacyMetadataRow, LegacyUser, SecretRowView } from '../harness/ports.js';
export type A32CaseName = 'liveReset' | 'liveInvite' | 'expiredReset' | 'resetWithoutStartDate' | 'resetWithoutWaitTime' | 'lastAttemptOnly';

export interface A32Case {
  readonly name: A32CaseName;
  readonly user: LegacyUser;
  readonly token: string | null;
  readonly expected: { readonly secret: Omit<SecretRowView, 'used_at'> | null; readonly metadataKeysAfter: readonly string[] };
}
export interface A32Fixtures {
  readonly cases: Readonly<Record<A32CaseName, A32Case>>;
  readonly users: readonly LegacyUser[];
  readonly liveCount: 2;
  readonly expectedRows: readonly Omit<SecretRowView, 'used_at'>[];
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** `DateTime.toISO()` shape for a fixed-offset zone: milliseconds always present, `Z` for offset 0. */
export function isoWithOffset(at: Date, offsetMinutes: number): string {
  const l = new Date(at.getTime() + offsetMinutes * 60_000);
  const date = `${pad(l.getUTCFullYear(), 4)}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}`;
  const time = `${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}:${pad(l.getUTCSeconds())}.${pad(l.getUTCMilliseconds(), 3)}`;
  const off = offsetMinutes === 0 ? 'Z' : `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.trunc(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date}T${time}${off}`;
}

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const OFFSET = 120;

const START = 'user:pwd_reset:start_date';
const TOKEN = 'user:pwd_reset:token';
const WAIT = 'user:pwd_reset:wait_time';
const LAST_ATTEMPT = 'user:pwd_reset:last_attempt';

export function a32Fixtures(now: Date): A32Fixtures {
  const d = (s: number) => new Date(now.getTime() + s * 1000);
  const iso = (s: number) => isoWithOffset(d(s), OFFSET);
  const uuid = (n: number) => `a32a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const start = (s: number): LegacyMetadataRow => ({ Key: START, Type: 'datetime', Value: iso(s) });
  const token = (t: string): LegacyMetadataRow => ({ Key: TOKEN, Type: 'string', Value: t });
  const wait = (s: string): LegacyMetadataRow => ({ Key: WAIT, Type: 'number', Value: s });

  const make = (
    name: A32CaseName,
    n: number,
    login: string,
    isActive: boolean,
    tok: string | null,
    metadata: readonly LegacyMetadataRow[],
    secret: { purpose: string; expiresIn: number; createdAt: number } | null,
    metadataKeysAfter: readonly string[],
  ): A32Case => ({
    name,
    user: { Uuid: uuid(n), Email: `${login}@example.test`, Login: login, IsActive: isActive, metadata },
    token: tok,
    expected: {
      secret:
        secret && tok
          ? { identity: `user:${uuid(n)}`, purpose: secret.purpose, secret_hash: sha256hex(tok), expires_at: d(secret.expiresIn), created_at: d(secret.createdAt) }
          : null,
      metadataKeysAfter,
    },
  });

  const t1 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const t2 = '9b2f3c4d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';
  const t3 = '3d6f0a2b-7c1e-4f5a-8b9c-0d1e2f3a4b5c';
  const t4 = '5e7a1b3c-2d4f-4e6a-9b8c-1f2e3d4c5b6a';
  const t5 = '7a9c3e5f-4b6d-4a8c-8e0f-2b4d6f8a0c2e';

  const cases: Record<A32CaseName, A32Case> = {
    liveReset: make('liveReset', 1, 'reset.live', true, t1, [start(-600), token(t1), wait('3600'), { Key: 'user:phone', Type: 'string', Value: '+48 600 000 001' }], { purpose: 'reset', expiresIn: 3000, createdAt: -600 }, ['user:phone']),
    liveInvite: make('liveInvite', 2, 'invite.live', false, t2, [start(-300), token(t2), wait('900'), { Key: 'user:invite:pending', Type: 'boolean', Value: 'true' }], { purpose: 'invite', expiresIn: 600, createdAt: -300 }, ['user:invite:pending']),
    expiredReset: make('expiredReset', 3, 'reset.expired', true, t3, [start(-7200), token(t3), wait('3600')], null, []),
    resetWithoutStartDate: make('resetWithoutStartDate', 4, 'reset.nostart', true, t4, [token(t4), wait('3600')], null, []),
    resetWithoutWaitTime: make('resetWithoutWaitTime', 5, 'reset.nowait', true, t5, [start(-60), token(t5)], null, []),
    lastAttemptOnly: make('lastAttemptOnly', 6, 'reset.done', true, null, [{ Key: LAST_ATTEMPT, Type: 'string', Value: iso(-86400) }, { Key: 'user:pwd:reset', Type: 'boolean', Value: 'false' }], null, []),
  };

  const order: A32CaseName[] = ['liveReset', 'liveInvite', 'expiredReset', 'resetWithoutStartDate', 'resetWithoutWaitTime', 'lastAttemptOnly'];
  return {
    cases,
    users: order.map((n) => cases[n].user),
    liveCount: 2,
    expectedRows: order.map((n) => cases[n].expected.secret).filter((s): s is NonNullable<typeof s> => s !== null),
  };
}
