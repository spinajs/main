import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import 'mocha';
import { contentDigest, generateKeyPair, signatureBase, signHttpRequest, thumbprint } from '../../src/helpers/index.js';
import type { KitKeyPair } from '../../src/harness/index.js';

// RFC 9421 appendix B.1.4 test-key-ed25519
const ED_PRIVATE = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF
-----END PRIVATE KEY-----`;

function b21Key(): KitKeyPair {
  const privateKey = createPrivateKey(ED_PRIVATE);
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string } as const;
  return { alg: 'EdDSA', publicJwk, privateKey, kid: thumbprint(publicJwk) };
}

describe('contentDigest', () => {
  it('RFC 9530 sha-256 of the example body', () => {
    assert.equal(contentDigest(Buffer.from('{"hello": "world"}')), 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:');
  });
});

describe('HTTP signatures', () => {
  const request = {
    method: 'POST',
    targetUri: 'https://example.com/foo?param=Value&Pet=dog',
    headers: {
      host: 'example.com',
      date: 'Tue, 20 Apr 2021 02:07:55 GMT',
      'content-type': 'application/json',
      'content-length': '18',
    },
  };
  const components = ['date', '@method', '@path', '@authority', 'content-type', 'content-length'];
  const params = '("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';

  it('RFC 9421 B.2.6 signature base and sig-b26 value match byte for byte', () => {
    const base = signatureBase(request, components, params);
    assert.equal(
      base,
      ['"date": Tue, 20 Apr 2021 02:07:55 GMT', '"@method": POST', '"@path": /foo', '"@authority": example.com', '"content-type": application/json', '"content-length": 18', `"@signature-params": ${params}`].join('\n'),
    );
    const sig = createPrivateKey(ED_PRIVATE);
    const signature = sign(null, Buffer.from(base), sig).toString('base64');
    assert.equal(signature, 'wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==');
  });

  it('derives @query and @target-uri', () => {
    const base = signatureBase(request, ['@target-uri', '@query'], '("@target-uri" "@query")');
    assert.equal(base, ['"@target-uri": https://example.com/foo?param=Value&Pet=dog', '"@query": ?param=Value&Pet=dog', '"@signature-params": ("@target-uri" "@query")'].join('\n'));
  });

  it('signs a body request with all three components in the documented layout', () => {
    const k = b21Key();
    const body = Buffer.from('{"hello": "world"}');
    const signed = signHttpRequest({ method: 'post', targetUri: 'https://example.com/foo', headers: { 'Content-Type': 'application/json' }, body }, k, 'kid-1', { created: 1700000000, expires: 1700000060, nonce: 'n-1' });
    const digest = 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:';
    const input = '("@method" "@target-uri" "content-digest");created=1700000000;expires=1700000060;nonce="n-1";keyid="kid-1"';
    assert.equal(signed.headers['content-digest'], digest);
    assert.equal(signed.headers['content-type'], 'application/json');
    assert.equal(signed.headers['signature-input'], `sig1=${input}`);
    const m = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(signed.headers.signature);
    assert.ok(m);
    const base = ['"@method": POST', '"@target-uri": https://example.com/foo', `"content-digest": ${digest}`, `"@signature-params": ${input}`].join('\n');
    assert.equal(verify(null, Buffer.from(base), createPublicKey(k.privateKey), Buffer.from(m[1], 'base64')), true);
    assert.equal(signed.body, body);
  });

  it('omits content-digest without a body, and created, nonce and keyid when unset', () => {
    const k = generateKeyPair('ES256');
    const signed = signHttpRequest({ method: 'GET', targetUri: 'https://example.com/x' }, k, null, { label: 'b' });
    assert.equal(signed.headers['content-digest'], undefined);
    assert.equal(signed.headers['signature-input'], 'b=("@method" "@target-uri")');
    const m = /^b=:([A-Za-z0-9+/=]+):$/.exec(signed.headers.signature);
    assert.ok(m);
    const sig = Buffer.from(m[1], 'base64');
    assert.equal(sig.length, 64);
    const base = ['"@method": GET', '"@target-uri": https://example.com/x', '"@signature-params": ("@method" "@target-uri")'].join('\n');
    assert.equal(verify('sha256', Buffer.from(base), { key: createPublicKey(k.privateKey), dsaEncoding: 'ieee-p1363' }, sig), true);
  });

  it('keyid null in params omits it; a string overrides the kid argument', () => {
    const k = generateKeyPair('EdDSA');
    const a = signHttpRequest({ method: 'GET', targetUri: 'https://example.com/x' }, k, 'kid', { keyid: null });
    assert.equal(a.headers['signature-input'], 'sig1=("@method" "@target-uri")');
    const b = signHttpRequest({ method: 'GET', targetUri: 'https://example.com/x' }, k, 'kid', { keyid: 'other' });
    assert.equal(b.headers['signature-input'], 'sig1=("@method" "@target-uri");keyid="other"');
  });
});
