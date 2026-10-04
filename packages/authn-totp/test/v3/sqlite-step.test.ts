import 'mocha';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { base32Decode, FakeClock, parseOtpauth, totpFromProvisioning } from '@spinajs/authn-testing';
import { DbMfaStore, mfaKeyFrom } from '@spinajs/authn-orm';
import { mfaKeyRingFrom } from '../../src/cipher/index.js';
import { DbMfaSecretStore } from '../../src/db.js';
import { TotpMfaStep, totpOptions } from '../../src/step/index.js';
import { bootSqlite, clearMfaTables, rawQuery } from './support/sqlite.js';
import type { SqliteDb } from './support/sqlite.js';

const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const ALICE: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const START = new Date('2026-10-04T10:00:00Z');
const SECOND = 1000;

describe('v3 step: TotpMfaStep on DbMfaSecretStore (sqlite)', function () {
  this.timeout(30000);
  let db: SqliteDb;
  let clock: FakeClock;
  let step: TotpMfaStep;

  before(async () => {
    db = await bootSqlite('step');
  });

  after(async () => {
    await db?.dispose();
  });

  beforeEach(async () => {
    await clearMfaTables(db.driver);
    clock = new FakeClock(START);
    clock.install();
    step = new TotpMfaStep({ store: new DbMfaSecretStore(new DbMfaStore(db.driver)), keys: mfaKeyRingFrom({ secret: KEY }), options: totpOptions(), identities: null });
  });

  afterEach(() => {
    clock.uninstall();
  });

  it('SR-09 TOTP secret encrypted at rest', async () => {
    const { provisioning } = await step.beginEnrolment(ALICE);
    const { secret } = parseOtpauth(provisioning);
    const seed = base32Decode(secret);
    const forms = [secret.toUpperCase(), secret.toLowerCase(), seed.toString('hex'), seed.toString('hex').toUpperCase(), seed.toString('base64'), seed.toString('base64url')];
    const checkRow = async (when: string) => {
      const rows = (await rawQuery(db.driver, 'SELECT * FROM authn_mfa')) as Record<string, unknown>[];
      assert.strictEqual(rows.length, 1, when);
      assert.strictEqual(rows[0].key_id, mfaKeyFrom(KEY).keyId, when);
      const text = JSON.stringify(rows);
      for (const form of forms) {
        assert.ok(!text.includes(form), `${when}: the row holds the seed as ${form}`);
      }
    };

    await checkRow('after begin');
    const { recoveryCodes } = await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now()));
    await checkRow('after confirm');

    const codes = (await rawQuery(db.driver, 'SELECT * FROM authn_recovery_code')) as Record<string, unknown>[];
    assert.strictEqual(codes.length, 10);
    for (const row of codes) {
      assert.match(String(row.code_hash), /^[0-9a-f]{64}$/);
    }
    const stored = JSON.stringify(codes);
    for (const shown of recoveryCodes ?? []) {
      const normalised = shown.replace(/-/g, '');
      assert.ok(!stored.includes(shown) && !stored.includes(normalised), 'no recovery code in clear');
    }
    assert.deepStrictEqual(codes.map((r) => r.code_hash).sort(), (recoveryCodes ?? []).map((c) => createHash('sha256').update(c.replace(/-/g, ''), 'utf8').digest('hex')).sort());
  });

  it('enrols, verifies once per code, redeems a recovery code once and disables', async () => {
    const { provisioning } = await step.beginEnrolment(ALICE);
    const { recoveryCodes } = await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now()));
    assert.strictEqual(await step.enrolled(ALICE), true);
    await assert.rejects(step.beginEnrolment(ALICE));

    clock.tick(30 * SECOND);
    const code = totpFromProvisioning(provisioning, clock.now());
    assert.strictEqual(await step.verify(ALICE, code), true);
    assert.strictEqual(await step.verify(ALICE, code), false);

    assert.strictEqual(await step.verifyRecovery(ALICE, recoveryCodes![0]), true);
    assert.strictEqual(await step.verifyRecovery(ALICE, recoveryCodes![0]), false);

    await step.disable(ALICE);
    assert.strictEqual(await step.enrolled(ALICE), false);
    assert.deepStrictEqual(await rawQuery(db.driver, 'SELECT identity FROM authn_mfa'), []);
    assert.deepStrictEqual(await rawQuery(db.driver, 'SELECT identity FROM authn_recovery_code'), []);
  });

  it('a begin that lands after a confirmation leaves the confirmed row alone', async () => {
    const { provisioning } = await step.beginEnrolment(ALICE);
    const code = totpFromProvisioning(provisioning, clock.now());
    const [confirmed, begun] = await Promise.allSettled([step.confirmEnrolment(ALICE, code), step.beginEnrolment(ALICE)]);
    const row = ((await rawQuery(db.driver, 'SELECT confirmed_at FROM authn_mfa')) as Record<string, unknown>[])[0];
    if (confirmed.status === 'fulfilled') {
      assert.strictEqual(begun.status, 'rejected');
      assert.notStrictEqual(row.confirmed_at, null);
    } else {
      assert.strictEqual(begun.status, 'fulfilled');
      assert.strictEqual(row.confirmed_at, null);
    }
  });
});
