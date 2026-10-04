import 'mocha';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { InvalidArgument } from '@spinajs/exceptions';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { identityKey, MemoryMfaSecretStore, MfaSecretStore } from '../../src/store/index.js';

const ALICE: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const BOB: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000002' };
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('v3 store: identityKey', () => {
  it('is type:id', () => {
    assert.strictEqual(identityKey(ALICE), 'user:00000000-0000-4000-8000-000000000001');
    assert.strictEqual(identityKey({ type: 'service', id: 'a:b' }), 'service:a:b');
  });

  it('refuses an empty type or one holding ":"', () => {
    assert.throws(() => identityKey({ type: '', id: 'x' }), InvalidArgument);
    assert.throws(() => identityKey({ type: 'us:er', id: 'x' }), InvalidArgument);
  });
});

describe('v3 store: MemoryMfaSecretStore', () => {
  let store: MemoryMfaSecretStore;

  beforeEach(() => {
    store = new MemoryMfaSecretStore();
  });

  it('is a MfaSecretStore', () => {
    assert.ok(store instanceof MfaSecretStore);
  });

  it('get is null without a row', async () => {
    assert.strictEqual(await store.get(ALICE, 'totp'), null);
  });

  it('put stores an unconfirmed row and replaces an earlier one', async () => {
    const t0 = Date.now();
    await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid1');
    const r = await store.get(ALICE, 'totp');
    assert.ok(r);
    assert.strictEqual(r.secretEnc, 'v1.a.b.c');
    assert.strictEqual(r.keyId, 'kid1');
    assert.strictEqual(r.confirmedAt, null);
    assert.strictEqual(r.lastStep, null);
    assert.ok(r.createdAt.getTime() >= t0);

    await store.acceptStep(ALICE, 'totp', 5);
    assert.strictEqual(await store.put(ALICE, 'totp', 'v1.d.e.f', 'kid2'), true);
    const again = await store.get(ALICE, 'totp');
    assert.deepStrictEqual({ ...again, createdAt: null }, { secretEnc: 'v1.d.e.f', keyId: 'kid2', confirmedAt: null, lastStep: null, createdAt: null });
  });

  it('put never overwrites a confirmed row', async () => {
    assert.strictEqual(await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid1'), true);
    await store.confirm(ALICE, 'totp');
    await store.acceptStep(ALICE, 'totp', 5);
    const before = await store.get(ALICE, 'totp');
    assert.strictEqual(await store.put(ALICE, 'totp', 'v1.d.e.f', 'kid2'), false);
    assert.deepStrictEqual(await store.get(ALICE, 'totp'), before);
    await store.remove(ALICE, 'totp');
    assert.strictEqual(await store.put(ALICE, 'totp', 'v1.d.e.f', 'kid2'), true);
  });

  it('keeps rows apart by identity and step', async () => {
    await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid');
    assert.strictEqual(await store.get(BOB, 'totp'), null);
    assert.strictEqual(await store.get(ALICE, 'webauthn'), null);
  });

  it('a returned record does not change the stored row', async () => {
    await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid');
    const r = (await store.get(ALICE, 'totp')) as { secretEnc: string };
    assert.throws(() => {
      r.secretEnc = 'x';
    });
    assert.strictEqual((await store.get(ALICE, 'totp'))?.secretEnc, 'v1.a.b.c');
  });

  it('does not mix up an identity and a step that hold "|"', async () => {
    await store.put({ type: 'user', id: 'a|b' }, 'c', 'v1.a.b.c', 'kid');
    assert.strictEqual(await store.get({ type: 'user', id: 'a' }, 'b|c'), null);
  });

  it('hands out copies of its dates', async () => {
    await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid');
    const at = new Date('2026-10-04T10:00:00Z');
    await store.confirm(ALICE, 'totp', at);
    at.setTime(0);
    const r = await store.get(ALICE, 'totp');
    assert.ok(r?.confirmedAt);
    r.confirmedAt.setTime(0);
    r.createdAt.setTime(0);
    const again = await store.get(ALICE, 'totp');
    assert.strictEqual(again?.confirmedAt?.toISOString(), '2026-10-04T10:00:00.000Z');
    assert.notStrictEqual(again?.createdAt.getTime(), 0);
  });

  it('confirm refuses an invalid date', async () => {
    await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid');
    await assert.rejects(store.confirm(ALICE, 'totp', new Date(Number.NaN)), InvalidArgument);
    await assert.rejects(store.confirm(ALICE, 'totp', 'now' as unknown as Date), InvalidArgument);
    assert.strictEqual((await store.get(ALICE, 'totp'))?.confirmedAt, null);
  });

  it('confirm sets confirmedAt and answers whether the row exists', async () => {
    assert.strictEqual(await store.confirm(ALICE, 'totp'), false);
    await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid');
    const at = new Date('2026-10-04T10:00:00Z');
    assert.strictEqual(await store.confirm(ALICE, 'totp', at), true);
    assert.strictEqual((await store.get(ALICE, 'totp'))?.confirmedAt?.getTime(), at.getTime());
  });

  it('acceptStep is true once per step and never at or below the last accepted one', async () => {
    assert.strictEqual(await store.acceptStep(ALICE, 'totp', 10), false, 'no row');
    await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid');
    assert.strictEqual(await store.acceptStep(ALICE, 'totp', 10), true);
    assert.strictEqual(await store.acceptStep(ALICE, 'totp', 10), false, 'the same step');
    assert.strictEqual(await store.acceptStep(ALICE, 'totp', 9), false, 'an older step');
    assert.strictEqual(await store.acceptStep(ALICE, 'totp', 12), true);
    assert.strictEqual((await store.get(ALICE, 'totp'))?.lastStep, 12);
    assert.strictEqual(await store.acceptStep(ALICE, 'totp', 11), false);
    assert.strictEqual(await store.acceptStep(ALICE, 'totp', 0), false);
  });

  it('acceptStep refuses a time step that is not a non-negative safe integer', async () => {
    await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid');
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '3' as unknown as number]) {
      await assert.rejects(store.acceptStep(ALICE, 'totp', bad), InvalidArgument, String(bad));
    }
  });

  it('remove deletes the row only', async () => {
    await store.put(ALICE, 'totp', 'v1.a.b.c', 'kid');
    await store.replaceRecoveryCodes(ALICE, ['AAAA']);
    await store.remove(ALICE, 'totp');
    assert.strictEqual(await store.get(ALICE, 'totp'), null);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 1);
    await store.remove(ALICE, 'totp');
  });

  it('put refuses an empty secret, key id or step', async () => {
    await assert.rejects(store.put(ALICE, 'totp', '', 'kid'), InvalidArgument);
    await assert.rejects(store.put(ALICE, 'totp', 'v1.a.b.c', ''), InvalidArgument);
    await assert.rejects(store.put(ALICE, '', 'v1.a.b.c', 'kid'), InvalidArgument);
    await assert.rejects(store.put({ type: 'u:x', id: '1' }, 'totp', 'v1.a.b.c', 'kid'), InvalidArgument);
  });

  it('stores recovery codes as SHA-256 hex only', async () => {
    const codes = ['AAAABBBBCCCCDDDD', 'EEEEFFFFGGGGHHHH'];
    await store.replaceRecoveryCodes(ALICE, codes);
    const stored = store.recoveryCodeHashes(ALICE);
    assert.deepStrictEqual([...stored].sort(), codes.map(sha256).sort());
    for (const code of codes) {
      assert.ok(!stored.some((s) => s.includes(code)));
    }
    assert.deepStrictEqual(store.recoveryCodeHashes(BOB), []);
  });

  it('redeemRecoveryCode is single use', async () => {
    await store.replaceRecoveryCodes(ALICE, ['AAAA', 'BBBB']);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 2);
    assert.strictEqual(await store.redeemRecoveryCode(ALICE, 'AAAA'), true);
    assert.strictEqual(await store.redeemRecoveryCode(ALICE, 'AAAA'), false);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 1);
    assert.strictEqual(await store.redeemRecoveryCode(BOB, 'BBBB'), false, "another identity's code");
    assert.strictEqual(await store.redeemRecoveryCode(ALICE, 'CCCC'), false);
    assert.strictEqual(await store.redeemRecoveryCode(ALICE, ''), false);
  });

  it('replaceRecoveryCodes voids the old set', async () => {
    await store.replaceRecoveryCodes(ALICE, ['AAAA', 'BBBB']);
    await store.replaceRecoveryCodes(ALICE, ['CCCC']);
    assert.strictEqual(await store.redeemRecoveryCode(ALICE, 'AAAA'), false);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 1);
    await store.replaceRecoveryCodes(ALICE, []);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 0);
  });

  it('replaceRecoveryCodes refuses empty or repeated codes and keeps the old set', async () => {
    await store.replaceRecoveryCodes(ALICE, ['AAAA']);
    await assert.rejects(store.replaceRecoveryCodes(ALICE, ['BBBB', '']), InvalidArgument);
    await assert.rejects(store.replaceRecoveryCodes(ALICE, ['BBBB', 'BBBB']), InvalidArgument);
    await assert.rejects(store.replaceRecoveryCodes(ALICE, 'AAAA' as unknown as string[]), InvalidArgument);
    assert.strictEqual(await store.redeemRecoveryCode(ALICE, 'AAAA'), true);
  });

  it('removeRecoveryCodes deletes every code of the identity', async () => {
    await store.replaceRecoveryCodes(ALICE, ['AAAA', 'BBBB']);
    await store.replaceRecoveryCodes(BOB, ['AAAA']);
    await store.removeRecoveryCodes(ALICE);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 0);
    assert.strictEqual(await store.countRecoveryCodes(BOB), 1);
  });
});
