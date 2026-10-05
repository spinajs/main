import 'mocha';
import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';
import { Configuration } from '@spinajs/configuration';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

import authnToken from '../../src/config/authn-token.js';
import { SecureRandomTokenProvider } from '../../src/generator.js';
import { JwtBearerStrategy } from '../../src/jwt/JwtBearerStrategy.js';
import { TokenStrategy } from '../../src/strategy/TokenStrategy.js';
import type { TokenService } from '@spinajs/authn/contracts';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const bad = (authn: Record<string, unknown>) => violationsOf(SCHEMAS, { authn });

const ISSUER = { issuer: 'https://id.example.com', audience: 'api', algorithms: ['ES256'], jwksUri: 'https://id.example.com/jwks' };
const issuers = (...items: Record<string, unknown>[]) => ({ jwt: { issuers: items } });

async function jwtBootError(...items: Record<string, unknown>[]): Promise<string> {
  const { child } = await boot(SCHEMAS, { authn: issuers(...items) });
  try {
    await readingFrom(new JwtBearerStrategy(), child).resolve();
    return '';
  } catch (e) {
    return String(e);
  }
}

describe('authn.token and authn.jwt through the schema', () => {
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('fills authn.token in whole', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.token')).to.deep.include({ prefix: 'spt_', length: 32, maxTtlDays: 90, defaultTtlDays: 30, agentMaxTtlMinutes: 1440, headerName: 'x-api-key', lastUsedUpdateInterval: 60 });
    });

    it('equals the shipped package config', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      const shipped = authnToken.authn.token;
      for (const key of ['prefix', 'length', 'maxTtlDays', 'defaultTtlDays', 'agentMaxTtlMinutes', 'headerName', 'lastUsedUpdateInterval'] as const) {
        expect(configuration.get(`authn.token.${key}`), key).to.eq(shipped[key]);
      }
    });

    it('has no issuer by default, and gives an issuer its skew and subject claim', async () => {
      expect((await boot(SCHEMAS, {})).configuration.get('authn.jwt.issuers')).to.deep.eq([]);
      const { configuration } = await boot(SCHEMAS, { authn: issuers(ISSUER) });
      expect(configuration.get('authn.jwt.issuers.0')).to.deep.include({ clockSkewSeconds: 30, subjectClaim: 'sub' });
    });
  });

  describe('authn.token violations', () => {
    it('names the bad key', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ prefix: '' }, 'authn.token.prefix'],
        [{ length: 31 }, 'authn.token.length'],
        [{ length: 32.5 }, 'authn.token.length'],
        [{ maxTtlDays: 0 }, 'authn.token.maxTtlDays'],
        [{ defaultTtlDays: 0 }, 'authn.token.defaultTtlDays'],
        [{ agentMaxTtlMinutes: 0 }, 'authn.token.agentMaxTtlMinutes'],
        [{ headerName: '' }, 'authn.token.headerName'],
        [{ lastUsedUpdateInterval: -1 }, 'authn.token.lastUsedUpdateInterval'],
        [{ lastUsedUpdateInterval: 'sixty' }, 'authn.token.lastUsedUpdateInterval'],
      ];
      for (const [token, path] of cases) expect(await bad({ token }), JSON.stringify(token)).to.include(path);
    });
  });

  describe('authn.jwt.issuers violations', () => {
    it('names the bad member', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ ...ISSUER, audience: undefined }, 'authn.jwt.issuers.0.audience'],
        [{ ...ISSUER, issuer: '' }, 'authn.jwt.issuers.0.issuer'],
        [{ ...ISSUER, algorithms: ['HS256'] }, 'authn.jwt.issuers.0.algorithms.0'],
        [{ ...ISSUER, algorithms: [] }, 'authn.jwt.issuers.0.algorithms'],
        [{ ...ISSUER, clockSkewSeconds: 61 }, 'authn.jwt.issuers.0.clockSkewSeconds'],
        [{ ...ISSUER, subjectClaim: '' }, 'authn.jwt.issuers.0.subjectClaim'],
        [{ ...ISSUER, provider: 'p'.repeat(129) }, 'authn.jwt.issuers.0.provider'],
        [{ ...ISSUER, jwksUri: 'not a uri' }, 'authn.jwt.issuers.0.jwksUri'],
        [{ ...ISSUER, typo: 1 }, 'authn.jwt.issuers.0.typo'],
        [{ ...ISSUER, linking: { jit: true, byVerifiedEmail: true } }, 'authn.jwt.issuers.0.linking.byVerifiedEmail'],
        [{ ...ISSUER, linking: { jit: 'sometimes' } }, 'authn.jwt.issuers.0.linking.jit'],
        [{ ...ISSUER, keys: [{ kty: 'OKP' }] }, 'authn.jwt.issuers.0'],
        [{ ...ISSUER, jwksUri: undefined }, 'authn.jwt.issuers.0'],
      ];
      for (const [issuer, path] of cases) expect(await bad(issuers(issuer)), path).to.include(path);
    });

    it('refuses a repeated issuer', async () => {
      expect(await bad(issuers(ISSUER, { ...ISSUER, audience: 'other' }))).to.include('authn.jwt.issuers');
    });

    it('names a key that is private, symmetric, of another use or of an unknown type', async () => {
      const local = { ...ISSUER, jwksUri: undefined, algorithms: ['ES256'] };
      const key = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
      const cases: [Record<string, unknown>, string][] = [
        [{ ...key, d: 'secret' }, 'authn.jwt.issuers.0.keys.0'],
        [{ kty: 'oct', k: 'secret' }, 'authn.jwt.issuers.0.keys.0.kty'],
        [{ ...key, use: 'enc' }, 'authn.jwt.issuers.0.keys.0.use'],
        [{ ...key, key_ops: ['sign', 'verify'] }, 'authn.jwt.issuers.0.keys.0.key_ops'],
        [{ ...key, ext: 'maybe' }, 'authn.jwt.issuers.0.keys.0.ext'],
        [{ ...key, alg: 'ES384' }, 'authn.jwt.issuers.0.keys.0.alg'],
      ];
      for (const [jwk, path] of cases) expect(await bad(issuers({ ...local, keys: [jwk] })), path).to.include(path);
      expect(await bad(issuers({ ...local, keys: [{ ...key, use: 'sig', key_ops: ['verify'], alg: 'ES256' }] }))).to.deep.eq([]);
    });
  });

  describe('what the code still checks', () => {
    it('refuses a prefix and length that make a token over 1024 characters', async () => {
      const { child } = await boot(SCHEMAS, { authn: { token: { prefix: 'p'.repeat(1000), length: 300 } } });
      await child.resolve(Configuration);
      const provider = readingFrom(new SecureRandomTokenProvider(), child);
      let error: unknown;
      try {
        await provider.generate();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('longer than 1024');
      const strategy = readingFrom(new TokenStrategy({} as TokenService), child);
      let boot1: unknown;
      try {
        await strategy.resolve();
      } catch (e) {
        boot1 = e;
      }
      expect(String(boot1)).to.contain('longer than 1024');
    });

    it('reads the configured token format through @Config', async () => {
      const { child } = await boot(SCHEMAS, { authn: { token: { prefix: 'acme_', length: 48 } } });
      const token = await readingFrom(new SecureRandomTokenProvider(), child).generate();
      expect(token.Plaintext.startsWith('acme_')).to.eq(true);
      expect(token.Plaintext.length).to.eq('acme_'.length + Math.ceil((48 * 4) / 3));
    });

    it("refuses an issuer whose derived provider is another issuer's provider", async () => {
      expect(await jwtBootError({ ...ISSUER, provider: 'jwt:https://other.example.com' }, { ...ISSUER, issuer: 'https://other.example.com' })).to.match(/provider jwt:https:\/\/other\.example\.com is used by another issuer/);
    });

    // uniqueItemProperties counts a missing member as a value, so a repeated explicit provider is a code check.
    it('refuses a repeated explicit provider, and takes two issuers that both derive theirs', async () => {
      const other = { ...ISSUER, issuer: 'https://other.example.com' };
      expect(await jwtBootError({ ...ISSUER, provider: 'shared' }, { ...other, provider: 'shared' })).to.match(/provider shared is used by another issuer/);
      expect(await bad(issuers(ISSUER, other))).to.deep.eq([]);
      expect(await jwtBootError(ISSUER, other)).to.eq('');
    });

    it('refuses a derived provider over 128 characters', async () => {
      expect(await jwtBootError({ ...ISSUER, issuer: `https://${'i'.repeat(120)}.test` })).to.contain('provider must be at most 128 characters');
    });

    it('refuses an RSA key under 2048 bits and a key that fits none of the algorithms', async () => {
      const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
      const okp = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
      const local = { issuer: 'https://id.example.com', audience: 'api' };
      expect(await jwtBootError({ ...local, algorithms: ['RS256'], keys: [small] })).to.contain('under 2048 bits');
      expect(await jwtBootError({ ...local, algorithms: ['ES256'], keys: [okp] })).to.contain('fits none of the issuer');
      expect(await jwtBootError({ ...local, algorithms: ['EdDSA'], keys: [okp] })).to.eq('');
    });

    it('refuses a jwksUri that is neither https nor a loopback http', async () => {
      expect(await jwtBootError({ ...ISSUER, jwksUri: 'http://id.example.com/jwks' })).to.contain('jwksUri must use https');
    });
  });
});
