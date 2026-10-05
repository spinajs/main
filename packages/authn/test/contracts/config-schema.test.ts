import * as chai from 'chai';
import 'mocha';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { AUTHN_CONFIGURATION_SCHEMA, AUTHN_LEGACY_KEYS } from '../../src/schemas/index.js';
import type { AuthnLegacyKey } from '../../src/schemas/index.js';
import * as root from '../../src/index.js';
import * as contracts from '../../src/contracts/index.js';

const expect = chai.expect;
const require = createRequire(import.meta.url);
const SCHEMAS_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src', 'schemas');

type Json = Record<string, any>;
type Result = { ok: boolean; errors: { instancePath: string; keyword: string; params: Json }[]; config: Json };

// The app validator of packages/configuration/src/configuration.ts (initValidator), option for option.
function appAjv(warnings: string[]): any {
  const Ajv = require('ajv');
  const ajvMergePatch = require('ajv-merge-patch');
  const ajvFormats = require('ajv-formats');
  const ajvKeywords = require('ajv-keywords');
  const options = {
    logger: { log: () => undefined, warn: (...m: unknown[]) => warnings.push(m.join(' ')), error: (...m: unknown[]) => warnings.push(m.join(' ')) },
    allErrors: true,
    removeAdditional: true,
    useDefaults: true,
    coerceTypes: true,
  };
  const ajv = new (Ajv.default ?? Ajv)(options);
  (ajvMergePatch.default ?? ajvMergePatch)(ajv);
  (ajvFormats.default ?? ajvFormats)(ajv);
  (ajvKeywords.default ?? ajvKeywords)(ajv);
  ajv.addKeyword('$configurationModule');
  return ajv;
}

const warnings: string[] = [];
const ajv = appAjv(warnings);

function check(config: Json): Result {
  const ok = ajv.validate(AUTHN_CONFIGURATION_SCHEMA, config) as boolean;
  return { ok, errors: ok ? [] : [...ajv.errors], config };
}

function refused(config: Json, instancePath: string): void {
  const r = check(config);
  expect(r.ok, JSON.stringify(config)).to.eq(false);
  expect(r.errors.map((e) => e.instancePath)).to.include(instancePath);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const LOGIN_ACCOUNT = { free: 5, baseDelayMs: 1000, maxDelayMs: 60000 };
const THROTTLE_DEFAULTS = {
  login: { account: LOGIN_ACCOUNT, ip: { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } },
  mfa: { account: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }, ip: { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } },
  reset: { account: { free: 1, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 5, baseDelayMs: 10000, maxDelayMs: 900000 } },
  reauth: { account: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 } },
  resetAfterSeconds: 86400,
  global: null as null | Json,
  maxRows: 1_000_000,
};

// Design §22.5, with authn.oidc.providers holding one generic provider (discovery by issuer).
function example(): Json {
  return {
    strategies: [
      { name: 'local', service: 'LocalPasswordStrategy' },
      { name: 'token', service: 'TokenStrategy' },
    ],
    local: {
      hasher: { service: 'Argon2PasswordHasher', maxConcurrent: 8 },
      pepper: { secret: null, version: 1 },
      policy: { minLength: 8, maxLength: 128, rule: null, blocklist: null },
      generator: { length: 16, characters: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'] },
      reset: { ttlSeconds: 3600, url: '', revokeTokens: true },
      invite: { ttlSeconds: 900 },
      expiration: { enabled: false, maxAgeDays: 31 },
    },
    session: {
      service: 'MemorySessionStore',
      expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 },
      pendingTtlSeconds: 300,
      cookie: { name: 'ssid', hostPrefix: 'auto', secure: 'auto', sameSite: 'strict' },
      hashIds: true,
    },
    mfa: {
      policy: { service: 'DefaultMfaPolicy', force: false, forceForRoles: [] },
      steps: [{ name: 'totp', service: 'TotpMfaStep' }],
      encryptionKey: { secret: null },
      totp: { issuer: 'SpinaJS', algorithm: 'SHA1', digits: 6, period: 30, window: 1, recoveryCodes: 10 },
    },
    throttle: { service: 'DbAuthnThrottle', ...clone(THROTTLE_DEFAULTS) },
    freshAuth: { maxAgeSeconds: 300 },
    token: { prefix: 'spt_', length: 32, maxTtlDays: 90, defaultTtlDays: 30, agentMaxTtlMinutes: 1440, headerName: 'x-api-key', lastUsedUpdateInterval: 60 },
    jwt: { issuers: [] },
    keys: {
      algorithms: ['EdDSA', 'ES256'],
      assertion: { typ: 'spinajs-client+jwt', audience: null, maxLifetimeSeconds: 300, skewSeconds: 30 },
      httpSignature: { maxAgeSeconds: 300, requiredComponents: ['@method', '@target-uri', 'content-digest'] },
    },
    linking: { jit: false, byVerifiedEmail: false },
    impersonation: { requirePassword: true, requireMfa: true, maxMinutes: 60 },
    audit: { sinks: ['LogAuthnAuditSink', 'DbAuthnAuditSink'], sampleUse: 0.01, hashIdentifiers: true },
    http: {
      trustProxy: null,
      csrf: { enabled: true, allowedOrigins: [] },
      routes: { prefix: 'auth' },
    },
    oidc: {
      providers: {
        corp: { issuer: 'https://id.example.com', clientId: 'spinajs-app', clientSecret: { secret: 'aws-parameters://authn/oidc/corp' } },
      },
      redirects: { success: '/', failure: '/login' },
    },
  };
}

