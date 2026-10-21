import assert from 'node:assert/strict';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { burst } from '../helpers/concurrency.js';
import { conformanceSuite } from './run.js';
import type { ConformanceOptions } from './run.js';

export interface MfaRecordPort {
  readonly secretEnc: string;
  readonly keyId: string;
  readonly confirmedAt: Date | null;
  readonly lastStep: number | null;
  readonly createdAt: Date;
}

/** The shape of `MfaSecretStore` in `@spinajs/authn-totp`, which this kit does not depend on. */
export interface MfaStorePort {
  get(id: IdentityRef, step: string): Promise<MfaRecordPort | null>;
  put(id: IdentityRef, step: string, secretEnc: string, keyId: string): Promise<boolean>;
  confirm(id: IdentityRef, step: string, at?: Date, expectedSecretEnc?: string): Promise<boolean>;
  acceptStep(id: IdentityRef, step: string, timeStep: number): Promise<boolean>;
  remove(id: IdentityRef, step: string): Promise<void>;
  replaceRecoveryCodes(id: IdentityRef, rawCodes: readonly string[]): Promise<void>;
  redeemRecoveryCode(id: IdentityRef, raw: string): Promise<boolean>;
  countRecoveryCodes(id: IdentityRef): Promise<number>;
  removeRecoveryCodes(id: IdentityRef): Promise<void>;
  /** Everything the store holds for the identity as one text, for the checks that read storage. */
  dump?(id: IdentityRef): Promise<string>;
  dispose?(): Promise<void>;
}

const ALICE: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const BOB: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000002' };
const STEP = 'totp';
const SECRET_ENC = 'v1:b64:Zm9vYmFyLWNpcGhlcnRleHQ';
const KEY_ID = 'k-conf-1';
const CODES = ['conf-code-aaaa1111', 'conf-code-bbbb2222', 'conf-code-cccc3333'];

async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
  } catch {
    return true;
  }
  return false;
}

async function enrolled(store: MfaStorePort, id: IdentityRef = ALICE, step: string = STEP): Promise<void> {
  assert.strictEqual(await store.put(id, step, SECRET_ENC, KEY_ID), true);
  assert.strictEqual(await store.confirm(id, step), true);
}

