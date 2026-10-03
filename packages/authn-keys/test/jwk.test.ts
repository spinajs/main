import 'mocha';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { checkPublicJwk, decodeB64url, isCanonicalPoint, isSmallOrder, isValidKid, publicKeyObject, SMALL_ORDER, thumbprint, verifySignature } from '../src/jwk/index.js';

const RFC8037_X = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const P = 2n ** 255n - 19n;

const le = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse();
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const okp = (x: string) => ({ kty: 'OKP', crv: 'Ed25519', x });

const modPow = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  for (b %= P; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
};

/** Euler's criterion, independent of the decoder: x² = u / v has a root iff (u / v)^((p − 1) / 2) ∈ {0, 1}. */
function hasRoot(y: bigint): boolean {
  const d = (((-121665n * modPow(121666n, P - 2n)) % P) + P) % P;
  const u = (((y * y - 1n) % P) + P) % P;
  const v = (d * y * y + 1n) % P;
  const ratio = (u * modPow(v, P - 2n)) % P;
  const e = modPow(ratio, (P - 1n) / 2n);
  return e === 0n || e === 1n;
}

const ecJwk = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };

describe('jwk: strict base64url', () => {
  it('decodes unpadded base64url only, with one text form', () => {
    assert.deepStrictEqual(decodeB64url('AQID'), Buffer.from([1, 2, 3]));
    for (const bad of ['AQID=', 'AQ+D', 'AQ/D', 'AQ D', 'A', 'AR', 'AQI\n', 7, null]) {
      assert.strictEqual(decodeB64url(bad), null, String(bad));
    }
    // 'AR' would decode to 0x01 with stray bits; only 'AQ' is its canonical form.
    assert.deepStrictEqual(decodeB64url('AQ'), Buffer.from([1]));
  });
});

