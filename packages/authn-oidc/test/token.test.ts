import 'mocha';
import { expect } from 'chai';

import { OIDC_SIGNING_ALGORITHMS } from '../src/contracts.js';
import { OidcJwks } from '../src/jwks.js';
import { exchangeCode } from '../src/token/exchange.js';
import type { CodeExchange } from '../src/token/exchange.js';
import { atHashOf, validateIdToken } from '../src/token/id-token.js';
import type { IdTokenRules } from '../src/token/id-token.js';
import { fetchUserinfo } from '../src/token/userinfo.js';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, FakeIdp, atHash } from './support/fake-idp.js';
import type { FakeLogin, FakeTamper } from './support/fake-idp.js';

const NONCE = 'n-0S6_WzA2Mj';
const ACCESS = 'access-token-abc';
const REDIRECT = 'https://app.example.test/auth/oidc/corp/callback';

async function rejects(p: Promise<unknown>, what?: string): Promise<Error> {
  try {
    await p;
  } catch (err) {
    expect(err).to.be.instanceOf(Error);
    if (what) expect((err as Error).message).to.contain(what);
    return err as Error;
  }
  return expect.fail('expected a rejection');
}

describe('authn-oidc tokens', () => {
  let idp: FakeIdp;
  let jwks: OidcJwks;

  beforeEach(async () => {
    idp = await FakeIdp.create();
    jwks = new OidcJwks(idp.jwksUri, idp, false);
  });

  describe('code exchange', () => {
    const exchange = (over: Partial<CodeExchange> = {}): CodeExchange => ({
      endpoint: idp.tokenUrl,
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      auth: 'client_secret_basic',
      code: 'the-code',
      redirectUri: REDIRECT,
      codeVerifier: 'v'.repeat(43),
      idToken: true,
      ...over,
    });
    const answering = (json: unknown, status = 200) => idp.on(idp.tokenUrl, () => ({ status, json }));

    it('sends the code, redirect_uri and PKCE verifier with client_secret_basic', async () => {
      answering({ access_token: 'a', token_type: 'Bearer', id_token: 'h.p.s' });
      expect(await exchangeCode(idp, exchange())).to.deep.eq({ accessToken: 'a', idToken: 'h.p.s' });
      const req = idp.requests[0];
      expect(req.method).to.eq('POST');
      expect(req.form).to.deep.eq({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: REDIRECT, code_verifier: 'v'.repeat(43) });
      expect(req.headers.authorization).to.eq(`Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString('base64')}`);
    });

    it('form-urlencodes the id and secret before the Basic encoding (RFC 6749 §2.3.1)', async () => {
      answering({ access_token: 'a', token_type: 'Bearer', id_token: 'h.p.s' });
      await exchangeCode(idp, exchange({ clientId: 'a:b c', clientSecret: 'p@ss/w:rd+' }));
      const basic = Buffer.from(idp.requests[0].headers.authorization!.slice(6), 'base64').toString('utf8');
      expect(basic).to.eq('a%3Ab+c:p%40ss%2Fw%3Ard%2B');
    });

    it('sends the client in the form with client_secret_post', async () => {
      answering({ access_token: 'a', token_type: 'bearer' });
      expect(await exchangeCode(idp, exchange({ auth: 'client_secret_post', idToken: false }))).to.deep.eq({ accessToken: 'a' });
      expect(idp.requests[0].form).to.deep.include({ client_id: FAKE_CLIENT_ID, client_secret: FAKE_CLIENT_SECRET });
      expect(idp.requests[0].headers.authorization).to.eq(undefined);
    });

    it('refuses an error answer, a missing Bearer access token, or a missing ID token', async () => {
      const bad: [unknown, number][] = [
        [{ error: 'invalid_grant' }, 400],
        [{ access_token: 'a', token_type: 'Bearer', id_token: 'h.p.s' }, 201],
        [[{ access_token: 'a' }], 200],
        [{ error: 'bad_verification_code' }, 200],
        [{ access_token: 'a', token_type: 'mac', id_token: 'h.p.s' }, 200],
        [{ access_token: 'a', id_token: 'h.p.s' }, 200],
        [{ access_token: '', token_type: 'Bearer', id_token: 'h.p.s' }, 200],
        [{ access_token: 'a'.repeat(16_385), token_type: 'Bearer', id_token: 'h.p.s' }, 200],
        [{ access_token: 'a', token_type: 'Bearer' }, 200],
        [{ access_token: 'a', token_type: 'Bearer', id_token: 42 }, 200],
      ];
      for (const [json, status] of bad) {
        answering(json, status);
        const err = await rejects(exchangeCode(idp, exchange()));
        expect(err.message).to.not.contain(FAKE_CLIENT_SECRET).and.not.contain('the-code');
      }
    });

    it('lets a transport failure through', async () => {
      idp.fail(idp.tokenUrl);
      await rejects(exchangeCode(idp, exchange()));
    });
  });

  describe('ID token', () => {
    const rules = (over: Partial<IdTokenRules> = {}): IdTokenRules => ({
      issuer: FAKE_ISSUER,
      issuerAliases: [],
      clientId: FAKE_CLIENT_ID,
      algorithms: OIDC_SIGNING_ALGORITHMS,
      clockSkewSeconds: 30,
      nonce: NONCE,
      accessToken: ACCESS,
      now: new Date(),
      ...over,
    });
    const mint = (login: Partial<FakeLogin> = {}) => idp.idToken({ login: { claims: { sub: 'user-1' }, ...login }, nonce: NONCE }, ACCESS);
    const valid = async (token: string, over: Partial<IdTokenRules> = {}) => validateIdToken(token, jwks, rules(over));

    it('accepts a token signed with RS256 or EdDSA and returns its claims', async () => {
      const claims = await valid(await mint());
      expect(claims).to.deep.include({ iss: FAKE_ISSUER, aud: FAKE_CLIENT_ID, sub: 'user-1', nonce: NONCE });
      expect(Object.isFrozen(claims)).to.eq(true);
      expect((await valid(await mint({ key: idp.keys[1] }))).sub).to.eq('user-1');
    });

    const TAMPERS: Exclude<FakeTamper, 'none'>[] = ['wrong-iss', 'wrong-aud', 'azp-mismatch', 'wrong-nonce', 'expired', 'iat-future', 'alg-none', 'hmac-public-key', 'at-hash-mismatch'];
    for (const tamper of TAMPERS) {
      it(`refuses the kit tamper ${tamper}`, async () => {
        await rejects(valid(await mint({ tamper })));
      });
    }

    it('accepts a documented issuer alias and nothing else', async () => {
      const token = await mint({ override: { iss: 'idp.example.test' } });
      await rejects(valid(token), 'iss');
      expect((await valid(token, { issuerAliases: ['idp.example.test'] })).iss).to.eq('idp.example.test');
      await rejects(valid(await mint({ override: { iss: `${FAKE_ISSUER}/` } })), 'iss');
    });

    it('takes aud as the client id, or an array of nothing but the client id', async () => {
      expect((await valid(await mint({ override: { aud: [FAKE_CLIENT_ID] } }))).sub).to.eq('user-1');
      await rejects(valid(await mint({ override: { aud: [FAKE_CLIENT_ID, 'other'] , azp: FAKE_CLIENT_ID } })), 'aud');
      await rejects(valid(await mint({ override: { aud: [] } })), 'aud');
      await rejects(valid(await mint({ override: { aud: undefined } })), 'aud');
      await rejects(valid(await mint({ override: { aud: 42 } })), 'aud');
    });

    it('checks azp when present, and needs it with several audiences', async () => {
      expect((await valid(await mint({ override: { azp: FAKE_CLIENT_ID } }))).sub).to.eq('user-1');
      await rejects(valid(await mint({ override: { azp: 'other' } })), 'azp');
      await rejects(valid(await mint({ override: { aud: [FAKE_CLIENT_ID, FAKE_CLIENT_ID] } })), 'azp');
      expect((await valid(await mint({ override: { aud: [FAKE_CLIENT_ID, FAKE_CLIENT_ID], azp: FAKE_CLIENT_ID } }))).sub).to.eq('user-1');
    });

    it('allows the clock skew on exp, iat and nbf, and no more', async () => {
      const now = Math.floor(Date.now() / 1000);
      // One fixed instant for minting and checking, so a second boundary between them cannot flip a case.
      const at = { now: new Date(now * 1000) };
      expect((await valid(await mint({ override: { exp: now - 29 } }), at)).sub).to.eq('user-1');
      await rejects(valid(await mint({ override: { exp: now - 31 } }), at), 'exp');
      await rejects(valid(await mint({ override: { exp: now + 60 } }), { clockSkewSeconds: 0, now: new Date((now + 60) * 1000) }), 'exp');
      expect((await valid(await mint({ override: { iat: now + 29 } }), at)).sub).to.eq('user-1');
      await rejects(valid(await mint({ override: { iat: now + 31 } }), at), 'iat');
      expect((await valid(await mint({ override: { nbf: now + 29 } }), at)).sub).to.eq('user-1');
      await rejects(valid(await mint({ override: { nbf: now + 31 } }), at), 'nbf');
      await rejects(valid(await mint({ override: { nbf: 'soon' } }), at), 'nbf');
    });

    it('needs exp, iat, nonce and a sub', async () => {
      await rejects(valid(await mint({ override: { exp: undefined } })), 'exp');
      await rejects(valid(await mint({ override: { exp: '9999999999' } })), 'exp');
      await rejects(valid(await mint({ override: { iat: undefined } })), 'iat');
      await rejects(valid(await mint({ override: { nonce: undefined } })), 'nonce');
      await rejects(valid(await mint({ override: { sub: undefined } })), 'sub');
      await rejects(valid(await mint({ override: { sub: '' } })), 'sub');
      await rejects(valid(await mint({ override: { sub: 42 } })), 'sub');
      await rejects(valid(await mint({ override: { sub: 'x'.repeat(256) } })), 'sub');
    });

    it('checks at_hash only when present, with the hash of the alg', async () => {
      expect((await valid(await mint({ override: { at_hash: undefined } }))).sub).to.eq('user-1');
      expect(atHashOf(ACCESS, 'RS256')).to.eq(atHash(ACCESS, 'RS256'));
      expect(atHashOf(ACCESS, 'EdDSA')).to.eq(atHash(ACCESS, 'EdDSA'));
      expect(atHashOf(ACCESS, 'ES384')).to.have.length(32);
      // An EdDSA token whose at_hash used SHA-256 is refused.
      await rejects(valid(await mint({ key: idp.keys[1], override: { at_hash: atHash(ACCESS, 'RS256') } })), 'at_hash');
      await rejects(valid(await mint({ override: { at_hash: 42 } })), 'at_hash');
    });

    it('refuses an algorithm outside the provider allow-list', async () => {
      await rejects(valid(await mint(), { algorithms: ['EdDSA'] }), 'algorithm');
      await rejects(valid(await mint({ key: idp.keys[1] }), { algorithms: ['RS256'] }), 'algorithm');
    });

    it('refuses a crit header, an unknown kid and a bad signature', async () => {
      const key = idp.keys[0];
      const payload = JSON.stringify({ iss: FAKE_ISSUER, aud: FAKE_CLIENT_ID, sub: 'user-1', nonce: NONCE, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 });
      await rejects(valid(await idp.sign(key, payload, { crit: ['b64'], b64: true })));
      await rejects(valid(await idp.sign(key, payload, { kid: 'unknown' })));
      const other = await FakeIdp.create();
      await rejects(valid(await other.sign(other.keys[0], payload, { kid: key.kid })));
      const token = await idp.sign(key, payload);
      const [h, , s] = token.split('.');
      await rejects(valid(`${h}.${Buffer.from(payload.replace('user-1', 'user-2')).toString('base64url')}.${s}`));
      await rejects(valid(`${h}.${Buffer.from('[1]').toString('base64url')}.${s}`));
      await rejects(valid('not-a-jwt'));
      await rejects(valid(`${h}..${s}`));
    });

    it('never puts the token in the error', async () => {
      const token = await mint({ tamper: 'wrong-nonce' });
      const err = await rejects(valid(token));
      expect(err.message).to.not.contain(token);
    });
  });

  describe('userinfo', () => {
    it('sends the access token as Bearer and returns the claims', async () => {
      idp.accessTokens.set(ACCESS, { sub: 'user-1', email: 'a@example.test' });
      expect(await fetchUserinfo(idp, idp.userinfoUrl, ACCESS)).to.deep.eq({ sub: 'user-1', email: 'a@example.test' });
      expect(idp.requests[0].headers.authorization).to.eq(`Bearer ${ACCESS}`);
      expect(idp.requests[0].headers['user-agent']).to.be.a('string');
    });

    it('refuses an error answer or a body that is not a JSON object', async () => {
      await rejects(fetchUserinfo(idp, idp.userinfoUrl, 'unknown-token'));
      idp.on(idp.userinfoUrl, () => ({ status: 200, json: ['x'] }));
      await rejects(fetchUserinfo(idp, idp.userinfoUrl, ACCESS));
      idp.fail(idp.userinfoUrl);
      await rejects(fetchUserinfo(idp, idp.userinfoUrl, ACCESS));
    });
  });

  describe('fake IdP round trip', () => {
    it('issues a code bound to PKCE and redirect_uri, once', async () => {
      const verifier = 'v'.repeat(43);
      const { createHash } = await import('node:crypto');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const loc = `${idp.discovery.authorization_endpoint as string}?response_type=code&client_id=${FAKE_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s1&nonce=${NONCE}&code_challenge=${challenge}&code_challenge_method=S256`;
      const q = idp.authorize(loc, { claims: { sub: 'user-1' } });
      const base = { endpoint: idp.tokenUrl, clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, auth: 'client_secret_basic' as const, code: q.code, redirectUri: REDIRECT, idToken: true };
      await rejects(exchangeCode(idp, { ...base, codeVerifier: 'w'.repeat(43) }));
      const q2 = idp.authorize(loc, { claims: { sub: 'user-1' } });
      const set = await exchangeCode(idp, { ...base, code: q2.code, codeVerifier: verifier });
      const claims = await validateIdToken(set.idToken!, jwks, { issuer: FAKE_ISSUER, issuerAliases: [], clientId: FAKE_CLIENT_ID, algorithms: OIDC_SIGNING_ALGORITHMS, clockSkewSeconds: 30, nonce: NONCE, accessToken: set.accessToken, now: new Date() });
      expect(claims.sub).to.eq('user-1');
      await rejects(exchangeCode(idp, { ...base, code: q2.code, codeVerifier: verifier }));
    });
  });
});
