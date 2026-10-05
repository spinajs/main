import 'mocha';
import { expect } from 'chai';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DI } from '@spinajs/di';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome } from '@spinajs/authn/contracts';
import { FakeClock, b64url, compactJws, generateKeyPair, signCompactJws, startJwksServer } from '@spinajs/authn-testing';
import type { JwksServer, KitKeyPair } from '@spinajs/authn-testing';

import { JwtBearerStrategy } from '../../src/jwt/JwtBearerStrategy.js';
import { boot, disposeBooted, readingFrom } from '../support/config-boot.js';
import { bootV3Db, shutdownV3Db } from './db.js';

const ISSUER = 'https://idp.unit.test';
const AUDIENCE = 'unit-api';
const SUBJECT = 'unit-sub-1';
const NOW = new Date('2026-10-03T10:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;
const ISSUERS_PATH = ['authn', 'jwt', 'issuers'];

const ctx = (now: Date = NOW, over: Partial<AuthnContext> = {}): AuthnContext => ({ now, purpose: 'request', ...over });
const bearer = (token: unknown): Credentials => ({ kind: 'bearer', token } as Credentials);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const throttleId = (token: string): string => `jwt:${sha256(`authn-jwt-throttle:${token}`).slice(0, 32)}`;
const without = (o: Record<string, unknown>, ...keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: ISSUER, aud: AUDIENCE, sub: SUBJECT, iat: NOW_S, exp: NOW_S + 300, ...over });
const sign = (key: KitKeyPair, over: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string => signCompactJws({ alg: key.alg, kid: key.kid, typ: 'JWT', ...header }, claims(over), key);
const jwkOf = (key: KitKeyPair): Record<string, unknown> => ({ ...key.publicJwk, kid: key.kid, alg: key.alg, use: 'sig' });

/** A loopback http server that answers every GET with `status` and counts the GETs. */
async function startFailingServer(status: number): Promise<{ url: string; hits(): number; close(): Promise<void> }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(status).end('nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/jwks.json`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** A loopback http server whose answer the test sets with `answer`; counts the GETs. */
async function startScriptedServer(): Promise<{ url: string; hits(): number; answer(status: number, body: unknown): void; close(): Promise<void> }> {
  let hits = 0;
  let status = 200;
  let body = '{"keys":[]}';
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(status, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/jwks.json`,
    hits: () => hits,
    answer(nextStatus, nextBody) {
      status = nextStatus;
      body = typeof nextBody === 'string' ? nextBody : JSON.stringify(nextBody);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

describe('JwtBearerStrategy', function () {
  this.timeout(15000);

  let kp1: KitKeyPair;
  let kp2: KitKeyPair;
  let jwks: JwksServer;
  let saved: unknown;

  const config = () => DI.get(Configuration)!;
  const setIssuers = (issuers: unknown) => config().set(ISSUERS_PATH, issuers);
  const remote = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ issuer: ISSUER, audience: AUDIENCE, jwksUri: jwks.url, algorithms: ['EdDSA', 'ES256'], ...over });

  /** Boots the issuers through the schema, as an app does, then the strategy. */
  async function make(issuers: unknown): Promise<JwtBearerStrategy> {
    const { child } = await boot([AUTHN_CONFIGURATION_SCHEMA], { authn: { jwt: { issuers } } });
    const s = readingFrom(new JwtBearerStrategy(), child);
    await s.resolve();
    return s;
  }

  async function bootError(issuers: unknown): Promise<unknown> {
    return make(issuers).then(
      () => null,
      (e: unknown) => e,
    );
  }

  before(async () => {
    await bootV3Db();
    saved = config().get(ISSUERS_PATH);
    kp1 = generateKeyPair('EdDSA');
    kp2 = generateKeyPair('ES256');
    jwks = await startJwksServer([kp1]);
  });

  after(async () => {
    await jwks.close();
    await shutdownV3Db();
  });

  beforeEach(() => {
    jwks.setKeys([kp1]);
  });

  afterEach(async () => {
    setIssuers(saved);
    await disposeBooted();
  });

  describe('shape and boot', () => {
    it('is a non-interactive bearer strategy named jwt, registered as an AuthenticationStrategy', () => {
      const s = new JwtBearerStrategy();
      expect(s).to.be.instanceOf(AuthenticationStrategy);
      expect(s.name).to.equal('jwt');
      expect(s.kinds).to.deep.equal(['bearer']);
      expect(s.interactive).to.equal(false);
      expect(DI.getRegisteredTypes(AuthenticationStrategy)).to.include(JwtBearerStrategy);
    });

    it('boots without issuers and then accepts nothing', async () => {
      const s = await make(undefined);
      const token = sign(kp1);
      expect(s.accepts(bearer(token))).to.equal(false);
      expect(s.throttleKeys(bearer(token), ctx())).to.deep.equal([]);
      expect(await s.verify(bearer(token), ctx())).to.deep.equal({ ok: false, reason: 'unsupported_credentials' });
    });

    it('resolves through DI', async () => {
      // Configuration.set bypasses the schema, so the members it would default are given here.
      setIssuers([remote({ clockSkewSeconds: 30, subjectClaim: 'sub' })]);
      try {
        const s = await DI.resolve(JwtBearerStrategy);
        expect(s).to.be.instanceOf(JwtBearerStrategy);
        expect((await s.verify(bearer(sign(kp1)), ctx())).ok).to.equal(true);
      } finally {
        DI.uncache(JwtBearerStrategy);
      }
    });

    it('accepts the issuer shapes the rules allow', async () => {
      const allowed: Array<[string, Record<string, unknown>]> = [
        ['https jwksUri', remote({ jwksUri: 'https://idp.example.com/.well-known/jwks.json' })],
        ['http on localhost', remote({ jwksUri: 'http://localhost:8080/jwks.json' })],
        ['http on 127.0.0.0/8', remote({ jwksUri: 'http://127.10.20.30/jwks.json' })],
        ['http on [::1]', remote({ jwksUri: 'http://[::1]:9000/jwks.json' })],
        ['local keys', without(remote({ keys: [jwkOf(kp1), jwkOf(kp2)] }), 'jwksUri')],
        ['an RSA key', without(remote({ keys: [generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })], algorithms: ['RS256', 'PS256'] }), 'jwksUri')],
        ['every allowed algorithm', remote({ algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'] })],
        ['skew 0', remote({ clockSkewSeconds: 0 })],
        ['skew 60', remote({ clockSkewSeconds: 60 })],
        ['a custom subject claim and provider', remote({ subjectClaim: 'oid', provider: 'jwt:corp' })],
        ['a key without alg, use or key_ops', without(remote({ keys: [{ ...kp1.publicJwk }] }), 'jwksUri')],
        ['a key with key_ops verify', without(remote({ keys: [{ ...jwkOf(kp1), key_ops: ['verify'] }] }), 'jwksUri')],
        ['a P-521 key for ES512', without(remote({ keys: [generateKeyPairSync('ec', { namedCurve: 'P-521' }).publicKey.export({ format: 'jwk' })], algorithms: ['ES512'] }), 'jwksUri')],
      ];
      for (const [label, issuer] of allowed) {
        expect(await bootError([issuer]), label).to.equal(null);
      }
    });

    describe('fails boot on', () => {
      const ecPrivate = () => {
        const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
        return { ...jwk, kid: 'p' };
      };
      const rsaPrivate = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
      // Refused by AUTHN_CONFIGURATION_SCHEMA. A scalar of another type (a numeric issuer, a string skew) is coerced
      // by the app validator and then judged as the coerced value, so it is not listed.
      const schemaRows: Array<[string, () => unknown]> = [
        ['issuers that are not an array', () => ({ issuer: ISSUER })],
        ['an issuer that is not an object', () => ['https://idp.unit.test']],
        ['a null issuer', () => [null]],
        ['a missing issuer', () => [without(remote(), 'issuer')]],
        ['an empty issuer', () => [remote({ issuer: '' })]],
        ['a duplicate issuer', () => [remote(), remote({ provider: 'jwt:other' })]],
        ['a linking that is not an object', () => [remote({ linking: true })]],
        ['a linking.jit that is not a boolean', () => [remote({ linking: { jit: 'yes' } })]],
        ['a linking.byVerifiedEmail (a bearer JWT never links by email)', () => [remote({ linking: { byVerifiedEmail: true } })]],
        ['a missing audience', () => [without(remote(), 'audience')]],
        ['an empty audience', () => [remote({ audience: '' })]],
        ['an audience array', () => [remote({ audience: [AUDIENCE] })]],
        ['both jwksUri and keys', () => [remote({ keys: [jwkOf(kp1)] })]],
        ['neither jwksUri nor keys', () => [without(remote(), 'jwksUri')]],
        ['a jwksUri that is not a URL', () => [remote({ jwksUri: 'not a url' })]],
        ['a non-string jwksUri', () => [remote({ jwksUri: 42 })]],
        ['empty keys', () => [without(remote({ keys: [] }), 'jwksUri')]],
        ['keys that are not an array', () => [without(remote({ keys: jwkOf(kp1) }), 'jwksUri')]],
        ['a key that is not an object', () => [without(remote({ keys: ['key'] }), 'jwksUri')]],
        ['an oct key', () => [without(remote({ keys: [{ kty: 'oct', k: b64url('shared-secret-shared-secret-1234') }] }), 'jwksUri')]],
        ['an EC private key', () => [without(remote({ keys: [ecPrivate()] }), 'jwksUri')]],
        ['an RSA private key', () => [without(remote({ keys: [rsaPrivate()], algorithms: ['RS256'] }), 'jwksUri')]],
        ['an unknown key type', () => [without(remote({ keys: [{ kty: 'XYZ' }] }), 'jwksUri')]],
        ['missing algorithms', () => [without(remote(), 'algorithms')]],
        ['empty algorithms', () => [remote({ algorithms: [] })]],
        ['algorithms that are not an array', () => [remote({ algorithms: 'EdDSA' })]],
        ['the none algorithm', () => [remote({ algorithms: ['EdDSA', 'none'] })]],
        ['an HMAC algorithm', () => [remote({ algorithms: ['EdDSA', 'HS256'] })]],
        ['an unknown algorithm', () => [remote({ algorithms: ['EdDSA', 'Ed448'] })]],
        ['a non-string algorithm', () => [remote({ algorithms: [1] })]],
        ['a negative skew', () => [remote({ clockSkewSeconds: -1 })]],
        ['a skew of 61', () => [remote({ clockSkewSeconds: 61 })]],
        ['a fractional skew', () => [remote({ clockSkewSeconds: 1.5 })]],
        ['an empty subject claim', () => [remote({ subjectClaim: '' })]],
        ['an empty provider', () => [remote({ provider: '' })]],
        ['a provider above 128 characters', () => [remote({ provider: `jwt:${'p'.repeat(125)}` })]],
        ['an unknown member', () => [remote({ clockSkew: 10 })]],
        ['a key whose alg is not in algorithms', () => [without(remote({ keys: [jwkOf(kp2)], algorithms: ['EdDSA'] }), 'jwksUri')]],
        ['an encryption key', () => [without(remote({ keys: [{ ...jwkOf(kp1), use: 'enc' }] }), 'jwksUri')]],
        ['key_ops without verify', () => [without(remote({ keys: [{ ...jwkOf(kp1), key_ops: ['encrypt'] }] }), 'jwksUri')]],
        ['key_ops with sign and verify', () => [without(remote({ keys: [{ ...jwkOf(kp1), key_ops: ['sign', 'verify'] }] }), 'jwksUri')]],
        ['key_ops with verify and encrypt', () => [without(remote({ keys: [{ ...jwkOf(kp1), key_ops: ['verify', 'encrypt'] }] }), 'jwksUri')]],
        ['key_ops with a duplicate', () => [without(remote({ keys: [{ ...jwkOf(kp1), key_ops: ['verify', 'verify'] }] }), 'jwksUri')]],
        ['a non-boolean ext', () => [without(remote({ keys: [{ ...jwkOf(kp1), ext: 'yes' }] }), 'jwksUri')]],
        ['key_ops that are not an array', () => [without(remote({ keys: [{ ...jwkOf(kp1), key_ops: 'verify' }] }), 'jwksUri')]],
      ];

      // Refused by the strategy: a derived provider, a URL scheme, a key that needs crypto to judge.
      const codeRows: Array<[string, () => unknown]> = [
        ['a jwksUri over ftp', () => [remote({ jwksUri: 'ftp://idp.example.com/jwks.json' })]],
        ['a jwksUri over http to a public host', () => [remote({ jwksUri: 'http://idp.example.com/jwks.json' })]],
        ['a jwksUri over http to a private address', () => [remote({ jwksUri: 'http://10.0.0.1/jwks.json' })]],
        ['a jwksUri over http to a host named like loopback', () => [remote({ jwksUri: 'http://127.0.0.1.example.com/jwks.json' })]],
        ['a malformed public key', () => [without(remote({ keys: [{ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' }] }), 'jwksUri')]],
        ['a default provider above 128 characters', () => [remote({ issuer: `https://${'i'.repeat(120)}.test` })]],
        ['two issuers with one provider', () => [remote({ provider: 'jwt:shared' }), remote({ issuer: 'https://other.unit.test', provider: 'jwt:shared' })]],
        ['a key whose alg does not fit its type', () => [without(remote({ keys: [{ ...jwkOf(kp1), alg: 'ES256' }] }), 'jwksUri')]],
        ['an X25519 key', () => [without(remote({ keys: [generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' })] }), 'jwksUri')]],
        ['an Ed448 key, which jose never selects for EdDSA', () => [without(remote({ keys: [generateKeyPairSync('ed448').publicKey.export({ format: 'jwk' })] }), 'jwksUri')]],
        ['an RSA key under 2048 bits', () => [without(remote({ keys: [generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' })], algorithms: ['RS256'] }), 'jwksUri')]],
        ['an EC key on a curve no algorithm allows', () => [without(remote({ keys: [generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' })] }), 'jwksUri')]],
        ['an RSA key without an RSA algorithm', () => [without(remote({ keys: [generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })] }), 'jwksUri')]],
      ];

      for (const [label, issuers] of schemaRows) {
        it(`${label} (schema)`, async () => {
          const err = await bootError(issuers());
          expect(err, label).to.be.instanceOf(InvalidConfiguration);
          expect((err as InvalidConfiguration).violations.map((v) => v.path), label).to.satisfy((paths: string[]) => paths.some((path) => path.startsWith('authn.jwt.issuers')));
        });
      }

      for (const [label, issuers] of codeRows) {
        it(label, async () => {
          const err = await bootError(issuers());
          expect(err, label).to.be.instanceOf(Error);
          expect(err, label).to.not.be.instanceOf(InvalidConfiguration);
          expect((err as Error).message, label).to.match(/authn\.jwt\.issuers/);
        });
      }
    });
  });

  describe('linking switches (K6)', () => {
    it('allows JIT only for an issuer whose linking.jit is on, and never linking by email', async () => {
      const s = await make([remote({ linking: { jit: true } }), remote({ issuer: 'https://other.unit.test', provider: 'jwt:other' })]);
      expect(s.linkingFor({ provider: `jwt:${ISSUER}`, subject: 'a' })).to.deep.equal({ jit: true, byVerifiedEmail: false });
      expect(s.linkingFor({ provider: 'jwt:other', subject: 'a' })).to.deep.equal({ jit: false, byVerifiedEmail: false });
      expect(s.linkingFor({ provider: 'oidc:corp', subject: 'a' })).to.deep.equal({ jit: false, byVerifiedEmail: false });
    });

    it('defaults to off', async () => {
      const s = await make([remote()]);
      expect(s.linkingFor({ provider: `jwt:${ISSUER}`, subject: 'a' })).to.deep.equal({ jit: false, byVerifiedEmail: false });
    });
  });

  describe('credentials outside the JWT format', () => {
    const rows: Array<[string, () => unknown]> = [
      ['a password credential', () => ({ kind: 'password', login: 'a.b.c', password: 'a.b.c' })],
      ['a non-bearer kind with a JWT', () => ({ kind: 'jws-assertion', token: sign(kp1) })],
      ['a bearer without a token', () => ({ kind: 'bearer' })],
      ['a bearer with a numeric token', () => ({ kind: 'bearer', token: 7 })],
      ['a bearer with an object token', () => ({ kind: 'bearer', token: { toString: () => sign(kp1) } })],
      ['two parts', () => bearer(sign(kp1).split('.').slice(0, 2).join('.'))],
      ['four parts', () => bearer(`${sign(kp1)}.x`)],
      ['an empty first part', () => bearer(`.${sign(kp1).split('.').slice(1).join('.')}`)],
      ['padding characters', () => bearer(`${sign(kp1)}=`)],
      ['an API token', () => bearer(`spt_${'a'.repeat(43)}`)],
      ['a value above 8192 characters', () => bearer(sign(kp1, { pad: 'x'.repeat(8192) }))],
      ['null', () => null],
      ['undefined', () => undefined],
      [
        'a throwing token getter',
        () =>
          Object.defineProperty({ kind: 'bearer' }, 'token', {
            get() {
              throw new Error('hostile getter');
            },
          }),
      ],
      [
        'a throwing proxy',
        () =>
          new Proxy(
            {},
            {
              get() {
                throw new Error('hostile proxy');
              },
            },
          ),
      ],
    ];

    for (const [label, c] of rows) {
      it(`${label}: not accepted, no keys, unsupported_credentials, no JWKS fetch`, async () => {
        const s = await make([remote()]);
        const before = jwks.hits();
        const creds = c() as Credentials;
        expect(s.accepts(creds)).to.equal(false);
        expect(s.throttleKeys(creds, ctx(NOW, { ip: '192.0.2.1' }))).to.deep.equal([]);
        expect(await s.verify(creds, ctx())).to.deep.equal({ ok: false, reason: 'unsupported_credentials' });
        expect(jwks.hits() - before).to.equal(0);
      });
    }

    it('accepts a value of exactly 8192 characters and nothing longer', async () => {
      const s = await make([remote()]);
      const token = sign(kp1, { pad: 'x'.repeat(5000) });
      const exact = `${token}${'A'.repeat(8192 - token.length)}`;
      expect(exact.length).to.equal(8192);
      expect(s.accepts(bearer(exact))).to.equal(true);
      expect(s.accepts(bearer(`${exact}A`))).to.equal(false);
    });

    it('reads the token once per call', async () => {
      const s = await make([remote()]);
      const values = [sign(kp1), `spt_${'b'.repeat(43)}`];
      let reads = 0;
      const shifting = Object.defineProperty({ kind: 'bearer' }, 'token', { get: () => values[Math.min(reads++, 1)] }) as Credentials;
      expect((await s.verify(shifting, ctx())).ok).to.equal(true);
      expect(reads).to.equal(1);
    });
  });

  describe('throttle keys', () => {
    it('answers account and account-ip keys from a domain-separated hash of the token', async () => {
      const s = await make([remote()]);
      const token = sign(kp1);
      const id = throttleId(token);
      expect(id).to.match(/^jwt:[0-9a-f]{32}$/);
      expect(s.throttleKeys(bearer(token), ctx(NOW, { ip: '192.0.2.1' }))).to.deep.equal([
        { kind: 'account', value: id },
        { kind: 'account-ip', value: `${id}|192.0.2.1` },
      ]);
      expect(s.throttleKeys(bearer(token), ctx())).to.deep.equal([
        { kind: 'account', value: id },
        { kind: 'account-ip', value: `${id}|` },
      ]);
    });

    it('is stable, differs per token and carries neither the token, its parts, its SHA-256 nor its claims', async () => {
      const s = await make([remote()]);
      const token = sign(kp1);
      const other = sign(kp1, { jti: 'other' });
      const c = ctx(NOW, { ip: '192.0.2.1' });
      const keys = s.throttleKeys(bearer(token), c);
      expect(s.throttleKeys(bearer(token), c)).to.deep.equal(keys);
      expect(s.throttleKeys(bearer(other), c)).to.not.deep.equal(keys);
      for (const key of keys) {
        for (const secret of [token, ...token.split('.'), sha256(token), sha256(token).slice(0, 32), ISSUER, SUBJECT]) {
          expect(key.value).to.not.contain(secret);
        }
      }
    });

    it('never fetches the JWKS', async () => {
      const s = await make([remote()]);
      const before = jwks.hits();
      s.throttleKeys(bearer(sign(kp1)), ctx());
      expect(jwks.hits() - before).to.equal(0);
    });
  });

  describe('verify', () => {
    it('answers the external subject with the verified claims, method jwt and nothing else', async () => {
      const s = await make([remote()]);
      const token = sign(kp1, { email: 'alice@example.test', email_verified: true, name: 'Alice' });
      const outcome = await s.verify(bearer(token), ctx());
      expect(Object.keys(outcome).sort()).to.deep.equal(['external', 'method', 'ok']);
      expect(outcome).to.deep.equal({
        ok: true,
        method: 'jwt',
        external: {
          provider: `jwt:${ISSUER}`,
          subject: SUBJECT,
          email: 'alice@example.test',
          claims: claims({ email: 'alice@example.test', email_verified: true, name: 'Alice' }),
        },
      });
      const external = (outcome as Extract<StrategyOutcome, { ok: true }>).external!;
      expect(external).to.not.have.property('emailVerified');
    });

    it('omits an email claim that is not a string of at most 255 characters', async () => {
      const s = await make([remote()]);
      for (const email of [42, ['a@example.test'], `${'a'.repeat(244)}@example.test`]) {
        const outcome = await s.verify(bearer(sign(kp1, { email })), ctx());
        expect(outcome.ok, JSON.stringify(email)).to.equal(true);
        expect((outcome as Extract<StrategyOutcome, { ok: true }>).external, JSON.stringify(email)).to.not.have.property('email');
      }
    });

    it('uses the configured provider and subject claim', async () => {
      const s = await make([remote({ subjectClaim: 'oid', provider: 'jwt:corp' })]);
      const outcome = await s.verify(bearer(sign(kp1, { oid: 'object-7' })), ctx());
      expect((outcome as Extract<StrategyOutcome, { ok: true }>).external).to.include({ provider: 'jwt:corp', subject: 'object-7' });
    });

    it('verifies a local keys issuer without any fetch', async () => {
      const before = jwks.hits();
      const s = await make([without(remote({ keys: [jwkOf(kp2)] }), 'jwksUri')]);
      expect((await s.verify(bearer(sign(kp2)), ctx())).ok).to.equal(true);
      expect(await s.verify(bearer(sign(kp1)), ctx())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
      expect(jwks.hits() - before).to.equal(0);
    });

    it('checks a token only against the keys of the issuer it names', async () => {
      const OTHER = 'https://other.unit.test';
      const s = await make([remote(), without(remote({ issuer: OTHER, keys: [jwkOf(kp2)] }), 'jwksUri')]);
      expect((await s.verify(bearer(sign(kp2, { iss: OTHER })), ctx())).ok).to.equal(true);
      expect(await s.verify(bearer(sign(kp1, { iss: OTHER })), ctx())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
      expect(await s.verify(bearer(sign(kp2)), ctx()), 'the other issuer key for this issuer').to.deep.equal({ ok: false, reason: 'invalid_credentials' });
    });

    it('takes the current time from ctx.now', async () => {
      const s = await make([remote()]);
      const past = new Date('2020-01-01T00:00:00.000Z');
      const pastS = past.getTime() / 1000;
      const token = sign(kp1, { iat: pastS, exp: pastS + 300 });
      expect((await s.verify(bearer(token), ctx(past))).ok).to.equal(true);
      expect(await s.verify(bearer(token), ctx())).to.deep.equal({ ok: false, reason: 'expired' });
    });

    describe('refusals', () => {
      const refused = async (s: JwtBearerStrategy, token: string, reason = 'invalid_credentials', c: AuthnContext = ctx()) => {
        expect({ ...(await s.verify(bearer(token), c)) }).to.deep.equal({ ok: false, reason });
      };

      it('an issuer that is not configured, without a fetch', async () => {
        const s = await make([remote()]);
        const before = jwks.hits();
        await refused(s, sign(kp1, { iss: 'https://other.unit.test' }));
        await refused(s, sign(kp1, { iss: `${ISSUER}/` }));
        await refused(s, sign(kp1, { iss: undefined }));
        await refused(s, sign(kp1, { iss: [ISSUER] }));
        expect(jwks.hits() - before).to.equal(0);
      });

      it('an undecodable token', async () => {
        const s = await make([remote()]);
        await refused(s, 'abc.def.ghi');
        await refused(s, compactJws([b64url('{"alg":"EdDSA"}'), b64url('not json'), 'sig']));
        await refused(s, compactJws([b64url('not json'), b64url(JSON.stringify(claims())), 'sig']));
      });

      it('a wrong audience', async () => {
        const s = await make([remote()]);
        await refused(s, sign(kp1, { aud: 'other' }));
        await refused(s, sign(kp1, { aud: undefined }));
      });

      it('alg none, without a fetch', async () => {
        const s = await make([remote()]);
        const before = jwks.hits();
        await refused(s, compactJws([b64url(JSON.stringify({ alg: 'none', kid: kp1.kid, typ: 'JWT' })), b64url(JSON.stringify(claims())), '']));
        expect(jwks.hits() - before).to.equal(0);
      });

      it('HS256 signed with the public JWK as the secret', async () => {
        const s = await make([remote()]);
        for (const secret of [JSON.stringify(kp1.publicJwk), JSON.stringify(jwkOf(kp1)), kp1.publicJwk.x]) {
          await refused(s, signCompactJws({ alg: 'HS256', kid: kp1.kid, typ: 'JWT' }, claims(), { hmacKey: Buffer.from(secret) }));
        }
      });

      it('an algorithm outside the issuer list, even with the key served', async () => {
        jwks.setKeys([kp1, kp2]);
        const s = await make([remote({ algorithms: ['EdDSA'] })]);
        await refused(s, sign(kp2));
      });

      it('a missing exp', async () => {
        const s = await make([remote()]);
        await refused(s, sign(kp1, { exp: undefined }));
        await refused(s, sign(kp1, { exp: String(NOW_S + 300) }));
      });

      it('exp beyond the skew is expired; within it is accepted', async () => {
        const s = await make([remote()]);
        await refused(s, sign(kp1, { exp: NOW_S - 31 }), 'expired');
        await refused(s, sign(kp1, { exp: NOW_S - 30 }), 'expired');
        expect((await s.verify(bearer(sign(kp1, { exp: NOW_S - 29 })), ctx())).ok).to.equal(true);
        const tight = await make([remote({ clockSkewSeconds: 0 })]);
        await refused(tight, sign(kp1, { exp: NOW_S }), 'expired');
      });

      it('an expired token with a bad signature is invalid, not expired', async () => {
        const s = await make([remote()]);
        const good = sign(kp1, { exp: NOW_S - 60 });
        const [h, p] = good.split('.');
        await refused(s, `${h}.${p}.${sign(kp1).split('.')[2]}`);
      });

      it('nbf beyond the skew; within it is accepted', async () => {
        const s = await make([remote()]);
        await refused(s, sign(kp1, { nbf: NOW_S + 31 }));
        expect((await s.verify(bearer(sign(kp1, { nbf: NOW_S + 30 })), ctx())).ok).to.equal(true);
      });

      it('a client assertion typ, in any spelling', async () => {
        const s = await make([remote()]);
        for (const typ of ['spinajs-client+jwt', 'SpinaJS-Client+JWT', 'application/spinajs-client+jwt']) {
          await refused(s, sign(kp1, {}, { typ }));
        }
      });

      it('a missing, non-string, empty or 256-character subject; 255 characters pass', async () => {
        const s = await make([remote()]);
        for (const sub of [undefined, 42, { id: 1 }, '', 's'.repeat(256)]) {
          await refused(s, sign(kp1, { sub }));
        }
        const outcome = await s.verify(bearer(sign(kp1, { sub: 's'.repeat(255) })), ctx());
        expect((outcome as Extract<StrategyOutcome, { ok: true }>).external?.subject).to.equal('s'.repeat(255));
      });

      it('a subject claim found only on the prototype', async () => {
        const s = await make([remote({ subjectClaim: 'constructor' })]);
        await refused(s, sign(kp1));
      });

      it('a bad signature', async () => {
        const s = await make([remote()]);
        const [h, p] = sign(kp1).split('.');
        await refused(s, `${h}.${p}.${sign(kp1, { sub: 'other' }).split('.')[2]}`);
        await refused(s, `${h}.${p}.`);
        await refused(s, sign(generateKeyPair('EdDSA'), {}, { kid: kp1.kid }));
      });

      it('an unknown kid', async () => {
        const s = await make([remote()]);
        await refused(s, sign(kp2));
      });

      it('a context without a valid now, before any JWKS fetch', async () => {
        const s = await make([remote()]);
        const before = jwks.hits();
        const nows: unknown[] = [new Date(Number.NaN), new Date('not a date'), NOW.getTime(), NOW.toISOString(), { getTime: () => NOW.getTime() }, Object.create(Date.prototype), undefined];
        for (const now of nows) {
          await refused(s, sign(kp1), 'invalid_credentials', { purpose: 'request', now } as unknown as AuthnContext);
        }
        await refused(s, sign(kp1), 'invalid_credentials', null as unknown as AuthnContext);
        expect(jwks.hits() - before).to.equal(0);
      });

      it('reads ctx.now once and verifies at that instant', async () => {
        const s = await make([remote()]);
        const past = new Date('2020-01-01T00:00:00.000Z');
        const pastS = past.getTime() / 1000;
        let reads = 0;
        const c = Object.defineProperty({ purpose: 'request' }, 'now', { get: () => (reads++ === 0 ? past : NOW) }) as AuthnContext;
        expect((await s.verify(bearer(sign(kp1, { iat: pastS, exp: pastS + 300 })), c)).ok).to.equal(true);
        expect(reads).to.equal(1);
      });
    });

    describe('JWKS failures', () => {
      it('a JWKS server that is down: invalid_credentials, no throw, a warning without the token', async () => {
        const down = await startFailingServer(200);
        await down.close();
        const s = await make([remote({ jwksUri: down.url })]);
        const warnings: unknown[][] = [];
        Object.defineProperty(s, 'Log', { value: { warn: (...args: unknown[]) => warnings.push(args) } });

        const token = sign(kp1);
        expect(await s.verify(bearer(token), ctx())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
        expect(warnings.length).to.equal(1);
        const logged = JSON.stringify(warnings[0], (_k, v: unknown) => (v instanceof Error ? v.message : v));
        expect(logged).to.contain(ISSUER);
        for (const part of token.split('.')) {
          expect(logged).to.not.contain(part);
        }
      });

      it('fetches a failing JWKS at most once a minute', async () => {
        const failing = await startFailingServer(500);
        const clock = new FakeClock();
        clock.install();
        try {
          const s = await make([remote({ jwksUri: failing.url })]);
          const warnings: unknown[][] = [];
          Object.defineProperty(s, 'Log', { value: { warn: (...args: unknown[]) => warnings.push(args) } });
          const at = () => ctx(clock.now());
          const iatNow = () => Math.floor(clock.now().getTime() / 1000);
          const token = () => sign(kp1, { iat: iatNow(), exp: iatNow() + 300 });

          expect(await s.verify(bearer(token()), at())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
          for (const seconds of [1, 30, 28]) {
            clock.tick(seconds * 1000);
            expect(await s.verify(bearer(token()), at())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
          }
          expect(failing.hits(), 'fetches in 59 s').to.equal(1);
          expect(warnings.length).to.equal(1);

          clock.tick(2000);
          expect(await s.verify(bearer(token()), at())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
          expect(failing.hits(), 'fetches in 61 s').to.equal(2);
        } finally {
          clock.uninstall();
          await failing.close();
        }
      });

      it('keeps verifying known keys from the cached set while a refresh for an unknown kid fails', async () => {
        const clock = new FakeClock();
        clock.install();
        const flaky = await startJwksServer([kp1]);
        try {
          const s = await make([remote({ jwksUri: flaky.url })]);
          Object.defineProperty(s, 'Log', { value: { warn: () => undefined } });
          const at = () => ctx(clock.now());
          const iatNow = () => Math.floor(clock.now().getTime() / 1000);
          const token = (key: KitKeyPair) => sign(key, { iat: iatNow(), exp: iatNow() + 300 });

          expect((await s.verify(bearer(token(kp1)), at())).ok).to.equal(true);
          clock.tick(61_000);
          await flaky.close();
          expect(await s.verify(bearer(token(kp2)), at())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
          clock.tick(1000);
          expect((await s.verify(bearer(token(kp1)), at())).ok).to.equal(true);
          expect(await s.verify(bearer(token(kp2)), at())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
        } finally {
          clock.uninstall();
          await flaky.close().catch(() => undefined);
        }
      });

      it('logs one warning per failed fetch, however many requests wait on it', async () => {
        const failing = await startFailingServer(500);
        try {
          const s = await make([remote({ jwksUri: failing.url })]);
          const warnings: unknown[][] = [];
          Object.defineProperty(s, 'Log', { value: { warn: (...args: unknown[]) => warnings.push(args) } });

          const outcomes = await Promise.all(Array.from({ length: 5 }, () => s.verify(bearer(sign(kp1)), ctx())));
          for (const outcome of outcomes) {
            expect(outcome).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
          }
          expect(failing.hits()).to.equal(1);
          expect(warnings.length).to.equal(1);
        } finally {
          await failing.close();
        }
      });

      it('does not import the cached keys again on every request while a refresh is failing', async () => {
        const clock = new FakeClock();
        clock.install();
        const flaky = await startJwksServer([kp1]);
        const subtle = globalThis.crypto.subtle;
        const importKey = subtle.importKey;
        let imports = 0;
        try {
          const s = await make([remote({ jwksUri: flaky.url })]);
          Object.defineProperty(s, 'Log', { value: { warn: () => undefined } });
          const at = () => ctx(clock.now());
          const iatNow = () => Math.floor(clock.now().getTime() / 1000);
          const token = (key: KitKeyPair) => sign(key, { iat: iatNow(), exp: iatNow() + 300 });

          expect((await s.verify(bearer(token(kp1)), at())).ok).to.equal(true);
          clock.tick(61_000);
          await flaky.close();
          expect(await s.verify(bearer(token(kp2)), at())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });

          Object.defineProperty(subtle, 'importKey', {
            configurable: true,
            writable: true,
            value: function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto['importKey']>) {
              imports += 1;
              return (importKey as (...a: unknown[]) => unknown).apply(this, args);
            },
          });
          for (let i = 0; i < 3; i++) {
            clock.tick(1000);
            expect((await s.verify(bearer(token(kp1)), at())).ok).to.equal(true);
          }
          expect(imports).to.equal(0);
        } finally {
          delete (subtle as unknown as Record<string, unknown>).importKey;
          clock.uninstall();
          await flaky.close().catch(() => undefined);
        }
      });

      it('refuses a known key once the cached set is older than ten minutes, even inside a failure window', async () => {
        const clock = new FakeClock();
        clock.install();
        const server = await startScriptedServer();
        try {
          server.answer(200, { keys: [jwkOf(kp1)] });
          const s = await make([remote({ jwksUri: server.url })]);
          Object.defineProperty(s, 'Log', { value: { warn: () => undefined } });
          const at = () => ctx(clock.now());
          const iatNow = () => Math.floor(clock.now().getTime() / 1000);
          const token = (key: KitKeyPair) => sign(key, { iat: iatNow(), exp: iatNow() + 300 });
          const refusedNow = { ok: false, reason: 'invalid_credentials' };

          expect((await s.verify(bearer(token(kp1)), at())).ok).to.equal(true);
          clock.tick(595_000);
          server.answer(500, 'down');
          expect(await s.verify(bearer(token(kp2)), at())).to.deep.equal(refusedNow);
          expect(server.hits(), 'the failed refresh').to.equal(2);

          clock.tick(1_000);
          expect((await s.verify(bearer(token(kp1)), at())).ok, 'cached set 596 s old').to.equal(true);
          clock.tick(5_000);
          expect(await s.verify(bearer(token(kp1)), at()), 'cached set 601 s old').to.deep.equal(refusedNow);
          expect(server.hits(), 'no fetch inside the window').to.equal(2);

          clock.tick(55_000);
          expect(await s.verify(bearer(token(kp1)), at())).to.deep.equal(refusedNow);
          expect(server.hits(), 'one fetch after the window').to.equal(3);
        } finally {
          clock.uninstall();
          await server.close();
        }
      });

      const unusableMembers: Array<[string, () => Record<string, unknown>]> = [
        ['private key material', () => ({ ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'bad', alg: 'ES256', use: 'sig' })],
        ['a malformed key', () => ({ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB', kid: 'bad', alg: 'ES256', use: 'sig' })],
      ];
      for (const [label, member] of unusableMembers) {
        it(`a token choosing a JWKS member with ${label} by kid does not hold back a rotated key or log a fetch failure`, async () => {
          const clock = new FakeClock();
          clock.install();
          const server = await startScriptedServer();
          try {
            const bad = member();
            server.answer(200, { keys: [jwkOf(kp1), bad] });
            const s = await make([remote({ jwksUri: server.url })]);
            const warnings: unknown[][] = [];
            Object.defineProperty(s, 'Log', { value: { warn: (...args: unknown[]) => warnings.push(args) } });
            const at = () => ctx(clock.now());
            const iatNow = () => Math.floor(clock.now().getTime() / 1000);
            const token = (key: KitKeyPair, header: Record<string, unknown> = {}) => sign(key, { iat: iatNow(), exp: iatNow() + 300 }, header);

            expect((await s.verify(bearer(token(kp1)), at())).ok).to.equal(true);
            clock.tick(61_000);
            expect(await s.verify(bearer(token(kp2, { kid: 'bad' })), at())).to.deep.equal({ ok: false, reason: 'invalid_credentials' });

            server.answer(200, { keys: [jwkOf(kp1), bad, jwkOf(kp2)] });
            clock.tick(1_000);
            expect((await s.verify(bearer(token(kp2)), at())).ok, 'the rotated key').to.equal(true);
            expect(server.hits()).to.equal(2);
            expect(warnings).to.deep.equal([]);
          } finally {
            clock.uninstall();
            await server.close();
          }
        });
      }
    });
  });
});