// The authn.* keys F0b (d219308ce) put in the tree, with the values its package configs ship.
function f0bTree(): Json {
  return {
    session: {
      service: 'MemorySessionStore',
      expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 },
      cookie: { secure: false, maxAge: 3600000, domain: 'example.com' },
      db: { cleanupInterval: 600000 },
      redis: { connection: 'default' },
      aws: { table: 'sessions', readCapacityUnits: 5, writeCapacityUnits: 5, configPath: '', config: {} },
    },
    local: {
      hasher: { service: 'BasicPasswordProvider' },
      generator: { length: 16, characters: ['abc', '0123456789'] },
      policy: { service: 'BasicPasswordValidationProvider', description: 'At least eight characters', rule: { type: 'string', pattern: '^(?=.*\\d).{8,}$' } },
      expiration: { enabled: true, passwordExpirationTime: 2678400 },
      reset: { ttlSeconds: 3600, url: '' },
      invite: { ttlSeconds: 900 },
    },
    impersonation: { requirePassword: true },
    token: { generation: { service: 'SecureRandomTokenProvider' }, prefix: 'spt_', length: 32, headerName: 'x-api-key', lastUsedUpdateInterval: 60 },
    mfa: { totp: { issuer: 'Spinajs', algorithm: 'SHA1', digits: 6, period: 30, window: 1 } },
  };
}

function leaves(v: unknown, path: string[] = []): [string, unknown][] {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
    return Object.entries(v as Json).flatMap(([k, c]) => leaves(c, [...path, k]));
  }
  return [[path.join('.'), v]];
}

function at(o: Json, path: string): unknown {
  return path.split('.').reduce<unknown>((n, k) => (n === undefined || n === null ? undefined : (n as Json)[k]), o);
}

// Walks `properties` only: a key under an open object does not count as declared.
function declared(path: string): boolean {
  let node: Json | undefined = AUTHN_CONFIGURATION_SCHEMA as Json;
  for (const seg of path.split('.')) {
    node = node?.properties?.[seg];
    if (!node) return false;
  }
  return true;
}

const acceptRow = (row: AuthnLegacyKey): AuthnLegacyKey => row;