describe('jwk: Ed25519 point checks', () => {
  it('accepts the RFC 8037 A.1 key and its thumbprint is the A.3 value', () => {
    const m = checkPublicJwk(okp(RFC8037_X));
    assert.deepStrictEqual(m, { alg: 'EdDSA', jwk: okp(RFC8037_X) });
    assert.strictEqual(thumbprint(m!.jwk), 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  });

  it('refuses every small-order encoding', () => {
    for (const hex of SMALL_ORDER) {
      const x = Buffer.from(hex, 'hex');
      assert.ok(isSmallOrder(x));
      assert.strictEqual(checkPublicJwk(okp(b64(x))), null, hex);
    }
  });

  it('refuses non-canonical y (y ≥ p) and a set sign bit on x = 0', () => {
    assert.strictEqual(isCanonicalPoint(le(P)), false);
    assert.strictEqual(isCanonicalPoint(le(P + 2n)), false);
    const yOneSigned = le(1n);
    yOneSigned[31] |= 0x80;
    assert.strictEqual(isCanonicalPoint(yOneSigned), false);
  });

  it('agrees with Euler’s criterion on whether y is on the curve', () => {
    let offCurve = 0;
    for (let y = 2n; y < 200n; y += 1n) {
      const enc = le(y);
      assert.strictEqual(isCanonicalPoint(enc), hasRoot(y), `y = ${y}`);
      if (!hasRoot(y)) {
        offCurve += 1;
        assert.strictEqual(checkPublicJwk(okp(b64(enc))), null, `not a point: y = ${y}`);
      }
    }
    assert.ok(offCurve > 50, 'the range holds non-points');
  });

  it('refuses wrong lengths, padding and the standard alphabet', () => {
    const x = decodeB64url(RFC8037_X)!;
    assert.strictEqual(checkPublicJwk(okp(b64(x.subarray(0, 31)))), null);
    assert.strictEqual(checkPublicJwk(okp(b64(Buffer.concat([x, Buffer.from([0])])))), null);
    assert.strictEqual(checkPublicJwk(okp(`${RFC8037_X}=`)), null);
    assert.ok(/[+/]/.test(x.toString('base64')));
    assert.strictEqual(checkPublicJwk(okp(x.toString('base64').replace(/=+$/, ''))), null);
  });
});

describe('jwk: P-256 and other key types', () => {
  it('accepts a P-256 key as ES256 and drops extra members', () => {
    const { x, y } = ecJwk();
    const m = checkPublicJwk({ kty: 'EC', crv: 'P-256', x, y, kid: 'k', alg: 'EdDSA', use: 'enc', key_ops: ['sign'] });
    assert.deepStrictEqual(m, { alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x, y } });
  });

  it('refuses an off-curve point, wrong lengths and a missing y', () => {
    const { x, y } = ecJwk();
    const yb = decodeB64url(y)!;
    yb[31] ^= 1;
    assert.strictEqual(checkPublicJwk({ kty: 'EC', crv: 'P-256', x, y: b64(yb) }), null, 'off curve');
    assert.strictEqual(checkPublicJwk({ kty: 'EC', crv: 'P-256', x: b64(decodeB64url(x)!.subarray(1)), y }), null, '31-byte x');
    assert.strictEqual(checkPublicJwk({ kty: 'EC', crv: 'P-256', x }), null, 'no y');
  });

  it('refuses RSA, P-384, secp256k1, private keys and junk', () => {
    const exp = (t: string, o: object) => (generateKeyPairSync as unknown as (t: string, o: object) => { publicKey: { export(o: object): object }; privateKey: { export(o: object): object } })(t, o);
    assert.strictEqual(checkPublicJwk(exp('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })), null);
    assert.strictEqual(checkPublicJwk(exp('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' })), null);
    assert.strictEqual(checkPublicJwk(exp('ec', { namedCurve: 'secp256k1' }).publicKey.export({ format: 'jwk' })), null);
    assert.strictEqual(checkPublicJwk(exp('ed25519', {}).privateKey.export({ format: 'jwk' })), null, 'Ed25519 with d');
    assert.strictEqual(checkPublicJwk(exp('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })), null, 'P-256 with d');
    assert.strictEqual(checkPublicJwk({ ...okp(RFC8037_X), d: undefined }), null, 'a d member, even undefined');
    for (const junk of [null, 'x', [okp(RFC8037_X)], { kty: 'OKP', crv: 'X25519', x: RFC8037_X }]) {
      assert.strictEqual(checkPublicJwk(junk), null);
    }
  });

  it('honours the allowed algorithm list', () => {
    const { x, y } = ecJwk();
    assert.strictEqual(checkPublicJwk({ kty: 'EC', crv: 'P-256', x, y }, ['EdDSA']), null);
    assert.ok(checkPublicJwk(okp(RFC8037_X), ['EdDSA']));
  });
});

describe('jwk: kid and key objects', () => {
  it('kid is 1–64 of [A-Za-z0-9._-]', () => {
    assert.ok(isValidKid('rt-2026_10.a'));
    assert.ok(isValidKid('a'.repeat(64)));
    for (const bad of ['', 'a'.repeat(65), 'a b', 'a/b', 'ä', 'a:b', 1]) {
      assert.strictEqual(isValidKid(bad), false, String(bad));
    }
  });

  it('publicKeyObject refuses a material whose alg does not fit its key or whose key is weak', () => {
    assert.ok(publicKeyObject({ alg: 'EdDSA', jwk: okp(RFC8037_X) } as never));
    assert.strictEqual(publicKeyObject({ alg: 'ES256', jwk: okp(RFC8037_X) } as never), null);
    assert.strictEqual(publicKeyObject({ alg: 'EdDSA', jwk: okp(b64(Buffer.from(SMALL_ORDER[4], 'hex'))) } as never), null);
    assert.strictEqual(publicKeyObject({ alg: 'EdDSA', jwk: { ...okp(RFC8037_X), d: 'x' } } as never), null);
  });

  it('verifySignature refuses a small-order R and any length but 64', () => {
    const pair = generateKeyPairSync('ed25519');
    const x = (pair.publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const material = { alg: 'EdDSA', jwk: okp(x) } as const;
    const data = Buffer.from('m');
    const sig = sign(null, data, pair.privateKey);
    assert.ok(verifySignature(material as never, data, sig));
    assert.strictEqual(verifySignature(material as never, data, sig.subarray(0, 63)), false);
    const smallR = Buffer.concat([Buffer.from(SMALL_ORDER[0], 'hex'), Buffer.alloc(32)]);
    assert.strictEqual(verifySignature(material as never, data, smallR), false);
  });
});
