import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { expect } from 'chai';
import 'mocha';

import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { decryptMfaSecret, encryptMfaSecret, mfaKeyFrom } from '../src/index.js';

const RAW = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const HEX = RAW.toString('hex');
const B64 = RAW.toString('base64');
const B64URL = RAW.toString('base64url');
const ALICE = 'user:0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10';
const BOB = 'user:5e0d7f3a-2b44-4d8e-a1c9-6f2e8b3d0c21';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const b64url = (b: Buffer): string => b.toString('base64url');

/** Flips one bit of one base64url part of a `v1.<iv>.<tag>.<ct>` text. */
function tamper(enc: string, part: 1 | 2 | 3): string {
  const parts = enc.split('.');
  const bytes = Buffer.from(parts[part], 'base64url');
  bytes[0] ^= 0x01;
  parts[part] = b64url(bytes);
  return parts.join('.');
}

describe('MFA cipher (D8)', () => {
  describe('mfaKeyFrom', () => {
    it('reads 64 hex characters, base64 (44) and base64url (43) as the same key', () => {
      expect(B64).to.have.length(44);
      expect(B64URL).to.have.length(43);
      for (const text of [HEX, HEX.toUpperCase(), B64, B64URL]) {
        expect(mfaKeyFrom(text).key.equals(RAW), text).to.eq(true);
      }
    });

    it('gives the first 16 characters of base64url(SHA-256(key)) as the key id, stable across formats', () => {
      const expected = createHash('sha256').update(RAW).digest('base64url').slice(0, 16);
      for (const text of [HEX, B64, B64URL]) {
        expect(mfaKeyFrom(text).keyId).to.eq(expected);
      }
      expect(mfaKeyFrom(randomBytes(32).toString('hex')).keyId).to.not.eq(expected);
    });

    it('refuses anything that is not exactly 32 bytes in one of the three forms', () => {
      const bad: unknown[] = ['', HEX.slice(0, 62), HEX + '00', 'g'.repeat(64), randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), randomBytes(31).toString('base64url'), randomBytes(24).toString('base64'), ` ${B64URL}`, `${HEX}\n`, B64URL.slice(0, 42) + '!', B64.slice(0, 42) + '==', null, undefined, 42, RAW];
      for (const text of bad) {
        expect(() => mfaKeyFrom(text as string), inspect(text)).to.throw(InvalidOption);
      }
    });

    it('never puts the secret in its error or in an inspected key', () => {
      const short = HEX.slice(0, 62);
      let message = '';
      try {
        mfaKeyFrom(short);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).to.not.eq('');
      expect(message).to.not.contain(short);
      expect(inspect(mfaKeyFrom(HEX), { depth: 5 })).to.not.contain(HEX);
      expect(JSON.stringify(mfaKeyFrom(HEX))).to.not.contain(HEX);
    });
  });

  describe('encryptMfaSecret / decryptMfaSecret', () => {
    const key = mfaKeyFrom(HEX);

    it('round-trips and writes v1.<iv>.<tag>.<ct> in base64url with a 12-byte IV and a 16-byte tag', () => {
      const enc = encryptMfaSecret(key, ALICE, 'totp', SECRET);

      const parts = enc.split('.');
      expect(parts).to.have.length(4);
      expect(parts[0]).to.eq('v1');
      for (const p of parts.slice(1)) {
        expect(p).to.match(/^[A-Za-z0-9_-]+$/);
      }
      expect(Buffer.from(parts[1], 'base64url')).to.have.length(12);
      expect(Buffer.from(parts[2], 'base64url')).to.have.length(16);
      expect(Buffer.from(parts[3], 'base64url')).to.have.length(Buffer.byteLength(SECRET));
      expect(enc).to.not.contain(SECRET);
      expect(decryptMfaSecret(key, ALICE, 'totp', enc)).to.eq(SECRET);
    });

    it('uses a fresh IV each time', () => {
      const a = encryptMfaSecret(key, ALICE, 'totp', SECRET);
      const b = encryptMfaSecret(key, ALICE, 'totp', SECRET);
      expect(a).to.not.eq(b);
      expect(a.split('.')[1]).to.not.eq(b.split('.')[1]);
    });

    it('takes the identity as a column key or as an IdentityRef', () => {
      const enc = encryptMfaSecret(key, { type: 'user', id: ALICE.slice(5) }, 'totp', SECRET);
      expect(decryptMfaSecret(key, ALICE, 'totp', enc)).to.eq(SECRET);
    });

    it('round-trips UTF-8 text', () => {
      const plain = 'zażółć gęślą jaźń 🔑';
      expect(decryptMfaSecret(key, ALICE, 'totp', encryptMfaSecret(key, ALICE, 'totp', plain))).to.eq(plain);
    });

    it('throws under another key', () => {
      const enc = encryptMfaSecret(key, ALICE, 'totp', SECRET);
      expect(() => decryptMfaSecret(mfaKeyFrom(randomBytes(32).toString('hex')), ALICE, 'totp', enc)).to.throw(InvalidArgument);
    });

    it("throws for another row's AAD: another identity or another step", () => {
      const enc = encryptMfaSecret(key, ALICE, 'totp', SECRET);
      expect(() => decryptMfaSecret(key, BOB, 'totp', enc)).to.throw(InvalidArgument);
      expect(() => decryptMfaSecret(key, ALICE, 'webauthn', enc)).to.throw(InvalidArgument);
    });

    it('refuses a step containing "|", so the AAD `${identity}|${step}` names one row only', () => {
      const enc = encryptMfaSecret(key, 'user:a|b', 'c', SECRET);
      expect(decryptMfaSecret(key, 'user:a|b', 'c', enc)).to.eq(SECRET);
      expect(() => decryptMfaSecret(key, 'user:a', 'b|c', enc)).to.throw(InvalidArgument);
      expect(() => encryptMfaSecret(key, 'user:a', 'b|c', SECRET)).to.throw(InvalidArgument);
      expect(() => encryptMfaSecret(key, ALICE, '', SECRET)).to.throw(InvalidArgument);
    });

    it('throws on a tampered IV, tag or cipher text', () => {
      const enc = encryptMfaSecret(key, ALICE, 'totp', SECRET);
      for (const part of [1, 2, 3] as const) {
        expect(() => decryptMfaSecret(key, ALICE, 'totp', tamper(enc, part)), `part ${part}`).to.throw(InvalidArgument);
      }
    });

    it('throws on a malformed text: wrong version, part count, IV or tag length', () => {
      const enc = encryptMfaSecret(key, ALICE, 'totp', SECRET);
      const [, iv, tag, ct] = enc.split('.');
      const shortTag = b64url(Buffer.from(tag, 'base64url').subarray(0, 12));
      const shortIv = b64url(Buffer.from(iv, 'base64url').subarray(0, 8));
      for (const bad of ['', 'v1', `v2.${iv}.${tag}.${ct}`, `v1.${iv}.${tag}`, `v1.${iv}.${tag}.${ct}.x`, `v1.${shortIv}.${tag}.${ct}`, `v1.${iv}.${shortTag}.${ct}`, `v1.${iv}.${tag}.`, `v1.${iv}+.${tag}.${ct}`, 42 as unknown as string]) {
        expect(() => decryptMfaSecret(key, ALICE, 'totp', bad), inspect(bad)).to.throw(InvalidArgument);
      }
    });

    it('refuses an empty secret', () => {
      expect(() => encryptMfaSecret(key, ALICE, 'totp', '')).to.throw(InvalidArgument);
    });
  });
});