describe('authn.* configuration schema', () => {
  it('is the authn module schema', () => {
    expect(AUTHN_CONFIGURATION_SCHEMA.$id).to.eq('spinajs/authn.configuration.schema.json');
    expect(AUTHN_CONFIGURATION_SCHEMA.$configurationModule).to.eq('authn');
    expect(AUTHN_CONFIGURATION_SCHEMA.type).to.eq('object');
  });

  it('compiles under the app validator without strict-mode warnings', () => {
    ajv.compile(AUTHN_CONFIGURATION_SCHEMA);
    expect(warnings, JSON.stringify(warnings)).to.deep.eq([]);
  });

  it('declares every key of the design §22.5 example and authn.oidc', () => {
    const missing = leaves(example())
      .map(([p]) => p)
      .filter((p) => !p.startsWith('oidc.providers.'))
      .filter((p) => !declared(p));
    expect(missing).to.deep.eq([]);
    expect(declared('oidc.providers')).to.eq(true);
    expect(declared('oidc.redirects.success')).to.eq(true);
    expect(declared('oidc.redirects.failure')).to.eq(true);
    expect(declared('config.rejectLegacyKeys')).to.eq(true);
    expect(declared('token.generation.service')).to.eq(true);
  });

  describe('valid configs', () => {
    it('accepts the design §22.5 example and keeps every value', () => {
      const r = check(example());
      expect(r.errors).to.deep.eq([]);
      expect(r.config).to.deep.eq({ ...example(), audit: { ...example().audit, sinkTimeoutMs: 2000 } });
    });

    it('accepts the keys F0b put in the tree and keeps every value', () => {
      const r = check(f0bTree());
      expect(r.errors).to.deep.eq([]);
      for (const [path, value] of leaves(f0bTree())) expect(at(r.config, path), path).to.deep.eq(value);
    });

    it('accepts an ip key on reauth, with no default for it', () => {
      expect(check({ throttle: { reauth: { account: LOGIN_ACCOUNT, ip: { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } } } }).ok).to.eq(true);
      expect(check({}).config.throttle.reauth).to.not.have.property('ip');
    });

    it('accepts a global backoff key', () => {
      expect(check({ throttle: { global: { free: 1000, baseDelayMs: 100, maxDelayMs: 1000 } } }).ok).to.eq(true);
    });

    it('accepts a jwt issuer with jwksUri or with keys', () => {
      const issuer = { issuer: 'https://id.example.com', audience: 'api', algorithms: ['EdDSA', 'ES256', 'RS256'], clockSkewSeconds: 30, subjectClaim: 'sub', provider: 'jwt:https://id.example.com' };
      expect(check({ jwt: { issuers: [{ ...issuer, jwksUri: 'https://id.example.com/jwks' }] } }).errors).to.deep.eq([]);
      expect(check({ jwt: { issuers: [{ ...issuer, keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'abc' }] }] } }).errors).to.deep.eq([]);
    });

    it('takes trustProxy as CIDRs or hops; 0 never becomes the null fallback and true never trusts everyone', () => {
      const proxy = (v: unknown) => check({ http: { trustProxy: v } });
      for (const v of [0, 2, null, ['10.0.0.0/8', 'loopback']]) {
        const r = proxy(v);
        expect(r.ok, JSON.stringify(v)).to.eq(true);
        expect(r.config.http.trustProxy, JSON.stringify(v)).to.deep.eq(v);
      }
      expect(proxy(true).config.http.trustProxy).to.eq(1);
      expect(proxy(false).config.http.trustProxy).to.eq(0);
      refused({ http: { trustProxy: 'loopback' } }, '/http/trustProxy');
      refused({ http: { trustProxy: -1 } }, '/http/trustProxy');
      refused({ http: { trustProxy: [''] } }, '/http/trustProxy/0');
    });

    it('accepts the cookie values the 2.x cookie builder accepts and keeps them as given', () => {
      for (const cookie of [{ sameSite: true }, { sameSite: false }, { sameSite: 'Lax' }, { sameSite: 'STRICT' }, { sameSite: 'none' }, { secure: 'true' }, { secure: 'false' }, { hostPrefix: 'true' }, { secure: true, hostPrefix: false }]) {
        const r = check({ session: { cookie: { ...cookie } } });
        expect(r.errors, JSON.stringify(cookie)).to.deep.eq([]);
        expect(r.config.session.cookie, JSON.stringify(cookie)).to.deep.include(cookie);
      }
    });

    it('accepts any otpauth algorithm name', () => {
      expect(check({ mfa: { totp: { algorithm: 'sha-256' } } }).errors).to.deep.eq([]);
    });

    it('takes tokens of at least 32 random bytes with a non-empty prefix (A14)', () => {
      expect(check({ token: { length: 32, prefix: 'spt_' } }).errors).to.deep.eq([]);
      refused({ token: { length: 31 } }, '/token/length');
      refused({ token: { prefix: '' } }, '/token/prefix');
    });

    it('coerces a numeric string, as the app validator does', () => {
      const r = check({ local: { hasher: { maxConcurrent: '4' } } });
      expect(r.ok).to.eq(true);
      expect(r.config.local.hasher.maxConcurrent).to.eq(4);
    });
  });

  describe('defaults', () => {
    it('fills the throttle with the design §22.5 backoff and the audit defaults when they are missing', () => {
      expect(check({}).config).to.deep.eq({ strategies: [], mfa: { policy: { service: 'DefaultMfaPolicy', force: false, forceForRoles: [] }, steps: [] }, freshAuth: { maxAgeSeconds: 300 }, linking: { jit: false, byVerifiedEmail: false }, impersonation: { requirePassword: true, requireMfa: true, maxMinutes: 60 }, throttle: THROTTLE_DEFAULTS, audit: { sampleUse: 0.01, hashIdentifiers: true, sinkTimeoutMs: 2000 } });
    });

    it('fills a missing flow or key of a given throttle', () => {
      const r = check({ throttle: { service: 'MemoryAuthnThrottle', login: { account: { free: 10, baseDelayMs: 500, maxDelayMs: 30000 } } } });
      expect(r.config.throttle).to.deep.eq({ ...THROTTLE_DEFAULTS, service: 'MemoryAuthnThrottle', login: { ...THROTTLE_DEFAULTS.login, account: { free: 10, baseDelayMs: 500, maxDelayMs: 30000 } } });
    });

    it('fills the security floors inside objects that exist, and nothing else', () => {
      const r = check({ local: { hasher: {}, policy: {}, reset: {} }, session: { cookie: {} }, token: {}, impersonation: {}, audit: {}, http: { csrf: {} } });
      expect(r.errors).to.deep.eq([]);
      expect(r.config).to.deep.eq({
        local: { hasher: { maxConcurrent: 8 }, policy: { minLength: 8, maxLength: 128 }, reset: { revokeTokens: true } },
        session: { cookie: { sameSite: 'strict' }, hashIds: true },
        token: { maxTtlDays: 90, agentMaxTtlMinutes: 1440 },
        impersonation: { requirePassword: true, requireMfa: true, maxMinutes: 60 },
        audit: { sampleUse: 0.01, hashIdentifiers: true, sinkTimeoutMs: 2000 },
        http: { csrf: { enabled: true, allowedOrigins: [] } },
        strategies: [],
        mfa: { policy: { service: 'DefaultMfaPolicy', force: false, forceForRoles: [] }, steps: [] },
        freshAuth: { maxAgeSeconds: 300 },
        linking: { jit: false, byVerifiedEmail: false },
        throttle: THROTTLE_DEFAULTS,
      });
    });
  });

  describe('bad values', () => {
    it('refuses negative delays and counts', () => {
      refused({ throttle: { login: { account: { ...LOGIN_ACCOUNT, baseDelayMs: -1 } } } }, '/throttle/login/account/baseDelayMs');
      refused({ throttle: { login: { account: { ...LOGIN_ACCOUNT, free: -1 } } } }, '/throttle/login/account/free');
      refused({ throttle: { mfa: { ip: { free: 1, baseDelayMs: 1, maxDelayMs: 0 } } } }, '/throttle/mfa/ip/maxDelayMs');
      refused({ throttle: { global: { free: -1, baseDelayMs: 1, maxDelayMs: 1 } } }, '/throttle/global/free');
      refused({ throttle: { resetAfterSeconds: -5 } }, '/throttle/resetAfterSeconds');
    });

    it('refuses a backoff key missing a parameter', () => {
      refused({ throttle: { login: { account: { free: 5, baseDelayMs: 1000 } } } }, '/throttle/login/account');
    });

    it('refuses an unknown throttle flow, key kind or lock key', () => {
      refused({ throttle: { signup: { account: LOGIN_ACCOUNT } } }, '/throttle');
      refused({ throttle: { login: { device: LOGIN_ACCOUNT } } }, '/throttle/login');
      refused({ throttle: { login: { account: { ...LOGIN_ACCOUNT, lockoutTime: 900 } } } }, '/throttle/login/account');
      refused({ throttle: { blockAfterAttempts: 5 } }, '/throttle');
      refused({ throttle: { lockoutTime: 900 } }, '/throttle');
    });

    it('refuses an unknown sameSite and a non-auto secure or hostPrefix', () => {
      refused({ session: { cookie: { sameSite: 'sometimes' } } }, '/session/cookie/sameSite');
      refused({ session: { cookie: { sameSite: null } } }, '/session/cookie/sameSite');
      refused({ session: { cookie: { sameSite: 1 } } }, '/session/cookie/sameSite');
      refused({ session: { cookie: { secure: 'yes' } } }, '/session/cookie/secure');
      refused({ session: { cookie: { secure: null } } }, '/session/cookie/secure');
      refused({ session: { cookie: { hostPrefix: 'always' } } }, '/session/cookie/hostPrefix');
    });

    it('refuses unhashed session ids (SR-18)', () => {
      refused({ session: { hashIds: false } }, '/session/hashIds');
      refused({ session: { hashIds: 'false' } }, '/session/hashIds');
    });

    it('refuses a wrong type for maxConcurrent', () => {
      refused({ local: { hasher: { maxConcurrent: 'eight' } } }, '/local/hasher/maxConcurrent');
      refused({ local: { hasher: { maxConcurrent: { n: 8 } } } }, '/local/hasher/maxConcurrent');
      refused({ local: { hasher: { maxConcurrent: 0 } } }, '/local/hasher/maxConcurrent');
    });

    it('refuses argon2 cost keys under local.hasher (H30)', () => {
      for (const key of ['memoryCost', 'timeCost', 'parallelism', 'hashLength', 'saltLength', 'type']) {
        const r = check({ local: { hasher: { service: 'Argon2PasswordHasher', [key]: 1 } } });
        expect(r.ok, key).to.eq(false);
        expect(r.errors.filter((e) => e.keyword === 'propertyNames').map((e) => [e.instancePath, e.params.propertyName])).to.deep.eq([['/local/hasher', key]]);
      }
    });

    it('refuses short or zero lengths and lifetimes', () => {
      refused({ local: { policy: { minLength: 0 } } }, '/local/policy/minLength');
      refused({ local: { generator: { length: 0 } } }, '/local/generator/length');
      refused({ local: { generator: { characters: [] } } }, '/local/generator/characters');
      refused({ local: { reset: { ttlSeconds: 0 } } }, '/local/reset/ttlSeconds');
      refused({ session: { pendingTtlSeconds: 0 } }, '/session/pendingTtlSeconds');
      refused({ impersonation: { maxMinutes: 0 } }, '/impersonation/maxMinutes');
      refused({ audit: { sampleUse: 1.5 } }, '/audit/sampleUse');
    });

    it('refuses algorithms outside the allow-lists', () => {
      const issuer = { issuer: 'https://id.example.com', audience: 'api', jwksUri: 'https://id.example.com/jwks' };
      refused({ jwt: { issuers: [{ ...issuer, algorithms: ['HS256'] }] } }, '/jwt/issuers/0/algorithms/0');
      refused({ jwt: { issuers: [{ ...issuer, algorithms: ['none'] }] } }, '/jwt/issuers/0/algorithms/0');
      refused({ keys: { algorithms: ['RS256'] } }, '/keys/algorithms/0');
      refused({ mfa: { totp: { algorithm: '' } } }, '/mfa/totp/algorithm');
    });

    it('refuses a jwt issuer without keys, with both key sources, or with a skew over 60 s', () => {
      const issuer = { issuer: 'https://id.example.com', audience: 'api', algorithms: ['EdDSA'] };
      refused({ jwt: { issuers: [issuer] } }, '/jwt/issuers/0');
      refused({ jwt: { issuers: [{ ...issuer, jwksUri: 'https://id.example.com/jwks', keys: [{ kty: 'OKP' }] }] } }, '/jwt/issuers/0');
      refused({ jwt: { issuers: [{ ...issuer, jwksUri: 'https://id.example.com/jwks', clockSkewSeconds: 61 }] } }, '/jwt/issuers/0/clockSkewSeconds');
    });

    it('refuses key lifetimes over 300 s', () => {
      refused({ keys: { assertion: { maxLifetimeSeconds: 301 } } }, '/keys/assertion/maxLifetimeSeconds');
      refused({ keys: { httpSignature: { maxAgeSeconds: 301 } } }, '/keys/httpSignature/maxAgeSeconds');
    });

    it('refuses duplicate strategy or mfa step names', () => {
      refused(
        {
          strategies: [
            { name: 'local', service: 'A' },
            { name: 'local', service: 'B' },
          ],
        },
        '/strategies',
      );
      refused(
        {
          mfa: {
            steps: [
              { name: 'totp', service: 'A' },
              { name: 'totp', service: 'B' },
            ],
          },
        },
        '/mfa/steps',
      );
    });

    it("refuses an mfa step named 'recovery', which completeMfa reserves", () => {
      refused({ mfa: { steps: [{ name: 'recovery', service: 'A' }] } }, '/mfa/steps/0/name');
      expect(check({ strategies: [{ name: 'recovery', service: 'A' }] }).ok).to.eq(true);
    });

    it('refuses a secret ref without secret', () => {
      refused({ local: { pepper: { version: 1 } } }, '/local/pepper');
    });

    it('refuses password length bounds outside 8–128 (A04)', () => {
      refused({ local: { policy: { minLength: 7 } } }, '/local/policy/minLength');
      refused({ local: { policy: { minLength: 129 } } }, '/local/policy/minLength');
      refused({ local: { policy: { maxLength: 7 } } }, '/local/policy/maxLength');
      refused({ local: { policy: { maxLength: 129 } } }, '/local/policy/maxLength');
      expect(check({ local: { policy: { minLength: 12, maxLength: 64 } } }).ok).to.eq(true);
    });

    it('keeps oidc providers open but limits their names, as task 10 does', () => {
      expect(check({ oidc: { providers: { 'a_b-9': { preset: 'google', anything: { nested: true } } } } }).ok).to.eq(true);
      refused({ oidc: { providers: { 'Corp IdP': { issuer: 'https://id.example.com' } } } }, '/oidc/providers');
      refused({ oidc: { providers: { ['a'.repeat(60)]: { issuer: 'https://id.example.com' } } } }, '/oidc/providers');
      refused({ oidc: { providers: { corp: 'https://id.example.com' } } }, '/oidc/providers/corp');
    });

    it('refuses an oidc redirect that is not an app-relative path', () => {
      refused({ oidc: { redirects: { success: '//evil.example.com' } } }, '/oidc/redirects/success');
      refused({ oidc: { redirects: { failure: '/\\evil.example.com' } } }, '/oidc/redirects/failure');
      refused({ oidc: { redirects: { failure: 'https://evil.example.com' } } }, '/oidc/redirects/failure');
    });
  });
});

