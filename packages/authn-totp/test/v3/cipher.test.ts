import 'mocha';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { decryptMfaSecret, encryptMfaSecret, mfaKeyFrom, mfaKeyRingFrom, MfaKeyRing } from '../../src/cipher/index.js';
import { encryptMfaSecretWithIv } from '../../src/cipher/cipher.js';

const RAW = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const HEX = RAW.toString('hex');
const ALICE = 'user:00000000-0000-4000-8000-000000000001';
const BOB = 'user:00000000-0000-4000-8000-000000000002';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Shared with N4 (authn-orm D8): the same inputs must give these exact bytes. */
const VECTOR = {
  key: HEX,
  iv: 'a0a1a2a3a4a5a6a7a8a9aaab',
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

describe('v3 cipher: mfaKeyFrom', () => {
  it('reads 64 hex, base64 (44) and base64url (43) as the same key', () => {
    const b64 = RAW.toString('base64');
    const b64url = RAW.toString('base64url');
    assert.strictEqual(b64.length, 44);
    assert.strictEqual(b64url.length, 43);
    for (const text of [HEX, HEX.toUpperCase(), b64, b64url, b64.replace(/=$/, '')]) {
      assert.ok(mfaKeyFrom(text).key.equals(RAW), text);
    }
  });

  it('gives the first 16 chars of base64url(SHA-256(key)) as the key id', () => {
    const expected = createHash('sha256').update(RAW).digest('base64url').slice(0, 16);
    assert.strictEqual(mfaKeyFrom(HEX).keyId, expected);
    assert.match(expected, /^[A-Za-z0-9_-]{16}$/);
    assert.notStrictEqual(mfaKeyFrom(randomBytes(32).toString('hex')).keyId, expected);
  });

  it('refuses anything that is not 32 bytes in one of the three forms', () => {
    const bad: unknown[] = ['', 'a'.repeat(32), HEX.slice(0, 63), HEX.slice(0, 62), HEX + '00', 'g'.repeat(64), randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), randomBytes(24).toString('base64url'), ` ${RAW.toString('base64url')}`, `${HEX}\n`, null, undefined, 42, RAW];
    for (const text of bad) {
      assert.throws(() => mfaKeyFrom(text as string), InvalidOption, inspect(text));
    }
  });

  it('refuses a base64 text whose last character carries spare bits', () => {
    const canonical = RAW.toString('base64url');
    assert.strictEqual(canonical.at(-1), '8');
    const loose = canonical.slice(0, -1) + '9';
    for (const text of [loose, loose + '=']) {
      assert.throws(() => mfaKeyFrom(text), InvalidOption, text);
    }
    assert.ok(mfaKeyFrom(canonical + '=').key.equals(RAW));
  });

  it('keeps the key out of errors, inspection and JSON', () => {
    const short = HEX.slice(0, 62);
    assert.throws(
      () => mfaKeyFrom(short),
      (e: Error) => !e.message.includes(short),
    );
    assert.ok(!inspect(mfaKeyFrom(HEX), { depth: 5 }).includes(HEX));
    assert.ok(!JSON.stringify(mfaKeyFrom(HEX)).includes(HEX));
  });
});

describe('v3 cipher: encrypt and decrypt', () => {
  const key = mfaKeyFrom(HEX);

  it('round-trips as v1.<iv>.<tag>.<ct> in base64url', () => {
    const enc = encryptMfaSecret(key, ALICE, 'totp', SECRET);
    const parts = enc.split('.');
    assert.strictEqual(parts.length, 4);
    assert.strictEqual(parts[0], 'v1');
    for (const p of parts.slice(1)) {
      assert.match(p, /^[A-Za-z0-9_-]+$/);
    }
    assert.strictEqual(Buffer.from(parts[1], 'base64url').length, 12);
    assert.strictEqual(Buffer.from(parts[2], 'base64url').length, 16);
    assert.strictEqual(decryptMfaSecret(key, ALICE, 'totp', enc), SECRET);
    assert.notStrictEqual(encryptMfaSecret(key, ALICE, 'totp', SECRET), enc, 'a fresh IV each time');
  });

  it('takes the identity as an IdentityRef or as its key', () => {
    const enc = encryptMfaSecret(key, { type: 'user', id: ALICE.slice(5) }, 'totp', SECRET);
    assert.strictEqual(decryptMfaSecret(key, ALICE, 'totp', enc), SECRET);
  });

  it('matches the pinned test vector', () => {
    const k = mfaKeyFrom(VECTOR.key);
    assert.strictEqual(k.keyId, VECTOR.keyId);
    assert.strictEqual(encryptMfaSecretWithIv(k, VECTOR.identity, VECTOR.step, VECTOR.plain, Buffer.from(VECTOR.iv, 'hex')), VECTOR.enc);
    assert.strictEqual(decryptMfaSecret(k, VECTOR.identity, VECTOR.step, VECTOR.enc), VECTOR.plain);
  });

  it('throws under another key', () => {
    const enc = encryptMfaSecret(key, ALICE, 'totp', SECRET);
    assert.throws(() => decryptMfaSecret(mfaKeyFrom(randomBytes(32).toString('hex')), ALICE, 'totp', enc), InvalidArgument);
  });

  it("throws for another row's AAD: another identity or step", () => {
    const enc = encryptMfaSecret(key, ALICE, 'totp', SECRET);
    assert.throws(() => decryptMfaSecret(key, BOB, 'totp', enc), InvalidArgument);
    assert.throws(() => decryptMfaSecret(key, ALICE, 'webauthn', enc), InvalidArgument);
  });

  it('refuses a step that is empty or holds "|"', () => {
    assert.throws(() => encryptMfaSecret(key, ALICE, 'a|b', SECRET), InvalidArgument);
    assert.throws(() => encryptMfaSecret(key, ALICE, '', SECRET), InvalidArgument);
    assert.throws(() => encryptMfaSecret(key, ALICE, 'totp', ''), InvalidArgument);
  });

  it('throws on a tampered IV, tag or cipher text', () => {
    const enc = encryptMfaSecret(key, ALICE, 'totp', SECRET);
    for (const part of [1, 2, 3] as const) {
      assert.throws(() => decryptMfaSecret(key, ALICE, 'totp', tamper(enc, part)), InvalidArgument, `part ${part}`);
    }
  });

  it('throws on an unknown version or a malformed text', () => {
    const [, iv, tag, ct] = encryptMfaSecret(key, ALICE, 'totp', SECRET).split('.');
    const shortIv = Buffer.from(iv, 'base64url').subarray(0, 8).toString('base64url');
    for (const bad of ['', 'v1', `v2.${iv}.${tag}.${ct}`, `V1.${iv}.${tag}.${ct}`, `v1.${iv}.${tag}`, `v1.${iv}.${tag}.${ct}.x`, `v1.${shortIv}.${tag}.${ct}`, `v1.${iv}.${tag}.`, `v1.${iv}+.${tag}.${ct}`, 42 as unknown as string]) {
      assert.throws(() => decryptMfaSecret(key, ALICE, 'totp', bad), InvalidArgument, inspect(bad));
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
    for (const bad of [undefined, null, {}, { secret: '' }, { secret: HEX, previous: 'x' }, { secret: HEX, previous: ['short'] }, { secret: HEX, previous: [42] }]) {
      assert.throws(() => mfaKeyRingFrom(bad as never), InvalidOption, inspect(bad));
    }
  });

  it('is a MfaKeyRing', () => {
    assert.ok(mfaKeyRingFrom({ secret: HEX }) instanceof MfaKeyRing);
  });
});
