import 'mocha';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { JwsClaims, JwsKey, JwsVerifyOptions, KeyAlgorithm } from '@spinajs/authn/contracts';
import { generateKeyPair, runAuthnBehaviour, signCompactJws } from '@spinajs/authn-testing';
import { SMALL_ORDER } from '../src/jwk/index.js';
import { LocalJwsSigner, parseStrictJson, StrictJwsVerifier } from '../src/jws/index.js';
import type { PrivateJwk } from '../src/jws/index.js';
import { privateJwkOf } from './harness.js';

for (const alg of ['EdDSA', 'ES256'] as const) {
  runAuthnBehaviour(['A17'], () => ({ jws: { verifier: new StrictJwsVerifier(), signer: new LocalJwsSigner([privateJwkOf(generateKeyPair(alg))]) } }), {
    title: `authn-keys: A17 jws (${alg} signer)`,
    facets: ['A17/jws'],
    claim: ['A17/jws'],
  });
}

const utf8 = (s: string) => Buffer.from(s, 'utf8');
const TYP = 'kit+jwt';
const NOW = 1_800_000_000;

function setup(alg: KeyAlgorithm = 'EdDSA') {
  const kp = generateKeyPair(alg);
  const key = { alg, kid: kp.kid, jwk: kp.publicJwk } as JwsKey;
  const options = (over: Partial<JwsVerifyOptions<JwsClaims>> = {}): JwsVerifyOptions<JwsClaims> => ({
    typ: TYP,
    algorithms: ['EdDSA', 'ES256'],
    keys: async (kid) => (kid === key.kid ? key : null),
    claims: (p) => p as unknown as JwsClaims,
    issuer: 'i',
    audience: 'a',
    now: new Date(NOW * 1000),
    skewSeconds: 30,
    maxLifetimeSeconds: 300,
    ...over,
  });
  const header = { alg, kid: kp.kid, typ: TYP };
  const raw = (h: unknown, payload: string) => signCompactJws(h as Record<string, unknown>, payload, kp);
  const claimsText = (over = '') => `{"iss":"i","aud":"a","iat":${NOW},"exp":${NOW + 60}${over}}`;
  const verify = async (token: string, over?: Partial<JwsVerifyOptions<JwsClaims>>) => {
    const r = await new StrictJwsVerifier().verify(token, options(over));
    return r.ok ? 'ok' : r.code;
  };
  return { kp, key, header, raw, claimsText, verify };
}

describe('strict JSON', () => {
  it('refuses what serde_json refuses', () => {
    assert.deepStrictEqual(parseStrictJson(utf8('{"a":[1,{"b":"c"}]}')), { a: [1, { b: 'c' }] });
    for (const bad of ['{"a":"\\ud800"}', '{"\\udc00":1}', '{"a":"\\ud800","a":"x"}', '{"a":1e400}', '{"a":-1e400}', '{"a":1,"a":1e999}', `${'['.repeat(128)}${']'.repeat(128)}`, '{"a":1', 'nul']) {
      assert.strictEqual(parseStrictJson(utf8(bad)), undefined, bad);
    }
    assert.ok(parseStrictJson(utf8(`${'['.repeat(127)}${']'.repeat(127)}`)) !== undefined, '127 levels pass');
    assert.strictEqual(parseStrictJson(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), undefined, 'invalid UTF-8');
    assert.strictEqual(parseStrictJson(Buffer.from('﻿{}', 'utf8')), undefined, 'a BOM is not JSON');
  });

  it('keeps the last of duplicate keys and checks the text of top-level integer keys', () => {
    assert.deepStrictEqual(parseStrictJson(utf8('{"a":1,"a":2}')), { a: 2 });
    for (const text of ['1e3', '1000.0', '-0', '01000', '1E3']) {
      assert.strictEqual(parseStrictJson(utf8(`{"iat":${text}}`), ['iat']), undefined, text);
    }
    assert.deepStrictEqual(parseStrictJson(utf8('{"iat":1000,"x":{"iat":1e3}}'), ['iat']), { iat: 1000, x: { iat: 1000 } });
  });
});