/** Each case gets a store from `make` that holds no steps and no recovery codes. */
export function runMfaStoreConformance(name: string, make: () => Promise<MfaStorePort>, opts: ConformanceOptions = {}): void {
  conformanceSuite(name, make, opts, true, (kase) => {
    kase('put stores the cipher text verbatim, unconfirmed, with no accepted step', async (store, clock) => {
      assert.strictEqual(await store.get(ALICE, STEP), null);
      assert.strictEqual(await store.put(ALICE, STEP, SECRET_ENC, KEY_ID), true);
      const row = await store.get(ALICE, STEP);
      assert.strictEqual(row?.secretEnc, SECRET_ENC);
      assert.strictEqual(row?.keyId, KEY_ID);
      assert.strictEqual(row?.confirmedAt, null);
      assert.strictEqual(row?.lastStep, null);
      assert.strictEqual(row?.createdAt.getTime(), clock.now().getTime());
    });

    kase('put replaces an unconfirmed step and resets it, but never a confirmed one', async (store) => {
      await store.put(ALICE, STEP, SECRET_ENC, KEY_ID);
      await store.acceptStep(ALICE, STEP, 5);
      assert.strictEqual(await store.put(ALICE, STEP, 'v1:b64:second', 'k-conf-2'), true);
      const replaced = await store.get(ALICE, STEP);
      assert.strictEqual(replaced?.secretEnc, 'v1:b64:second');
      assert.strictEqual(replaced?.keyId, 'k-conf-2');
      assert.strictEqual(replaced?.lastStep, null);

      assert.strictEqual(await store.confirm(ALICE, STEP), true);
      assert.strictEqual(await store.put(ALICE, STEP, 'v1:b64:third', 'k-conf-3'), false);
      const kept = await store.get(ALICE, STEP);
      assert.strictEqual(kept?.secretEnc, 'v1:b64:second');
      assert.notStrictEqual(kept?.confirmedAt, null);
    });

    kase('confirm is true once, honours expectedSecretEnc and is false without a step', async (store, clock) => {
      assert.strictEqual(await store.confirm(ALICE, STEP), false, 'no step');
      await store.put(ALICE, STEP, SECRET_ENC, KEY_ID);
      assert.strictEqual(await store.confirm(ALICE, STEP, undefined, 'v1:b64:other'), false, 'another cipher text');
      assert.strictEqual((await store.get(ALICE, STEP))?.confirmedAt, null);
      const at = new Date(clock.now().getTime() + 5000);
      assert.strictEqual(await store.confirm(ALICE, STEP, at, SECRET_ENC), true);
      assert.strictEqual((await store.get(ALICE, STEP))?.confirmedAt?.getTime(), at.getTime());
      assert.strictEqual(await store.confirm(ALICE, STEP, new Date(at.getTime() + 5000), SECRET_ENC), false, 'already confirmed');
      assert.strictEqual(await store.confirm(ALICE, STEP), false, 'already confirmed, no expectation');
      assert.strictEqual((await store.get(ALICE, STEP))?.confirmedAt?.getTime(), at.getTime());
    });

    kase('of 10 parallel confirms exactly one confirms', async (store) => {
      await store.put(ALICE, STEP, SECRET_ENC, KEY_ID);
      const results = await burst(10, () => store.confirm(ALICE, STEP, undefined, SECRET_ENC));
      assert.strictEqual(results.rejected().length, 0);
      assert.strictEqual(results.count((won) => won), 1);
    });

    kase('acceptStep is true once per time step and never for a lower or equal one', async (store) => {
      await enrolled(store);
      assert.strictEqual(await store.acceptStep(ALICE, STEP, 100), true);
      assert.strictEqual(await store.acceptStep(ALICE, STEP, 100), false, 'the same step');
      assert.strictEqual(await store.acceptStep(ALICE, STEP, 99), false, 'a lower step');
      assert.strictEqual(await store.acceptStep(ALICE, STEP, 101), true);
      assert.strictEqual((await store.get(ALICE, STEP))?.lastStep, 101);
    });

    kase('acceptStep accepts step 0 once', async (store) => {
      await enrolled(store);
      assert.strictEqual(await store.acceptStep(ALICE, STEP, 0), true);
      assert.strictEqual(await store.acceptStep(ALICE, STEP, 0), false);
    });

    kase('of 10 parallel acceptStep calls with one time step exactly one is true', async (store) => {
      await enrolled(store);
      const results = await burst(10, () => store.acceptStep(ALICE, STEP, 200));
      assert.strictEqual(results.rejected().length, 0);
      assert.strictEqual(results.count((won) => won), 1);
    });

    kase('acceptStep is false without a step and does not create one', async (store) => {
      assert.strictEqual(await store.acceptStep(ALICE, STEP, 1), false);
      assert.strictEqual(await store.get(ALICE, STEP), null);
    });

    kase('acceptStep rejects a time step that is not a non-negative integer', async (store) => {
      await enrolled(store);
      for (const bad of [-1, 1.5, NaN, Infinity]) {
        assert.ok(await rejects(store.acceptStep(ALICE, STEP, bad)), 'time step ' + String(bad));
      }
      assert.strictEqual((await store.get(ALICE, STEP))?.lastStep, null);
    });

    kase('identities and steps are independent', async (store) => {
      await enrolled(store, ALICE, STEP);
      await enrolled(store, ALICE, 'other');
      await enrolled(store, BOB, STEP);
      assert.strictEqual(await store.acceptStep(ALICE, STEP, 50), true);
      assert.strictEqual(await store.acceptStep(ALICE, 'other', 50), true);
      assert.strictEqual(await store.acceptStep(BOB, STEP, 50), true);
      await store.remove(ALICE, STEP);
      assert.strictEqual(await store.get(ALICE, STEP), null);
      assert.notStrictEqual(await store.get(ALICE, 'other'), null);
      assert.notStrictEqual(await store.get(BOB, STEP), null);
      assert.strictEqual(await store.put(ALICE, STEP, SECRET_ENC, KEY_ID), true, 'a removed confirmed step can be enrolled again');
    });

    kase('a recovery code is single use', async (store) => {
      await store.replaceRecoveryCodes(ALICE, CODES);
      assert.strictEqual(await store.countRecoveryCodes(ALICE), 3);
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, CODES[0]), true);
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, CODES[0]), false);
      assert.strictEqual(await store.countRecoveryCodes(ALICE), 2);
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, 'conf-code-unknown'), false);
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, ''), false);
      assert.strictEqual(await store.countRecoveryCodes(ALICE), 2);
    });

    kase('a recovery code works for its own identity only', async (store) => {
      await store.replaceRecoveryCodes(ALICE, CODES);
      assert.strictEqual(await store.redeemRecoveryCode(BOB, CODES[0]), false);
      assert.strictEqual(await store.countRecoveryCodes(BOB), 0);
      assert.strictEqual(await store.countRecoveryCodes(ALICE), 3);
    });

    kase('of 10 parallel redeems of one recovery code exactly one wins', async (store) => {
      await store.replaceRecoveryCodes(ALICE, CODES);
      const results = await burst(10, () => store.redeemRecoveryCode(ALICE, CODES[1]));
      assert.strictEqual(results.rejected().length, 0);
      assert.strictEqual(results.count((won) => won), 1);
      assert.strictEqual(await store.countRecoveryCodes(ALICE), 2);
    });

    kase('replaceRecoveryCodes voids the old set, used or not', async (store) => {
      await store.replaceRecoveryCodes(ALICE, CODES);
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, CODES[0]), true);
      await store.replaceRecoveryCodes(ALICE, ['conf-code-dddd4444', 'conf-code-eeee5555']);
      assert.strictEqual(await store.countRecoveryCodes(ALICE), 2);
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, CODES[1]), false, 'an unused old code');
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, 'conf-code-dddd4444'), true);
      await store.replaceRecoveryCodes(ALICE, [CODES[0]]);
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, CODES[0]), true, 'a spent code is fresh in a new set');
    });

    kase('replaceRecoveryCodes refuses repeated and empty codes and keeps the old set', async (store) => {
      await store.replaceRecoveryCodes(ALICE, CODES);
      assert.ok(await rejects(store.replaceRecoveryCodes(ALICE, ['conf-code-x', 'conf-code-x'])), 'repeated');
      assert.ok(await rejects(store.replaceRecoveryCodes(ALICE, ['conf-code-x', ''])), 'empty');
      assert.strictEqual(await store.countRecoveryCodes(ALICE), 3);
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, CODES[2]), true);
    });

    kase('removeRecoveryCodes leaves none and replace with no codes empties the set', async (store) => {
      await store.replaceRecoveryCodes(ALICE, CODES);
      await store.replaceRecoveryCodes(BOB, CODES);
      await store.removeRecoveryCodes(ALICE);
      assert.strictEqual(await store.countRecoveryCodes(ALICE), 0);
      assert.strictEqual(await store.redeemRecoveryCode(ALICE, CODES[0]), false);
      assert.strictEqual(await store.countRecoveryCodes(BOB), 3, 'another identity keeps its codes');
      await store.replaceRecoveryCodes(BOB, []);
      assert.strictEqual(await store.countRecoveryCodes(BOB), 0);
    });

    kase('the stored data never holds a raw recovery code', async (store) => {
      if (!store.dump) {
        return;
      }
      await enrolled(store);
      await store.replaceRecoveryCodes(ALICE, CODES);
      await store.redeemRecoveryCode(ALICE, CODES[0]);
      const stored = await store.dump(ALICE);
      assert.ok(stored.length > 0, 'dump is empty, so this check proves nothing');
      for (const code of CODES) {
        assert.ok(!stored.includes(code), 'the storage holds ' + code);
      }
    });
  });
}
