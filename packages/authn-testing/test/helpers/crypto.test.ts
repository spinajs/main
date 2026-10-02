import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import 'mocha';
import type { PublicJwk } from '@spinajs/authn/contracts';
import { b64url, b64urlDecode, base32Decode, compactJws, generateKeyPair, parseOtpauth, sha256b64, sha256hex, signCompactJws, thumbprint, totp, totpFromProvisioning } from '../../src/helpers/index.js';
import type { KitKeyPair } from '../../src/harness/index.js';

// RFC 8037 appendix A.1 key
const RFC8037_D = 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A';
const RFC8037_X = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';

function rfc8037Key(): KitKeyPair {
  const publicJwk: PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: RFC8037_X };
  return { alg: 'EdDSA', publicJwk, privateKey: createPrivateKey({ key: { ...publicJwk, d: RFC8037_D }, format: 'jwk' }), kid: thumbprint(publicJwk) };
}

describe('encoding helpers', () => {
  it('b64url round-trips bytes and strings without padding', () => {
    assert.equal(b64url('hi?>'), 'aGk_Pg');
    assert.equal(b64url(new Uint8Array([251, 255])), '-_8');
    assert.deepEqual(b64urlDecode('-_8'), Buffer.from([251, 255]));
  });

  it('b64urlDecode refuses non-base64url input', () => {
    for (const bad of ['a!b', 'a+b', 'a/b', 'ab==', 'abcde']) {
      assert.throws(() => b64urlDecode(bad), RangeError, bad);
    }
    assert.equal(b64urlDecode('').length, 0);
  });

  it('hashes', () => {
    assert.equal(sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256b64(Buffer.from('abc')), 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });
});

describe('keys and JWS', () => {
  it('RFC 8037 A.3 thumbprint', () => {
    assert.equal(thumbprint(rfc8037Key().publicJwk), 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  });

  it('RFC 8037 A.4 Ed25519 JWS matches byte for byte', () => {
    const jws = signCompactJws({ alg: 'EdDSA' }, 'Example of Ed25519 signing', rfc8037Key());
    assert.equal(jws, 'eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc.hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg');
  });

  it('generates Ed25519 and P-256 pairs whose kid is the thumbprint', () => {
    const ed = generateKeyPair('EdDSA');
    assert.equal(ed.publicJwk.kty, 'OKP');
    assert.equal(ed.kid, thumbprint(ed.publicJwk));
    assert.equal('d' in ed.publicJwk, false);
    const ec = generateKeyPair('ES256');
    assert.equal(ec.publicJwk.kty, 'EC');
    assert.equal(ec.publicJwk.crv, 'P-256');
    assert.equal(b64urlDecode((ec.publicJwk as { y: string }).y).length, 32);
    assert.equal('d' in ec.publicJwk, false);
  });

  it('thumbprint uses lexicographic members', () => {
    const ec = generateKeyPair('ES256').publicJwk as { x: string; y: string };
    const json = `{"crv":"P-256","kty":"EC","x":"${ec.x}","y":"${ec.y}"}`;
    assert.equal(thumbprint(ec as unknown as PublicJwk), b64url(Buffer.from(sha256hex(json), 'hex')));
  });

  it('ES256 signs ieee-p1363 (64 bytes) and verifies', () => {
    const k = generateKeyPair('ES256');
    const jws = signCompactJws({ alg: 'ES256', kid: k.kid }, { sub: 'x' }, k);
    const [h, p, s] = jws.split('.');
    assert.equal(b64urlDecode(s).length, 64);
    assert.deepEqual(JSON.parse(b64urlDecode(p).toString()), { sub: 'x' });
    const pub = createPublicKey({ key: k.publicJwk as never, format: 'jwk' });
    assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64urlDecode(s)), true);
  });

  it('none gives an empty signature and HS256 uses the hmac key', () => {
    const none = signCompactJws({ alg: 'none' }, { a: 1 }, 'none');
    assert.ok(none.endsWith('.'));
    assert.equal(none.split('.')[2], '');
    const hs = signCompactJws({ alg: 'HS256' }, 'x', { hmacKey: Buffer.from('secret') });
    assert.equal(b64urlDecode(hs.split('.')[2]).length, 32);
  });

  it('compactJws joins parts', () => {
    assert.equal(compactJws(['a', 'b', 'c']), 'a.b.c');
  });
});

describe('TOTP', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('base32Decode is case-insensitive and padding-free', () => {
    assert.equal(base32Decode(secret).toString('ascii'), '12345678901234567890');
    assert.equal(base32Decode(secret.toLowerCase()).toString('ascii'), '12345678901234567890');
    assert.equal(base32Decode('MZXW6===').toString(), 'foo');
    assert.equal(base32Decode('MZXW6').toString(), 'foo');
  });

  it('RFC 6238 appendix B (SHA1, 8 digits)', () => {
    const at = (s: number) => totp(secret, new Date(s * 1000), { digits: 8 });
    assert.equal(at(59), '94287082');
    assert.equal(at(1111111109), '07081804');
    assert.equal(at(1111111111), '14050471');
    assert.equal(at(1234567890), '89005924');
    assert.equal(at(2000000000), '69279037');
  });

  it('defaults to 6 digits and 30 s', () => {
    assert.equal(totp(secret, new Date(59000)), '287082');
    assert.equal(totp(secret, new Date(30000)), totp(secret, new Date(59999)));
  });

  it('refuses odd otpauth parameters', () => {
    for (const q of ['algorithm=MD5', 'digits=x', 'digits=0', 'period=0', 'period=1.5']) {
      assert.throws(() => parseOtpauth(`otpauth://totp/x?secret=${secret}&${q}`), RangeError, q);
    }
  });

  it('parses otpauth URIs', () => {
    assert.deepEqual(parseOtpauth(`otpauth://totp/Spina:alice?secret=${secret}&issuer=Spina`), { secret, algorithm: 'SHA1', digits: 6, period: 30 });
    assert.deepEqual(parseOtpauth(`otpauth://totp/x?secret=${secret}&algorithm=SHA256&digits=8&period=60`), { secret, algorithm: 'SHA256', digits: 8, period: 60 });
    assert.equal(totpFromProvisioning(`otpauth://totp/x?secret=${secret}&digits=8`, new Date(59000)), '94287082');
  });
});
