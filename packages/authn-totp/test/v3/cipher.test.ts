import 'mocha';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { decryptMfaSecret, encryptMfaSecret, mfaKeyFrom } from '@spinajs/authn-orm';
import * as cipher from '../../src/cipher/index.js';
import { mfaKeyRingFrom, MfaKeyRing } from '../../src/cipher/index.js';

const RAW = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const HEX = RAW.toString('hex');
const ALICE = 'user:00000000-0000-4000-8000-000000000001';
const BOB = 'user:00000000-0000-4000-8000-000000000002';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Pinned in N5 task 1 from plain `node:crypto` (IV a0a1…ab) and handed to N4 (authn-orm D8). */
const VECTOR = {
  key: HEX,
  identity: ALICE,
  step: 'totp',
  plain: SECRET,
  keyId: 'Yw3NKWbEM2aRElRI',
  enc: 'v1.oKGio6Slpqeoqaqr.4UHVLAg2-yMXhWnJrrLEgQ.rFovehz4Ru8nLdeYNCqYjjruCkfLhAY82UZ2zUz7LVE',
};

function tamper(enc: string, part: 1 | 2 | 3): string {
  const parts = enc.split('.');
  const bytes = Buffer.from(parts[part], 'base64url');
  bytes[0] ^= 0x01;
  parts[part] = bytes.toString('base64url');
  return parts.join('.');
}

describe('v3 cipher: authn-orm format', () => {
  it("authn-orm's cipher decrypts the pinned test vector", () => {
    const k = mfaKeyFrom(VECTOR.key);
    assert.strictEqual(k.keyId, VECTOR.keyId);
    assert.strictEqual(decryptMfaSecret(k, VECTOR.identity, VECTOR.step, VECTOR.enc), VECTOR.plain);
  });

  it('the ring decrypts the pinned test vector', () => {
    assert.strictEqual(mfaKeyRingFrom({ secret: VECTOR.key }).decrypt(VECTOR.identity, VECTOR.step, VECTOR.enc, VECTOR.keyId), VECTOR.plain);
  });

  it('the ring reads what the authn-orm migration writes, and authn-orm reads what the ring writes', () => {
    const key = mfaKeyFrom(HEX);
    const migrated = encryptMfaSecret(key, ALICE, 'totp', SECRET);
    const ring = mfaKeyRingFrom({ secret: HEX });
    assert.strictEqual(ring.decrypt(ALICE, 'totp', migrated, key.keyId), SECRET);

    const { secretEnc, keyId } = ring.encrypt({ type: 'user', id: ALICE.slice(5) }, 'totp', SECRET);
    assert.strictEqual(keyId, key.keyId);
    assert.strictEqual(decryptMfaSecret(key, ALICE, 'totp', secretEnc), SECRET);
    assert.notStrictEqual(ring.encrypt(ALICE, 'totp', SECRET).secretEnc, secretEnc, 'a fresh IV each time');
  });

  it("the ring throws for another row's AAD and a tampered text", () => {
    const ring = mfaKeyRingFrom({ secret: HEX });
    const { secretEnc, keyId } = ring.encrypt(ALICE, 'totp', SECRET);
    assert.throws(() => ring.decrypt(BOB, 'totp', secretEnc, keyId), InvalidArgument);
    assert.throws(() => ring.decrypt(ALICE, 'webauthn', secretEnc, keyId), InvalidArgument);
    for (const part of [1, 2, 3] as const) {
      assert.throws(() => ring.decrypt(ALICE, 'totp', tamper(secretEnc, part), keyId), InvalidArgument, `part ${part}`);
    }
  });

  it("exports no cipher function under authn-orm's names", () => {
    for (const name of ['mfaKeyFrom', 'encryptMfaSecret', 'decryptMfaSecret', 'encryptMfaSecretWithIv']) {
      assert.ok(!(name in cipher), name);
    }
  });
});

describe('v3 cipher: key ring', () => {
  const OLD = randomBytes(32).toString('hex');

  it('encrypts under the current key and decrypts a row under a previous one', () => {
    const before = mfaKeyRingFrom({ secret: OLD });
    const { secretEnc, keyId } = before.encrypt(ALICE, 'totp', SECRET);
    assert.strictEqual(keyId, mfaKeyFrom(OLD).keyId);

    const after = mfaKeyRingFrom({ secret: HEX, previous: [OLD] });
    assert.strictEqual(after.current.keyId, mfaKeyFrom(HEX).keyId);
    assert.strictEqual(after.decrypt(ALICE, 'totp', secretEnc, keyId), SECRET);
    const fresh = after.encrypt(ALICE, 'totp', SECRET);
    assert.strictEqual(fresh.keyId, after.current.keyId);
    assert.strictEqual(after.decrypt(ALICE, 'totp', fresh.secretEnc, fresh.keyId), SECRET);
  });

  it('reads the key as 64 hex, base64 or base64url', () => {
    for (const text of [HEX, HEX.toUpperCase(), RAW.toString('base64'), RAW.toString('base64url'), RAW.toString('base64').replace(/=$/, '')]) {
      assert.strictEqual(mfaKeyRingFrom({ secret: text }).current.keyId, VECTOR.keyId, text);
    }
  });

  it('refuses a base64 key whose last character carries spare bits', () => {
    const canonical = RAW.toString('base64url');
    const loose = canonical.slice(0, -1) + '9';
    for (const text of [loose, loose + '=']) {
      assert.throws(() => mfaKeyRingFrom({ secret: text }), InvalidOption, text);
    }
  });

  it('throws for a row under an unknown key id', () => {
    const { secretEnc, keyId } = mfaKeyRingFrom({ secret: OLD }).encrypt(ALICE, 'totp', SECRET);
    assert.throws(() => mfaKeyRingFrom({ secret: HEX }).decrypt(ALICE, 'totp', secretEnc, keyId), InvalidArgument);
  });

  it('throws when the key id names a key the text was not encrypted under', () => {
    const ring = mfaKeyRingFrom({ secret: HEX, previous: [OLD] });
    const { secretEnc } = ring.encrypt(ALICE, 'totp', SECRET);
    assert.throws(() => ring.decrypt(ALICE, 'totp', secretEnc, mfaKeyFrom(OLD).keyId), InvalidArgument);
  });

  it('refuses a missing secret or a malformed previous list', () => {
    for (const bad of [undefined, null, {}, { secret: '' }, { secret: 'short' }, { secret: HEX, previous: 'x' }, { secret: HEX, previous: ['short'] }, { secret: HEX, previous: [42] }]) {
      assert.throws(() => mfaKeyRingFrom(bad as never), InvalidOption, inspect(bad));
    }
  });

  it('names a bad previous key by its position, never by its value', () => {
    const short = HEX.slice(0, 62);
    assert.throws(
      () => mfaKeyRingFrom({ secret: HEX, previous: [OLD, short] }),
      (e: Error) => e instanceof InvalidOption && e.message.includes('authn.mfa.encryptionKey.previous[1]') && !e.message.includes(short),
    );
  });

  it('keeps the key out of inspection and JSON', () => {
    const ring = mfaKeyRingFrom({ secret: HEX });
    assert.ok(!Object.keys(ring.current).includes('key'));
    assert.ok(!inspect(ring, { depth: 5 }).includes('<Buffer'));
    assert.ok(!('key' in JSON.parse(JSON.stringify(ring.current))));
    assert.ok(ring.current.key.equals(RAW), 'the key is still there, only hidden');
  });

  it('is a MfaKeyRing', () => {
    assert.ok(mfaKeyRingFrom({ secret: HEX }) instanceof MfaKeyRing);
  });
});
