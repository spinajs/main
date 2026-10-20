import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';

import { base32Decode, base32Encode, decodeB64url, decodeBase64Strict, encodeB64url, hmacSha256, parseKeyMaterial, processSecret, randomToken, sha256, taggedHash, timingSafeEqualDigest, timingSafeEqualStr } from '../src/crypto/index.js';

const hex = (b: Buffer | null) => (b === null ? null : b.toString('hex'));
const utf8 = (b: Buffer | null) => (b === null ? null : b.toString('utf8'));

describe('crypto helpers', () => {
  describe('sha256', () => {
    it('matches the FIPS 180-2 vectors', () => {
      expect(sha256('abc')).to.equal('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(sha256('')).to.equal('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('encodes as hex, base64url or a buffer', () => {
      expect(sha256('abc', 'hex')).to.equal(sha256('abc'));
      expect(sha256('abc', 'base64url')).to.equal('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
      const raw = sha256('abc', 'buffer');
      expect(Buffer.isBuffer(raw)).to.be.true;
      expect(raw.toString('hex')).to.equal(sha256('abc'));
    });

    it('hashes strings as UTF-8 and bytes as given, honouring a view offset', () => {
      expect(sha256('zażółć')).to.equal(createHash('sha256').update(Buffer.from('zażółć', 'utf8')).digest('hex'));
      const backing = new Uint8Array([0, 0x61, 0x62, 0x63, 0]);
      expect(sha256(backing.subarray(1, 4))).to.equal(sha256('abc'));
    });

    it('rejects an unknown encoding or a non-binary input', () => {
      expect(() => sha256('abc', 'base64' as any)).to.throw(InvalidArgument);
      expect(() => sha256(42 as any)).to.throw(InvalidArgument);
    });
  });

  describe('hmacSha256', () => {
    it('matches RFC 4231 test case 2', () => {
      expect(hmacSha256('Jefe', 'what do ya want for nothing?')).to.equal('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    });

    it('takes byte keys and other encodings', () => {
      const key = Buffer.from('Jefe');
      expect(hmacSha256(key, 'what do ya want for nothing?', 'buffer').toString('hex')).to.equal('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
      expect(hmacSha256(key, 'x', 'base64url')).to.equal(Buffer.from(hmacSha256(key, 'x'), 'hex').toString('base64url'));
    });

    it('rejects a bad key, data or encoding', () => {
      expect(() => hmacSha256(null as any, 'x')).to.throw(InvalidArgument);
      expect(() => hmacSha256('k', {} as any)).to.throw(InvalidArgument);
      expect(() => hmacSha256('k', 'x', 'latin1' as any)).to.throw(InvalidArgument);
    });
  });

  describe('taggedHash', () => {
    it('is the prefix of SHA-256 over tag, NUL, value', () => {
      const logHash = (value: string) => createHash('sha256').update(`authn-http:log\0${value}`).digest('hex').slice(0, 16);
      expect(taggedHash('authn-http:log', 'session-id', 16)).to.equal(logHash('session-id'));
      expect(taggedHash('t', 'v')).to.equal(sha256('t\0v'));
      expect(taggedHash('t', 'v', 1)).to.have.length(1);
    });

    it('separates domains', () => {
      expect(taggedHash('a', 'value')).to.not.equal(taggedHash('b', 'value'));
    });

    it('rejects a bad tag, value or length', () => {
      expect(() => taggedHash('', 'v')).to.throw(InvalidArgument);
      expect(() => taggedHash('a\0b', 'v')).to.throw(InvalidArgument);
      expect(() => taggedHash(1 as any, 'v')).to.throw(InvalidArgument);
      expect(() => taggedHash('t', Buffer.from('v') as any)).to.throw(InvalidArgument);
      for (const len of [0, 65, 1.5, NaN]) {
        expect(() => taggedHash('t', 'v', len), String(len)).to.throw(InvalidArgument);
      }
    });
  });

  describe('timingSafeEqualStr', () => {
    it('compares UTF-8 bytes', () => {
      expect(timingSafeEqualStr('secret', 'secret')).to.be.true;
      expect(timingSafeEqualStr('', '')).to.be.true;
      expect(timingSafeEqualStr('secret', 'secreT')).to.be.false;
      expect(timingSafeEqualStr('secret', 'secret ')).to.be.false;
      expect(timingSafeEqualStr('é', 'é')).to.be.false;
    });

    it('is false for a non-string', () => {
      expect(timingSafeEqualStr(undefined as any, undefined as any)).to.be.false;
      expect(timingSafeEqualStr('1', 1 as any)).to.be.false;
    });
  });

  describe('timingSafeEqualDigest', () => {
    it('compares values of any length', () => {
      expect(timingSafeEqualDigest('token', 'token')).to.be.true;
      expect(timingSafeEqualDigest('token', 'token-longer')).to.be.false;
      expect(timingSafeEqualDigest('', 'x')).to.be.false;
      expect(timingSafeEqualDigest('token', Buffer.from('token'))).to.be.true;
    });

    it('is false for a non-binary value', () => {
      expect(timingSafeEqualDigest(undefined as any, undefined as any)).to.be.false;
      expect(timingSafeEqualDigest(['a'] as any, 'a')).to.be.false;
    });
  });

  describe('base64url', () => {
    it('matches the RFC 4648 vectors, unpadded', () => {
      const vectors: [string, string][] = [['', ''], ['f', 'Zg'], ['fo', 'Zm8'], ['foo', 'Zm9v'], ['foob', 'Zm9vYg'], ['fooba', 'Zm9vYmE'], ['foobar', 'Zm9vYmFy']];
      for (const [plain, encoded] of vectors) {
        expect(encodeB64url(plain)).to.equal(encoded);
        expect(encodeB64url(Buffer.from(plain))).to.equal(encoded);
        expect(utf8(decodeB64url(encoded))).to.equal(plain);
      }
      expect(encodeB64url(new Uint8Array([0xfb, 0xff]))).to.equal('-_8');
      expect(hex(decodeB64url('-_8'))).to.equal('fbff');
    });

    it('round-trips random bytes', () => {
      for (let n = 0; n < 40; n++) {
        const bytes = randomBytes(n);
        expect(hex(decodeB64url(encodeB64url(bytes)))).to.equal(bytes.toString('hex'));
      }
    });

    it('rejects anything but the one canonical form', () => {
      for (const bad of ['Zg==', 'Zh', 'Zm9=', 'Z', 'Zm9vY', 'Zm+v', 'Zm/v', 'Zm9 v', 'Zm9v\n', 'Zg=']) {
        expect(decodeB64url(bad), bad).to.be.null;
      }
      for (const bad of [undefined, null, 42, Buffer.from('Zg')]) {
        expect(decodeB64url(bad)).to.be.null;
      }
    });
  });

  describe('decodeBase64Strict', () => {
    it('decodes canonical padded base64', () => {
      expect(utf8(decodeBase64Strict(''))).to.equal('');
      expect(utf8(decodeBase64Strict('Zg=='))).to.equal('f');
      expect(utf8(decodeBase64Strict('Zm8='))).to.equal('fo');
      expect(utf8(decodeBase64Strict('Zm9vYmFy'))).to.equal('foobar');
      expect(hex(decodeBase64Strict('+/8='))).to.equal('fbff');
    });

    it('rejects unpadded, url-safe, stray-bit and malformed input', () => {
      for (const bad of ['Zg', 'Zm8', 'Zg=', 'Zh==', 'Zm9=', '-_8=', 'Zg==Zg==', '=', '====', 'Zm 9v', 'Z===']) {
        expect(decodeBase64Strict(bad), bad).to.be.null;
      }
      expect(decodeBase64Strict(undefined)).to.be.null;
      expect(decodeBase64Strict(42)).to.be.null;
    });
  });

  describe('base32', () => {
    const vectors: [string, string][] = [['', ''], ['f', 'MY======'], ['fo', 'MZXQ===='], ['foo', 'MZXW6==='], ['foob', 'MZXW6YQ='], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI======']];

    it('matches the RFC 4648 vectors, padded and unpadded', () => {
      for (const [plain, encoded] of vectors) {
        expect(base32Encode(plain, { pad: true })).to.equal(encoded);
        expect(base32Encode(Buffer.from(plain))).to.equal(encoded.replace(/=+$/, ''));
        expect(utf8(base32Decode(encoded))).to.equal(plain);
        expect(utf8(base32Decode(encoded.replace(/=+$/, '')))).to.equal(plain);
      }
    });

    it('round-trips random bytes', () => {
      for (let n = 0; n < 40; n++) {
        const bytes = randomBytes(n);
        expect(hex(base32Decode(base32Encode(bytes)))).to.equal(bytes.toString('hex'));
        expect(hex(base32Decode(base32Encode(bytes, { pad: true })))).to.equal(bytes.toString('hex'));
      }
    });

    it('encodes whole 5-byte groups like the recovery-code encoder', () => {
      const legacy = (bytes: Buffer) => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = 0;
        let acc = 0;
        let out = '';
        for (const byte of bytes) {
          acc = (acc << 8) | byte;
          bits += 8;
          while (bits >= 5) {
            bits -= 5;
            out += alphabet[(acc >> bits) & 31];
          }
        }
        return out;
      };
      for (let i = 0; i < 50; i++) {
        const bytes = randomBytes(10);
        expect(base32Encode(bytes)).to.equal(legacy(bytes));
      }
    });

    it('rejects lower case, stray bits, bad lengths and bad padding', () => {
      const bad = ['my======', 'my', 'MZ', 'MZ======', 'M', 'MZX', 'MZXW6Y', 'MY=====', 'MY=======', 'MZXW6YTB========', 'MY==A===', '=MY', 'M1', 'MZXW6YT8', 'MZXW 6YTB', 'MZXW6YTB\n'];
      for (const text of bad) {
        expect(base32Decode(text), text).to.be.null;
      }
      expect(base32Decode(undefined)).to.be.null;
      expect(base32Decode(42)).to.be.null;
    });

    it('strips padding in linear time', () => {
      const started = performance.now();
      expect(base32Decode('A' + '='.repeat(100_000) + 'A=')).to.be.null;
      expect(base32Decode('MY' + '='.repeat(100_000))).to.be.null;
      expect(performance.now() - started).to.be.below(500);
    });
  });

  describe('randomToken', () => {
    it('defaults to 32 bytes as unpadded base64url', () => {
      const token = randomToken();
      expect(token).to.match(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeB64url(token)).to.have.length(32);
    });

    it('takes a size and hex', () => {
      expect(randomToken(16)).to.match(/^[A-Za-z0-9_-]{22}$/);
      expect(randomToken(1, 'hex')).to.match(/^[0-9a-f]{2}$/);
      expect(randomToken(20, 'hex')).to.match(/^[0-9a-f]{40}$/);
    });

    it('does not repeat', () => {
      const seen = new Set(Array.from({ length: 100 }, () => randomToken(16)));
      expect(seen.size).to.equal(100);
    });

    it('rejects a bad size or encoding', () => {
      for (const bytes of [0, -1, 1.5, NaN, Infinity, '8' as any]) {
        expect(() => randomToken(bytes), String(bytes)).to.throw(InvalidArgument);
      }
      expect(() => randomToken(8, 'base64' as any)).to.throw(InvalidArgument);
      expect(() => randomToken(8, 'buffer' as any)).to.throw(InvalidArgument);
    });
  });

  describe('processSecret', () => {
    it('is 32 bytes, stable for the process', () => {
      const a = processSecret();
      expect(a).to.have.length(32);
      expect(processSecret().equals(a)).to.be.true;
      expect(a.equals(Buffer.alloc(32))).to.be.false;
    });

    it('hands out copies', () => {
      const a = processSecret();
      const before = hex(a);
      a.fill(0);
      expect(hex(processSecret())).to.equal(before);
    });
  });

  describe('parseKeyMaterial', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 251) & 0xff));
    const b64 = key.toString('base64');
    const b64url = key.toString('base64url');

    it('reads 32 bytes as hex, base64 or base64url', () => {
      expect(b64).to.match(/[+/]/);
      expect(b64url).to.match(/[-_]/);
      expect(hex(parseKeyMaterial(key.toString('hex')))).to.equal(key.toString('hex'));
      expect(hex(parseKeyMaterial(key.toString('hex').toUpperCase()))).to.equal(key.toString('hex'));
      expect(hex(parseKeyMaterial(b64))).to.equal(key.toString('hex'));
      expect(hex(parseKeyMaterial(b64.replace(/=$/, '')))).to.equal(key.toString('hex'));
      expect(hex(parseKeyMaterial(b64url))).to.equal(key.toString('hex'));
    });

    it('takes another size', () => {
      const k16 = randomBytes(16);
      expect(hex(parseKeyMaterial(k16.toString('hex'), 16))).to.equal(k16.toString('hex'));
      expect(hex(parseKeyMaterial(k16.toString('base64'), 16))).to.equal(k16.toString('hex'));
      expect(hex(parseKeyMaterial(k16.toString('base64url'), 16))).to.equal(k16.toString('hex'));
      const k48 = randomBytes(48);
      expect(hex(parseKeyMaterial(k48.toString('base64'), 48))).to.equal(k48.toString('hex'));
      expect(parseKeyMaterial(k48.toString('base64') + '=', 48)).to.be.null;
      expect(parseKeyMaterial(k16.toString('hex'))).to.be.null;
    });

    it('rejects other lengths, mixed alphabets, padded base64url and stray bits', () => {
      const lastChar = b64url[42];
      const strayBits = b64url.slice(0, 42) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(lastChar) | 1)];
      const bad = [
        '',
        key.toString('hex').slice(2),
        key.toString('hex') + '00',
        'g'.repeat(64),
        b64url + '=',
        b64 + '=',
        b64.slice(0, 42),
        `+${b64url.slice(1, 10)}_${b64url.slice(11)}`,
        strayBits,
        ` ${b64url.slice(1)}`,
        randomBytes(31).toString('base64'),
        randomBytes(33).toString('base64url'),
      ];
      expect(bad).to.include(strayBits);
      for (const text of bad) {
        expect(parseKeyMaterial(text), text).to.be.null;
      }
      expect(parseKeyMaterial(undefined)).to.be.null;
      expect(parseKeyMaterial(key)).to.be.null;
    });

    it('agrees with the authn MFA key parser it replaces', () => {
      const legacy = (secret: string): Buffer | null => {
        let k: Buffer | undefined;
        if (/^[0-9a-fA-F]{64}$/.test(secret)) {
          k = Buffer.from(secret, 'hex');
        } else if (/^[A-Za-z0-9+/]{43}=?$/.test(secret) || /^[A-Za-z0-9_-]{43}$/.test(secret)) {
          k = Buffer.from(secret, 'base64');
          if (k.toString('base64url') !== secret.replace(/=$/, '').replace(/\+/g, '-').replace(/\//g, '_')) k = undefined;
        }
        return k && k.length === 32 ? k : null;
      };
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_= ';
      for (let i = 0; i < 2000; i++) {
        const k = randomBytes(32);
        const base = [k.toString('hex'), k.toString('base64'), k.toString('base64url')][i % 3];
        const chars = base.split('');
        const edits = i % 4;
        for (let e = 0; e < edits; e++) {
          const at = Math.floor(Math.random() * (chars.length + 1));
          const op = Math.floor(Math.random() * 3);
          const ch = alphabet[Math.floor(Math.random() * alphabet.length)];
          if (op === 0) chars.splice(at, 1, ch);
          else if (op === 1) chars.splice(at, 0, ch);
          else chars.splice(at, 1);
        }
        const text = chars.join('');
        expect(hex(parseKeyMaterial(text)), text).to.equal(hex(legacy(text)));
      }
    });

    it('rejects a bad size', () => {
      for (const bytes of [0, -1, 1.5, NaN]) {
        expect(() => parseKeyMaterial('00', bytes), String(bytes)).to.throw(InvalidArgument);
      }
    });
  });

  it('stays out of the package root, which must load without node:crypto', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? (f === 'crypto' ? [] : files(join(dir, f))) : [join(dir, f)]));
    for (const file of files(src)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).to.not.match(/from\s+['"](node:)?crypto['"]|['"]\.\/crypto(\/index)?\.js['"]/);
    }
  });
});
