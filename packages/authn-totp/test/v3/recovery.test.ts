import 'mocha';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { InvalidOperation } from '@spinajs/exceptions';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { FakeClock, totpFromProvisioning } from '@spinajs/authn-testing';
import { mfaKeyRingFrom } from '../../src/cipher/index.js';
import { MemoryMfaSecretStore } from '../../src/store/index.js';
import type { MfaRecord } from '../../src/store/index.js';
import { TotpMfaStep, totpOptions } from '../../src/step/index.js';

const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const ALICE: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const SECOND = 1000;
const SHOWN = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;

const plain = (code: string) => code.replace(/-/g, '');

class CountingStore extends MemoryMfaSecretStore {
  calls = 0;
  async get(id: IdentityRef, step: string): Promise<MfaRecord | null> {
    this.calls++;
    return super.get(id, step);
  }
  async redeemRecoveryCode(id: IdentityRef, raw: string): Promise<boolean> {
    this.calls++;
    return super.redeemRecoveryCode(id, raw);
  }
}

describe('v3 step: recovery codes', () => {
  let clock: FakeClock;
  let store: CountingStore;

  const make = (recoveryCodes?: number) => new TotpMfaStep({ store, keys: mfaKeyRingFrom({ secret: KEY }), options: totpOptions(recoveryCodes === undefined ? {} : { recoveryCodes }), identities: null });

  async function enrol(step: TotpMfaStep): Promise<{ provisioning: string; codes: readonly string[] }> {
    const { provisioning } = await step.beginEnrolment(ALICE);
    const { recoveryCodes } = await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now()));
    return { provisioning, codes: recoveryCodes ?? [] };
  }

  beforeEach(() => {
    clock = new FakeClock(new Date('2026-10-04T10:00:00Z'));
    clock.install();
    store = new CountingStore();
  });

  afterEach(() => {
    clock.uninstall();
  });

  it('declares verifyRecovery and regenerateRecoveryCodes', () => {
    const step = make();
    assert.strictEqual(typeof step.verifyRecovery, 'function');
    assert.strictEqual(typeof step.regenerateRecoveryCodes, 'function');
  });

  it('confirmation returns 10 codes of 80 bits shown as XXXX-XXXX-XXXX-XXXX, no repeats', async () => {
    const { codes } = await enrol(make());
    assert.strictEqual(codes.length, 10);
    for (const code of codes) {
      assert.match(code, SHOWN);
      assert.strictEqual(plain(code).length * 5, 80);
    }
    assert.strictEqual(new Set(codes).size, codes.length);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 10);
  });

  it('issues the configured number of codes', async () => {
    const { codes } = await enrol(make(3));
    assert.strictEqual(codes.length, 3);
  });

  it('SR-09 recovery codes are stored as SHA-256 only', async () => {
    const { codes } = await enrol(make());
    const stored = store.recoveryCodeHashes(ALICE);
    assert.strictEqual(stored.length, codes.length);
    for (const s of stored) {
      assert.match(s, /^[0-9a-f]{64}$/);
    }
    for (const code of codes) {
      for (const form of [code, plain(code)]) {
        assert.ok(!stored.some((s) => s.toUpperCase().includes(form.toUpperCase())), form);
      }
    }
    assert.deepStrictEqual([...stored].sort(), codes.map((c) => createHash('sha256').update(plain(c), 'utf8').digest('hex')).sort(), 'the hash of the normalised code');
  });

  it('a code is single use', async () => {
    const step = make();
    const { codes } = await enrol(step);
    assert.strictEqual(await step.verifyRecovery(ALICE, codes[0]), true);
    assert.strictEqual(await step.verifyRecovery(ALICE, codes[0]), false);
    assert.strictEqual(await step.verifyRecovery(ALICE, codes[1]), true);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 8);
  });

  it('20 parallel uses of one code give one success', async () => {
    const step = make();
    const { codes } = await enrol(step);
    const results = await Promise.all(Array.from({ length: 20 }, () => step.verifyRecovery(ALICE, codes[0])));
    assert.strictEqual(results.filter(Boolean).length, 1);
  });

  it('regeneration voids the old set and the new codes work', async () => {
    const step = make();
    const { codes } = await enrol(step);
    const fresh = await step.regenerateRecoveryCodes(ALICE);
    assert.strictEqual(fresh.length, 10);
    assert.ok(fresh.every((c) => SHOWN.test(c)));
    assert.ok(!fresh.some((c) => codes.includes(c)));
    for (const old of codes) {
      assert.strictEqual(await step.verifyRecovery(ALICE, old), false);
    }
    assert.strictEqual(await step.verifyRecovery(ALICE, fresh[0]), true);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 9);
  });

  it('verify refuses a recovery code and does not use it up', async () => {
    const step = make();
    const { codes } = await enrol(step);
    for (const form of [codes[0], plain(codes[0])]) {
      assert.strictEqual(await step.verify(ALICE, form), false);
    }
    assert.strictEqual(await step.verifyRecovery(ALICE, codes[0]), true);
  });

  it('verifyRecovery refuses a TOTP code without touching the store', async () => {
    const step = make();
    const { provisioning } = await enrol(step);
    clock.tick(30 * SECOND);
    const code = totpFromProvisioning(provisioning, clock.now());
    store.calls = 0;
    assert.strictEqual(await step.verifyRecovery(ALICE, code), false);
    assert.strictEqual(store.calls, 0);
    assert.strictEqual(await step.verify(ALICE, code), true, 'the TOTP code was not used up');
  });

  it('accepts lower case, spaces and missing dashes', async () => {
    const step = make();
    const { codes } = await enrol(step);
    assert.strictEqual(await step.verifyRecovery(ALICE, codes[0].toLowerCase()), true);
    assert.strictEqual(await step.verifyRecovery(ALICE, plain(codes[1])), true);
    assert.strictEqual(await step.verifyRecovery(ALICE, ` ${codes[2].replace(/-/g, ' ')}\n`), true);
    assert.strictEqual(await step.verifyRecovery(ALICE, `${plain(codes[3]).slice(0, 8)}-${plain(codes[3]).slice(8)}`), true);
  });

  it('refuses malformed input without touching the store', async () => {
    const step = make();
    const { codes } = await enrol(step);
    const p = plain(codes[0]);
    store.calls = 0;
    for (const bad of ['', p.slice(1), p + 'A', p.slice(0, 15) + '1', p.slice(0, 15) + '8', p.slice(0, 15) + '=', p.slice(0, 15) + 'Ä', p.slice(0, 15) + '_', null as unknown as string, 42 as unknown as string]) {
      assert.strictEqual(await step.verifyRecovery(ALICE, bad), false, String(bad));
    }
    assert.strictEqual(store.calls, 0);
    assert.strictEqual(await step.verifyRecovery(ALICE, codes[0]), true);
  });

  it('refuses non-ASCII spellings that upper-case to a code', async () => {
    const step = make();
    await enrol(step);
    await store.replaceRecoveryCodes(ALICE, ['SSAABBBBCCCCDDDD', 'IAAABBBBCCCCDDDD']);
    store.calls = 0;
    for (const bad of ['ßAA-BBBB-CCCC-DDDD', 'ıAAA-BBBB-CCCC-DDDD', 'SSAA\u00a0BBBB-CCCC-DDDD']) {
      assert.strictEqual(await step.verifyRecovery(ALICE, bad), false, bad);
    }
    assert.strictEqual(store.calls, 0);
    assert.strictEqual(await step.verifyRecovery(ALICE, 'ssaa-bbbb-cccc-dddd'), true);
  });

  it('an unconfirmed enrolment has no recovery', async () => {
    const step = make();
    await step.beginEnrolment(ALICE);
    await store.replaceRecoveryCodes(ALICE, ['AAAABBBBCCCCDDDD']);
    assert.strictEqual(await step.verifyRecovery(ALICE, 'AAAA-BBBB-CCCC-DDDD'), false);
    await assert.rejects(step.regenerateRecoveryCodes(ALICE), InvalidOperation);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 1);
  });

  it('without an enrolment verifyRecovery is false and regeneration throws', async () => {
    const step = make();
    assert.strictEqual(await step.verifyRecovery(ALICE, 'AAAA-BBBB-CCCC-DDDD'), false);
    await assert.rejects(step.regenerateRecoveryCodes(ALICE), InvalidOperation);
  });

  it('disable removes the codes', async () => {
    const step = make();
    const { codes } = await enrol(step);
    await step.disable(ALICE);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 0);
    assert.deepStrictEqual(store.recoveryCodeHashes(ALICE), []);
    assert.strictEqual(await step.verifyRecovery(ALICE, codes[0]), false);
    await assert.rejects(step.regenerateRecoveryCodes(ALICE), InvalidOperation);
  });

  it('confirmation voids codes left from an earlier enrolment', async () => {
    const step = make();
    await store.replaceRecoveryCodes(ALICE, ['AAAABBBBCCCCDDDD']);
    await enrol(step);
    assert.strictEqual(await step.verifyRecovery(ALICE, 'AAAA-BBBB-CCCC-DDDD'), false);
  });

  it('recoveryCodes 0: none at confirmation or regeneration', async () => {
    const step = make(0);
    const { provisioning } = await step.beginEnrolment(ALICE);
    assert.deepStrictEqual(await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now())), {});
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 0);
    assert.deepStrictEqual(await step.regenerateRecoveryCodes(ALICE), []);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 0);
  });
});
