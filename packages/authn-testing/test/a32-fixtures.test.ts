import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DateTime, FixedOffsetZone } from 'luxon';
import 'mocha';
import { a32Fixtures, isoWithOffset } from '../src/fixtures/index.js';
import type { A32CaseName } from '../src/fixtures/index.js';
import { migrateA32 } from './reference/a32-migration.js';

const NOW = new Date('2026-10-01T10:20:30.456Z');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const NAMES: A32CaseName[] = ['liveReset', 'liveInvite', 'expiredReset', 'resetWithoutStartDate', 'resetWithoutWaitTime', 'lastAttemptOnly'];

describe('A32 fixtures', () => {
  it('are deterministic for a given now', () => {
    assert.deepStrictEqual(a32Fixtures(NOW), a32Fixtures(new Date(NOW.getTime())));
  });

  it('move with now', () => {
    const later = a32Fixtures(new Date(NOW.getTime() + 1000));
    assert.equal(later.cases.liveReset.expected.secret!.expires_at.getTime(), NOW.getTime() + 3001_000);
  });

  it('isoWithOffset matches luxon toISO for a +02:00 zone', () => {
    for (const at of [NOW, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-12-31T23:59:59.999Z')]) {
      const luxon = DateTime.fromJSDate(at, { zone: FixedOffsetZone.instance(120) }).toISO();
      assert.equal(isoWithOffset(at, 120), luxon);
    }
    assert.equal(isoWithOffset(NOW, 120), '2026-10-01T12:20:30.456+02:00');
  });

  it('isoWithOffset handles negative and zero offsets like luxon', () => {
    for (const off of [-330, 0, 60]) {
      assert.equal(isoWithOffset(NOW, off), DateTime.fromJSDate(NOW, { zone: FixedOffsetZone.instance(off) }).toISO());
    }
  });

  it('holds the six cases with stable uuids and a datetime in 2.x text form', () => {
    const f = a32Fixtures(NOW);
    assert.deepStrictEqual(Object.keys(f.cases), NAMES);
    assert.deepStrictEqual(
      f.users,
      NAMES.map((n) => f.cases[n].user),
    );
    assert.equal(f.cases.liveReset.user.Uuid, 'a32a0000-0000-4000-8000-000000000001');
    const start = f.cases.liveReset.user.metadata.find((m) => m.Key === 'user:pwd_reset:start_date')!;
    assert.deepStrictEqual(start, { Key: 'user:pwd_reset:start_date', Type: 'datetime', Value: isoWithOffset(new Date(NOW.getTime() - 600_000), 120) });
    assert.deepStrictEqual(
      f.cases.liveInvite.user.metadata.find((m) => m.Key === 'user:invite:pending'),
      { Key: 'user:invite:pending', Type: 'boolean', Value: 'true' },
    );
  });

  it('stores the token in metadata and hashes it with SHA-256 hex', () => {
    const f = a32Fixtures(NOW);
    for (const n of NAMES) {
      const c = f.cases[n];
      const stored = c.user.metadata.find((m) => m.Key === 'user:pwd_reset:token');
      assert.equal(stored?.Value ?? null, c.token);
      if (c.expected.secret) assert.equal(c.expected.secret.secret_hash, sha(c.token!));
    }
  });

  it('liveCount and expectedRows agree with the cases', () => {
    const f = a32Fixtures(NOW);
    const live = NAMES.map((n) => f.cases[n].expected.secret).filter((s) => s !== null);
    assert.equal(f.liveCount, 2);
    assert.equal(live.length, f.liveCount);
    assert.deepStrictEqual(f.expectedRows, live);
    assert.deepStrictEqual(
      f.expectedRows.map((r) => r.purpose),
      ['reset', 'invite'],
    );
  });

  it('a reference migration turns the users into expectedRows and metadataKeysAfter', () => {
    const f = a32Fixtures(NOW);
    const m = migrateA32(f.users, NOW);
    assert.deepStrictEqual(m.rows, f.expectedRows);
    assert.equal(m.liveCount, f.liveCount);
    for (const n of NAMES) {
      const c = f.cases[n];
      assert.deepStrictEqual([...m.metadataKeys.get(c.user.Uuid)!].sort(), [...c.expected.metadataKeysAfter].sort(), n);
    }
  });

  it('the reference migration throws when inserted rows differ from live entries', () => {
    const f = a32Fixtures(NOW);
    assert.throws(() => migrateA32(f.users, NOW, (rows) => rows.slice(1)), /2 live entries but 1 rows inserted/);
  });
});
