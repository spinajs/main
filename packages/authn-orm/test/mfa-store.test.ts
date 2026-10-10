import { FakeClock } from '@spinajs/authn-testing';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { createHash } from 'node:crypto';

import { DbMfaStore } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const T0 = new Date('2026-06-01T10:00:00.000Z');
const ALICE: IdentityRef = { type: 'user', id: '0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10' };
const BOB: IdentityRef = { type: 'user', id: '5e0d7f3a-2b44-4d8e-a1c9-6f2e8b3d0c21' };
const CIPHER = 'v1.AAECAwQFBgcICQoL.DA0ODxAREhMUFRYXGBkaGw.HB0eHyAhIiMkJSYn';
const CODES = Array.from({ length: 10 }, (_, i) => `rc${i}-${createHash('sha256').update(`code-${i}`).digest('hex').slice(0, 10)}`);

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

for (const kind of DB_KINDS) {
  describe(`DbMfaStore (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let clock: FakeClock;
    let store: DbMfaStore;

    before(async function () {
      db = await bootDb(this, kind, 'mfa_store');
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authn_mfa', [], QueryContext.Delete);
      await rawQuery(db.driver, 'DELETE FROM authn_recovery_code', [], QueryContext.Delete);
      clock = new FakeClock(T0);
      clock.install();
      store = new DbMfaStore(db.driver);
    });

    afterEach(() => {
      clock.uninstall();
    });

    it('round-trips put and get, storing the cipher text as given', async () => {
      expect(await store.get(ALICE, 'totp')).to.eq(null);

      await store.put(ALICE, 'totp', CIPHER, 'kid-0123456789ab');

      expect(await store.get(ALICE, 'totp')).to.deep.eq({ secretEnc: CIPHER, keyId: 'kid-0123456789ab', confirmedAt: null, lastStep: null, createdAt: T0 });
      expect(await store.get(BOB, 'totp')).to.eq(null);
      expect(await store.get(ALICE, 'webauthn')).to.eq(null);
      const rows = (await rawQuery(db.driver, 'SELECT identity, step, secret_enc, key_id FROM authn_mfa')) as Record<string, unknown>[];
      expect(rows).to.deep.eq([{ identity: `user:${ALICE.id}`, step: 'totp', secret_enc: CIPHER, key_id: 'kid-0123456789ab' }]);
    });

    it('confirm sets confirmedAt; put replaces the row and clears confirmation and the last step', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      const confirmed = new Date(T0.getTime() + 30_250);
      expect(await store.confirm(ALICE, 'totp', confirmed)).to.eq(true);
      expect(await store.acceptStep(ALICE, 'totp', 1000)).to.eq(true);
      expect(await store.get(ALICE, 'totp')).to.deep.include({ confirmedAt: confirmed, lastStep: 1000 });

      clock.tick(60_000);
      await store.put(ALICE, 'totp', 'v1.other', 'kid-b');

      expect(await store.get(ALICE, 'totp')).to.deep.eq({ secretEnc: 'v1.other', keyId: 'kid-b', confirmedAt: null, lastStep: null, createdAt: new Date(T0.getTime() + 60_000) });
      expect(await store.confirm(BOB, 'totp')).to.eq(false);
    });

    it('confirm without an expected cipher text still confirms a confirmed row again', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      expect(await store.confirm(ALICE, 'totp', T0)).to.eq(true);
      const later = new Date(T0.getTime() + 1000);
      expect(await store.confirm(ALICE, 'totp', later)).to.eq(true);
      expect((await store.get(ALICE, 'totp'))?.confirmedAt).to.deep.eq(later);
    });

    it('putPending inserts an unconfirmed row and replaces a pending one', async () => {
      expect(await store.putPending(ALICE, 'totp', CIPHER, 'kid-a')).to.eq(true);
      expect(await store.get(ALICE, 'totp')).to.deep.eq({ secretEnc: CIPHER, keyId: 'kid-a', confirmedAt: null, lastStep: null, createdAt: T0 });
      expect(await store.acceptStep(ALICE, 'totp', 1000)).to.eq(true);

      clock.tick(60_000);
      expect(await store.putPending(ALICE, 'totp', 'v1.other', 'kid-b')).to.eq(true);

      expect(await store.get(ALICE, 'totp')).to.deep.eq({ secretEnc: 'v1.other', keyId: 'kid-b', confirmedAt: null, lastStep: null, createdAt: new Date(T0.getTime() + 60_000) });
      expect(await rawQuery(db.driver, 'SELECT step FROM authn_mfa')).to.have.length(1);
    });

    it('putPending over a confirmed row is false and changes nothing', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      expect(await store.confirm(ALICE, 'totp', T0)).to.eq(true);
      expect(await store.acceptStep(ALICE, 'totp', 1000)).to.eq(true);
      const before = await store.get(ALICE, 'totp');

      clock.tick(60_000);
      expect(await store.putPending(ALICE, 'totp', 'v1.other', 'kid-b')).to.eq(false);

      expect(await store.get(ALICE, 'totp')).to.deep.eq(before);
      await store.remove(ALICE, 'totp');
      expect(await store.putPending(ALICE, 'totp', 'v1.other', 'kid-b')).to.eq(true);
    });

    it('putPending refuses bad arguments as put does', async () => {
      for (const call of [() => store.putPending(ALICE, '', CIPHER, 'kid'), () => store.putPending(ALICE, 'totp', '', 'kid'), () => store.putPending(ALICE, 'totp', CIPHER, 'k'.repeat(33))]) {
        expect(await rejection(call())).to.be.instanceOf(InvalidArgument);
      }
      expect(await rawQuery(db.driver, 'SELECT step FROM authn_mfa')).to.deep.eq([]);
    });

    it('leaves one row after 20 parallel putPending calls', async () => {
      const texts = Array.from({ length: 20 }, (_, i) => `v1.parallel-${i}`);
      const results = await Promise.all(texts.map((t) => store.putPending(ALICE, 'totp', t, 'kid-a')));
      expect(results.every((r) => r)).to.eq(true);
      const rows = (await rawQuery(db.driver, 'SELECT secret_enc, confirmed_at FROM authn_mfa')) as Record<string, unknown>[];
      expect(rows).to.have.length(1);
      expect(texts).to.include(rows[0].secret_enc);
      expect(rows[0].confirmed_at).to.eq(null);
    });

    it('lets no parallel putPending replace a confirmed row', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      await store.confirm(ALICE, 'totp', T0);
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.putPending(ALICE, 'totp', `v1.parallel-${i}`, 'kid-b')));
      expect(results.some((r) => r)).to.eq(false);
      expect(await store.get(ALICE, 'totp')).to.deep.include({ secretEnc: CIPHER, keyId: 'kid-a', confirmedAt: T0 });
    });

    it('confirm with an expected cipher text is true once, for the row holding it', async () => {
      await store.putPending(ALICE, 'totp', CIPHER, 'kid-a');

      expect(await store.confirm(ALICE, 'totp', T0, 'v1.other')).to.eq(false);
      expect((await store.get(ALICE, 'totp'))?.confirmedAt).to.eq(null);
      expect(await store.confirm(ALICE, 'totp', T0, CIPHER)).to.eq(true);
      expect(await store.confirm(ALICE, 'totp', new Date(T0.getTime() + 1000), CIPHER)).to.eq(false);
      expect((await store.get(ALICE, 'totp'))?.confirmedAt).to.deep.eq(T0);
      expect(await store.confirm(BOB, 'totp', T0, CIPHER)).to.eq(false);
    });

    it('lets exactly one of 20 parallel conditional confirms win', async () => {
      await store.putPending(ALICE, 'totp', CIPHER, 'kid-a');
      const results = await Promise.all(Array.from({ length: 20 }, () => store.confirm(ALICE, 'totp', T0, CIPHER)));
      expect(results.filter((r) => r)).to.have.length(1);
    });

    it('confirm refuses an empty expected cipher text', async () => {
      await store.putPending(ALICE, 'totp', CIPHER, 'kid-a');
      expect(await rejection(store.confirm(ALICE, 'totp', T0, ''))).to.be.instanceOf(InvalidArgument);
      expect((await store.get(ALICE, 'totp'))?.confirmedAt).to.eq(null);
    });

    it('SR-15 acceptStep is true once per time step and refuses older steps', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');

      expect(await store.acceptStep(ALICE, 'totp', 1000)).to.eq(true);
      expect(await store.acceptStep(ALICE, 'totp', 1000)).to.eq(false);
      expect(await store.acceptStep(ALICE, 'totp', 999)).to.eq(false);
      expect(await store.acceptStep(ALICE, 'totp', 1001)).to.eq(true);
      expect((await store.get(ALICE, 'totp'))?.lastStep).to.eq(1001);
      expect(await store.acceptStep(BOB, 'totp', 5000)).to.eq(false);
    });

    it('lets exactly one of 20 parallel acceptStep calls of one step win', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      const results = await Promise.all(Array.from({ length: 20 }, () => store.acceptStep(ALICE, 'totp', 58_000_000)));
      expect(results.filter((r) => r)).to.have.length(1);
    });

    it('keeps a large time step exact as a number', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      const big = 2 ** 40 + 7;
      expect(await store.acceptStep(ALICE, 'totp', big)).to.eq(true);
      const r = await store.get(ALICE, 'totp');
      expect(r?.lastStep).to.be.a('number').and.eq(big);
    });

    it('remove deletes that step only', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      await store.put(ALICE, 'email', CIPHER, 'kid-a');
      await store.remove(ALICE, 'totp');
      expect(await store.get(ALICE, 'totp')).to.eq(null);
      expect(await store.get(ALICE, 'email')).to.not.eq(null);
    });

    it('throws InvalidArgument on bad arguments, never cutting them', async () => {
      const longId: IdentityRef = { type: 'user', id: 'x'.repeat(96) };
      const bad: (() => Promise<unknown>)[] = [() => store.put(ALICE, 's'.repeat(33), CIPHER, 'kid'), () => store.put(ALICE, '', CIPHER, 'kid'), () => store.put(longId, 'totp', CIPHER, 'kid'), () => store.put(ALICE, 'totp', '', 'kid'), () => store.put(ALICE, 'totp', CIPHER, 'k'.repeat(33)), () => store.get(longId, 'totp'), () => store.acceptStep(ALICE, 'totp', -1), () => store.acceptStep(ALICE, 'totp', 1.5), () => store.acceptStep(ALICE, 'totp', NaN), () => store.acceptStep(ALICE, 'totp', 2 ** 53), () => store.acceptStep(ALICE, 'totp', '7' as unknown as number), () => store.confirm(ALICE, 'totp', new Date(NaN)), () => store.replaceRecoveryCodes(ALICE, ['a', '']), () => store.replaceRecoveryCodes(ALICE, ['a', 'b', 'a']), () => store.replaceRecoveryCodes(longId, ['a'])];
      for (const [i, call] of bad.entries()) {
        expect(await rejection(call()), String(i)).to.be.instanceOf(InvalidArgument);
      }
      expect(await rawQuery(db.driver, 'SELECT step FROM authn_mfa')).to.deep.eq([]);
      expect(await rawQuery(db.driver, 'SELECT id FROM authn_recovery_code')).to.deep.eq([]);
    });

    it('SR-09 recovery codes are stored as SHA-256 only', async () => {
      await store.replaceRecoveryCodes(ALICE, CODES);

      const rows = (await rawQuery(db.driver, 'SELECT * FROM authn_recovery_code')) as Record<string, unknown>[];
      expect(rows.map((r) => r.code_hash).sort()).to.deep.eq(CODES.map(sha256hex).sort());
      expect(rows.every((r) => r.identity === `user:${ALICE.id}` && r.used_at === null)).to.eq(true);
      const text = JSON.stringify(rows);
      for (const code of CODES) {
        expect(text).to.not.contain(code);
      }
      expect(await store.countRecoveryCodes(ALICE)).to.eq(10);
    });

    it('redeems a recovery code once, for its identity only', async () => {
      await store.replaceRecoveryCodes(ALICE, CODES);

      expect(await store.redeemRecoveryCode(BOB, CODES[0])).to.eq(false);
      expect(await store.redeemRecoveryCode(ALICE, 'not-a-code')).to.eq(false);
      expect(await store.redeemRecoveryCode(ALICE, undefined as unknown as string)).to.eq(false);
      expect(await store.redeemRecoveryCode(ALICE, CODES[0])).to.eq(true);
      expect(await store.redeemRecoveryCode(ALICE, CODES[0])).to.eq(false);
      expect(await store.countRecoveryCodes(ALICE)).to.eq(9);
    });

    it('lets exactly one of 20 parallel redeems of one recovery code win', async () => {
      await store.replaceRecoveryCodes(ALICE, CODES);
      const results = await Promise.all(Array.from({ length: 20 }, () => store.redeemRecoveryCode(ALICE, CODES[3])));
      expect(results.filter((r) => r)).to.have.length(1);
      expect(await store.countRecoveryCodes(ALICE)).to.eq(9);
    });

    it('replaceRecoveryCodes voids the old set; removeRecoveryCodes deletes all', async () => {
      await store.replaceRecoveryCodes(ALICE, CODES);
      await store.replaceRecoveryCodes(BOB, ['bob-1']);
      await store.redeemRecoveryCode(ALICE, CODES[1]);

      await store.replaceRecoveryCodes(ALICE, ['new-1', 'new-2']);

      expect(await store.countRecoveryCodes(ALICE)).to.eq(2);
      expect(await store.redeemRecoveryCode(ALICE, CODES[2])).to.eq(false);
      expect(await store.redeemRecoveryCode(ALICE, 'new-2')).to.eq(true);
      await store.removeRecoveryCodes(ALICE);
      expect(await store.countRecoveryCodes(ALICE)).to.eq(0);
      expect(await store.countRecoveryCodes(BOB)).to.eq(1);
    });

    it('confirmedSteps lists the confirmed steps of that identity only; unconfirmed rows do not count', async () => {
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      await store.put(ALICE, 'webauthn', CIPHER, 'kid-a');
      await store.confirm(ALICE, 'webauthn');
      await store.put(BOB, 'email', CIPHER, 'kid-a');
      await store.confirm(BOB, 'email');

      expect(await store.confirmedSteps(ALICE)).to.deep.eq(['webauthn']);
      await store.confirm(ALICE, 'totp');
      expect([...(await store.confirmedSteps(ALICE))].sort()).to.deep.eq(['totp', 'webauthn']);
      expect(await store.confirmedSteps(BOB)).to.deep.eq(['email']);
      expect(await store.confirmedSteps({ type: 'user', id: 'nobody' })).to.deep.eq([]);
      expect(await store.confirmedSteps({ type: 'service', id: ALICE.id }), 'the type is part of the key').to.deep.eq([]);
      expect(await rejection(store.confirmedSteps({ type: 'user', id: 'x'.repeat(96) }))).to.be.instanceOf(InvalidArgument);
    });

    it('confirmedStepNames lists each confirmed step of the store once', async () => {
      expect(await store.confirmedStepNames()).to.deep.eq([]);
      await store.put(ALICE, 'totp', CIPHER, 'kid-a');
      await store.put(BOB, 'email', CIPHER, 'kid-a');
      expect(await store.confirmedStepNames(), 'unconfirmed rows only').to.deep.eq([]);
      await store.confirm(ALICE, 'totp');
      await store.put(BOB, 'totp', CIPHER, 'kid-a');
      await store.confirm(BOB, 'totp');
      expect(await store.confirmedStepNames()).to.deep.eq(['totp']);
      await store.confirm(BOB, 'email');
      expect([...(await store.confirmedStepNames())].sort()).to.deep.eq(['email', 'totp']);
    });

    it("resolves the Orm's default connection from its container when given no driver", async () => {
      const viaContainer = new DbMfaStore(undefined, { container: db.container });
      await viaContainer.put(ALICE, 'totp', CIPHER, 'kid-a');
      expect((await store.get(ALICE, 'totp'))?.secretEnc).to.eq(CIPHER);
    });
  });
}