describe('StrictJwsVerifier beyond the kit rows', () => {
  it('header: duplicate members keep the last value; __proto__ and non-string members are bad_header', async () => {
    const s = setup();
    const h = `{"alg":"none","alg":"EdDSA","kid":"${s.kp.kid}","typ":"${TYP}"}`;
    const exact = (headerJson: string) => {
      const input = `${Buffer.from(headerJson).toString('base64url')}.${Buffer.from(s.claimsText()).toString('base64url')}`;
      return `${input}.${sign(null, Buffer.from(input), s.kp.privateKey).toString('base64url')}`;
    };
    assert.strictEqual(await s.verify(exact(h)), 'ok');
    assert.strictEqual(await s.verify(exact(`{"alg":"EdDSA","kid":"${s.kp.kid}","typ":"${TYP}","__proto__":{}}`)), 'bad_header');
    assert.strictEqual(await s.verify(exact(`{"alg":"EdDSA","kid":7,"typ":"${TYP}"}`)), 'bad_header');
    assert.strictEqual(await s.verify(exact(`["EdDSA","${s.kp.kid}","${TYP}"]`)), 'bad_header');
    assert.strictEqual(await s.verify(exact(`{"alg":"EdDSA","kid":"${s.kp.kid}\\ud800","typ":"${TYP}"}`)), 'bad_header');
  });

  it('payload: iat and exp must be plain non-negative safe integers', async () => {
    const s = setup();
    const at = (iat: string, exp: string) => s.raw(s.header, `{"iss":"i","aud":"a","iat":${iat},"exp":${exp}}`);
    assert.strictEqual(await s.verify(at(String(NOW), String(NOW + 60))), 'ok');
    for (const [iat, exp] of [
      [`${NOW}.0`, String(NOW + 60)],
      ['1.8e9', String(NOW + 60)],
      [String(NOW), `"${NOW + 60}"`],
      ['-1', '10'],
      [String(NOW), '9007199254740992'],
      [String(NOW), 'null'],
    ]) {
      assert.strictEqual(await s.verify(at(iat, exp)), 'invalid_claims', `${iat} ${exp}`);
    }
    assert.strictEqual(await s.verify(s.raw(s.header, '[1]')), 'invalid_claims');
    assert.strictEqual(await s.verify(s.raw(s.header, '{"iss":1,"aud":"a","iat":1,"exp":2}')), 'invalid_claims');
  });

  it('a weak key handed in by the lookup is unknown_key, never verified', async () => {
    const s = setup();
    const weak = { alg: 'EdDSA', kid: s.kp.kid, jwk: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(SMALL_ORDER[0], 'hex').toString('base64url') } } as JwsKey;
    const forged = `${s.raw(s.header, s.claimsText()).split('.').slice(0, 2).join('.')}.${Buffer.concat([Buffer.from(SMALL_ORDER[0], 'hex'), Buffer.alloc(32)]).toString('base64url')}`;
    assert.strictEqual(await s.verify(forged, { keys: async () => weak }), 'unknown_key');
    const withD = { ...s.key, jwk: { ...s.key.jwk, d: 'x' } } as unknown as JwsKey;
    assert.strictEqual(await s.verify(s.raw(s.header, s.claimsText()), { keys: async () => withD }), 'unknown_key');
  });

  it('the issuer function sees the key; a hostile token never throws', async () => {
    const s = setup('ES256');
    const token = s.raw(s.header, s.claimsText());
    assert.strictEqual(await s.verify(token, { issuer: (iss, key) => iss === 'i' && key.kid === s.kp.kid }), 'ok');
    assert.strictEqual(await s.verify(token, { issuer: () => false }), 'wrong_issuer');
    for (const junk of ['', '..', '...', 'a.b.c.d', `${'A'.repeat(100000)}.b.c`, '\u0000.\u0000.\u0000', null as unknown as string]) {
      assert.strictEqual(await s.verify(junk), 'malformed');
    }
  });
});

describe('LocalJwsSigner', () => {
  it('refuses weak, mismatched, duplicate and unknown keys, and bad claims', async () => {
    const kp = generateKeyPair('EdDSA');
    const jwk = privateJwkOf(kp, 'k1');
    const other = privateJwkOf(generateKeyPair('EdDSA'), 'k2');
    assert.throws(() => new LocalJwsSigner([{ ...jwk, x: other.x }]), /does not match d/);
    assert.throws(() => new LocalJwsSigner([jwk, { ...other, kid: 'k1' }]), /twice/);
    assert.throws(() => new LocalJwsSigner([{ ...jwk, kid: 'a b' }]), /kid/);
    assert.throws(() => new LocalJwsSigner([{ ...jwk, x: Buffer.from(SMALL_ORDER[1], 'hex').toString('base64url') }]), /not a valid/);
    assert.throws(() => new LocalJwsSigner([jwk], { current: 'k2' }), /no signing key/);
    assert.throws(() => new LocalJwsSigner([]), /no signing key/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }) as Record<string, string>;
    assert.throws(() => new LocalJwsSigner([{ ...rsa, kid: 'r' } as unknown as PrivateJwk]), /not a valid/);

    const signer = new LocalJwsSigner([jwk, other], { current: 'k2' });
    const claims = { iss: 'i', aud: 'a', iat: NOW, exp: NOW + 60 };
    assert.strictEqual(JSON.parse(Buffer.from((await signer.sign(claims, { typ: TYP })).split('.')[0], 'base64url').toString()).kid, 'k2');
    await assert.rejects(signer.sign(claims, { typ: TYP, kid: 'k3' }), /no signing key/);
    await assert.rejects(signer.sign(claims, { typ: '' }), /typ/);
    await assert.rejects(signer.sign({ ...claims, exp: NOW }, { typ: TYP }), /iat < exp/);
    await assert.rejects(signer.sign({ ...claims, iat: 1.5 }, { typ: TYP }), /iat < exp/);
    await assert.rejects(signer.sign({ ...claims, name: 'x\ud800' } as typeof claims, { typ: TYP }), /lone surrogates/);
    const pubs = await signer.publicKeys();
    assert.ok(
      pubs.every((k) => !('d' in k.jwk)),
      'no private part',
    );
  });
});
