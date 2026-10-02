import assert from 'node:assert/strict';
import 'mocha';
import { CookieJar, generateKeyPair, idBits, isCleared, parseSetCookie, startJwksServer } from '../../src/helpers/index.js';

describe('idBits', () => {
  it('estimates entropy by shape', () => {
    assert.equal(idBits('3b241101-e2bb-4255-8caf-4136c566a962'), 122);
    assert.equal(idBits(Buffer.alloc(16, 7).toString('base64url')), 132);
    assert.equal(idBits('0123456789abcdef0123456789abcdef'), 128);
    assert.equal(idBits('has space'), 0);
    assert.equal(idBits(''), 0);
  });
});

describe('cookies', () => {
  it('parses Set-Cookie values', () => {
    const [a, b] = parseSetCookie(['ssid=abc=; Path=/; HttpOnly; SameSite=Strict; Max-Age=60', '__Host-x=; Secure']);
    assert.deepEqual(a, { name: 'ssid', value: 'abc=', attributes: { path: '/', httponly: true, samesite: 'Strict', 'max-age': '60' } });
    assert.deepEqual(b, { name: '__Host-x', value: '', attributes: { secure: true } });
  });

  it('isCleared: empty value, max-age <= 0 or a past expiry', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const [empty, zero, past, future, live] = parseSetCookie(['a=', 'b=1; Max-Age=0', 'c=1; Expires=Tue, 01 Jan 2019 00:00:00 GMT', 'd=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT', 'e=1']);
    assert.deepEqual([empty, zero, past, future, live].map((c) => isCleared(c, now)), [true, true, true, false, false]);
  });

  it('jar stores, applies (request cookies win) and drops cleared cookies', () => {
    const jar = new CookieJar();
    const res = { status: 200, headers: {}, setCookie: ['a=1; Path=/', 'b=2'], body: undefined };
    assert.equal(jar.store(res), res);
    assert.equal(jar.get('a'), '1');
    const req = jar.apply({ method: 'GET', path: '/', cookies: { b: 'mine' } });
    assert.deepEqual(req.cookies, { a: '1', b: 'mine' });
    jar.store({ ...res, setCookie: ['a=; Max-Age=0'] });
    assert.equal(jar.get('a'), undefined);
    jar.set('z', '9');
    assert.equal(jar.get('z'), '9');
    jar.clear();
    assert.equal(jar.get('z'), undefined);
    assert.equal(jar.get('b'), undefined);
  });
});

describe('JWKS server', () => {
  it('serves public keys, counts hits and follows setKeys', async () => {
    const ed = generateKeyPair('EdDSA');
    const ec = generateKeyPair('ES256');
    const server = await startJwksServer([ed]);
    try {
      assert.equal(server.hits(), 0);
      const first = (await (await fetch(server.url)).json()) as { keys: Record<string, unknown>[] };
      assert.deepEqual(first.keys, [{ ...ed.publicJwk, kid: ed.kid, alg: 'EdDSA', use: 'sig' }]);
      server.setKeys([ed, ec]);
      const second = (await (await fetch(server.url)).json()) as { keys: Record<string, unknown>[] };
      assert.equal(second.keys.length, 2);
      assert.equal(second.keys[1].alg, 'ES256');
      assert.equal(server.hits(), 2);
      assert.equal((await fetch(new URL('/other', server.url))).status, 404);
    } finally {
      await server.close();
    }
  });
});