describe('authn old-key table', () => {
  // Design §22.5's table plus rbac.token.generation, which F0b moved (erratum for the design).
  const TABLE: [string, string | null, 'key' | 'subtree', 'authn' | 'users'][] = [
    ['rbac.auth.service', 'authn.strategies', 'key', 'authn'],
    ['rbac.password.service', 'authn.local.hasher.service', 'key', 'authn'],
    ['rbac.password.validation', 'authn.local.policy', 'subtree', 'authn'],
    ['rbac.password.generator', 'authn.local.generator', 'subtree', 'authn'],
    ['rbac.password.passwordResetWaitTime', 'authn.local.reset.ttlSeconds', 'key', 'authn'],
    ['rbac.password.invite.waitTime', 'authn.local.invite.ttlSeconds', 'key', 'authn'],
    ['rbac.password.resetUrl', 'authn.local.reset.url', 'key', 'authn'],
    ['rbac.password.blockAfterAttempts', 'authn.throttle.login.account.free', 'key', 'authn'],
    ['rbac.password.lockoutTime', null, 'key', 'authn'],
    ['rbac.password.expiration', 'authn.local.expiration', 'subtree', 'authn'],
    ['rbac.session', 'authn.session', 'subtree', 'authn'],
    ['rbac.twoFactorAuth.enabled', 'authn.mfa.steps', 'key', 'authn'],
    ['rbac.twoFactorAuth.forceUser', 'authn.mfa.policy.force', 'key', 'authn'],
    ['rbac.twoFactorAuth.service', 'authn.mfa.steps', 'key', 'authn'],
    ['rbac.otpauth', 'authn.mfa.totp', 'subtree', 'authn'],
    ['rbac.token.prefix', 'authn.token.prefix', 'key', 'authn'],
    ['rbac.token.length', 'authn.token.length', 'key', 'authn'],
    ['rbac.token.generation', 'authn.token.generation', 'subtree', 'authn'],
    ['rbac.token.headerName', 'authn.token.headerName', 'key', 'authn'],
    ['rbac.token.lastUsedUpdateInterval', 'authn.token.lastUsedUpdateInterval', 'key', 'authn'],
    ['rbac.impersonation.requirePassword', 'authn.impersonation.requirePassword', 'key', 'authn'],
    ['rbac.user', 'users.user', 'subtree', 'users'],
    ['rbac.email', 'users.email', 'subtree', 'users'],
    ['rbac.actions', 'users.actions', 'subtree', 'users'],
  ];

  it('has one row per 2.x key of the design table and F0b moves, in order', () => {
    expect(AUTHN_LEGACY_KEYS.map((r) => [r.from, r.to, r.scope, r.family])).to.deep.eq(TABLE);
    expect(new Set(AUTHN_LEGACY_KEYS.map((r) => r.from)).size).to.eq(AUTHN_LEGACY_KEYS.length);
  });

  it('maps every authn row to a key the schema declares', () => {
    const rows = AUTHN_LEGACY_KEYS.filter((r) => r.family === 'authn' && r.to !== null);
    expect(rows.filter((r) => !r.to!.startsWith('authn.') || !declared(r.to!.slice('authn.'.length))).map((r) => r.to)).to.deep.eq([]);
  });

  it('sends identity rows to users.*', () => {
    expect(AUTHN_LEGACY_KEYS.filter((r) => r.family === 'users').every((r) => r.to !== null && r.to.startsWith('users.'))).to.eq(true);
  });

  it('drops lockoutTime with a warning (H31)', () => {
    const dropped = AUTHN_LEGACY_KEYS.filter((r) => r.to === null);
    expect(dropped.map((r) => r.from)).to.deep.eq(['rbac.password.lockoutTime']);
    expect(dropped[0].note).to.match(/H31/);
  });

  it('notes every row that is more than a rename', () => {
    const noted = AUTHN_LEGACY_KEYS.filter((r) => r.note).map((r) => r.from);
    expect(noted).to.include.members(['rbac.auth.service', 'rbac.password.blockAfterAttempts', 'rbac.password.lockoutTime', 'rbac.password.expiration', 'rbac.twoFactorAuth.enabled', 'rbac.twoFactorAuth.service']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(AUTHN_LEGACY_KEYS)).to.eq(true);
    expect(AUTHN_LEGACY_KEYS.every((r) => Object.isFrozen(r))).to.eq(true);
  });

  it('types a dropped row with a note and only the authn and users families', () => {
    acceptRow({ from: 'rbac.a', to: 'authn.a', scope: 'key', family: 'authn' });
    acceptRow({ from: 'rbac.b', to: null, scope: 'key', family: 'authn', note: 'dropped' });
    // @ts-expect-error a dropped row needs a note, the detector's warning
    acceptRow({ from: 'rbac.c', to: null, scope: 'key', family: 'authn' });
    // @ts-expect-error authz keys are not in this table
    acceptRow({ from: 'rbac.d', to: 'authz.d', scope: 'key', family: 'authz' });
    // @ts-expect-error scope is 'key' or 'subtree'
    acceptRow({ from: 'rbac.e', to: 'authn.e', scope: 'prefix', family: 'authn' });
  });
});

describe('authn config boundary', () => {
  it('the root entry exports the schema and the table; the contracts entry does not', () => {
    expect(root).to.include.keys('AUTHN_CONFIGURATION_SCHEMA', 'AUTHN_LEGACY_KEYS');
    expect(Object.keys(contracts)).to.not.include.members(['AUTHN_CONFIGURATION_SCHEMA']);
    expect(Object.keys(contracts)).to.not.include.members(['AUTHN_LEGACY_KEYS']);
  });

  it('src/schemas imports nothing but its own files', () => {
    const files = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith('.ts'));
    expect(files).to.have.members(['authn.configuration.ts', 'legacy-keys.ts', 'index.ts']);
    const outside = files.flatMap((f) =>
      ts
        .preProcessFile(readFileSync(join(SCHEMAS_DIR, f), 'utf8'), true, true)
        .importedFiles.map((i) => i.fileName)
        .filter((s) => !/^\.\/[\w.-]+\.js$/.test(s)),
    );
    expect(outside).to.deep.eq([]);
  });
});
