import * as chai from 'chai';
import 'mocha';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { AUTHN_CONFIGURATION_SCHEMA } from '../../src/schemas/index.js';
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
    $data: true,
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

// The keys of authn.session, token, keys and http the authn schema keeps; the rest of each is a fragment of its package.
const SESSION_DEFAULTS = { expiration: { maxLifetime: 480 } };
const TOKEN_DEFAULTS = { prefix: 'spt_', headerName: 'x-api-key' };
const KEYS_DEFAULTS = { assertion: { typ: 'spinajs-client+jwt' } };
const CORE_HELD = ['session.expiration.maxLifetime', 'token.prefix', 'token.headerName', 'keys.assertion.typ', 'http.trustProxy'];
const FRAGMENTS = ['local', 'session', 'jwt', 'mfa.totp', 'token', 'keys', 'http'];
const inFragment = (path: string): boolean => !CORE_HELD.includes(path) && FRAGMENTS.some((f) => path === f || path.startsWith(`${f}.`));

const LOGIN_ACCOUNT = { free: 5, baseDelayMs: 1000, maxDelayMs: 60000 };
const THROTTLE_DEFAULTS = {
  login: { account: LOGIN_ACCOUNT, ip: { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } },
  mfa: { account: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }, ip: { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } },
  reset: { account: { free: 1, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 5, baseDelayMs: 10000, maxDelayMs: 900000 } },
  reauth: { account: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 } },
  resetAfterSeconds: 86400,
  global: null as null | Json,
  maxRows: 1_000_000,
  memory: { sweepBatch: 8, fullRetrySeconds: 60, holdOffMs: 1000 },
};

// Design §22.5; authn.oidc has a schema of its own in @spinajs/authn-oidc.
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
    login: { requireVerifiedAddress: false },
    impersonation: { requirePassword: true, requireMfa: true, maxMinutes: 60, clockSkewSeconds: 30 },
    audit: { hashIdentifiers: true },
    http: {
      trustProxy: null,
      csrf: { enabled: true, allowedOrigins: [] },
      routes: { prefix: 'auth' },
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

  it('declares every key of the design §22.5 example but those the fragments of the authn packages declare', () => {
    const paths = leaves(example()).map(([p]) => p);
    expect(paths.filter((p) => !inFragment(p) && !declared(p))).to.deep.eq([]);
    // Two schemas on one key would report every violation twice.
    expect(paths.filter((p) => inFragment(p) && declared(p))).to.deep.eq([]);
    expect(declared('oidc')).to.eq(false);
    expect(declared('config')).to.eq(false);
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

    it('takes a token prefix that is not empty and a header name', () => {
      expect(check({ token: { prefix: 'spt_', headerName: 'x-key' } }).errors).to.deep.eq([]);
      refused({ token: { prefix: '' } }, '/token/prefix');
      refused({ token: { headerName: '' } }, '/token/headerName');
      refused({ keys: { assertion: { typ: '' } } }, '/keys/assertion/typ');
    });

    it('coerces a numeric string, as the app validator does', () => {
      const r = check({ impersonation: { maxMinutes: '4' } });
      expect(r.ok).to.eq(true);
      expect(r.config.impersonation.maxMinutes).to.eq(4);
    });
  });

  describe('defaults', () => {
    it('fills the throttle with the design §22.5 backoff and the audit defaults when they are missing', () => {
      expect(check({}).config).to.deep.eq({ strategies: [], mfa: { policy: { service: 'DefaultMfaPolicy', force: false, forceForRoles: [] }, steps: [] }, freshAuth: { maxAgeSeconds: 300 }, linking: { jit: false, byVerifiedEmail: false }, login: { requireVerifiedAddress: false }, impersonation: { requirePassword: true, requireMfa: true, maxMinutes: 60, clockSkewSeconds: 30 }, throttle: THROTTLE_DEFAULTS, audit: { hashIdentifiers: true, sinkTimeoutMs: 2000 }, session: SESSION_DEFAULTS, token: TOKEN_DEFAULTS, keys: KEYS_DEFAULTS, http: {} });
    });

    it('fills a missing flow or key of a given throttle', () => {
      const r = check({ throttle: { service: 'MemoryAuthnThrottle', login: { account: { free: 10, baseDelayMs: 500, maxDelayMs: 30000 } } } });
      expect(r.config.throttle).to.deep.eq({ ...THROTTLE_DEFAULTS, service: 'MemoryAuthnThrottle', login: { ...THROTTLE_DEFAULTS.login, account: { free: 10, baseDelayMs: 500, maxDelayMs: 30000 } } });
    });

    it('fills the security floors inside objects that exist, and nothing else', () => {
      const r = check({ session: { expiration: {} }, token: {}, keys: { assertion: {} }, impersonation: {}, audit: {}, http: {} });
      expect(r.errors).to.deep.eq([]);
      expect(r.config).to.deep.eq({
        session: SESSION_DEFAULTS,
        token: TOKEN_DEFAULTS,
        keys: KEYS_DEFAULTS,
        impersonation: { requirePassword: true, requireMfa: true, maxMinutes: 60, clockSkewSeconds: 30 },
        audit: { hashIdentifiers: true, sinkTimeoutMs: 2000 },
        http: {},
        strategies: [],
        mfa: { policy: { service: 'DefaultMfaPolicy', force: false, forceForRoles: [] }, steps: [] },
        freshAuth: { maxAgeSeconds: 300 },
        linking: { jit: false, byVerifiedEmail: false },
        login: { requireVerifiedAddress: false },
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

    it('refuses an out of range or unknown authn.throttle.memory key', () => {
      refused({ throttle: { memory: { sweepBatch: 0 } } }, '/throttle/memory/sweepBatch');
      refused({ throttle: { memory: { fullRetrySeconds: 3601 } } }, '/throttle/memory/fullRetrySeconds');
      refused({ throttle: { memory: { holdOffMs: -1 } } }, '/throttle/memory/holdOffMs');
      refused({ throttle: { memory: { maxRows: 10 } } }, '/throttle/memory');
    });

    it('refuses zero lifetimes', () => {
      refused({ impersonation: { maxMinutes: 0 } }, '/impersonation/maxMinutes');
      refused({ impersonation: { clockSkewSeconds: 301 } }, '/impersonation/clockSkewSeconds');
      refused({ audit: { sinkTimeoutMs: 0 } }, '/audit/sinkTimeoutMs');
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
      refused({ mfa: { encryptionKey: { previous: [] } } }, '/mfa/encryptionKey');
      refused({ audit: { hashKey: {} } }, '/audit/hashKey');
    });
  });
});

describe('authn config boundary', () => {
  it('the root entry exports the schema; the contracts entry does not', () => {
    expect(root).to.include.keys('AUTHN_CONFIGURATION_SCHEMA');
    expect(Object.keys(contracts)).to.not.include.members(['AUTHN_CONFIGURATION_SCHEMA']);
  });

  it('src/schemas imports nothing but its own files', () => {
    const files = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith('.ts'));
    expect(files).to.have.members(['authn.configuration.ts', 'index.ts']);
    const outside = files.flatMap((f) =>
      ts
        .preProcessFile(readFileSync(join(SCHEMAS_DIR, f), 'utf8'), true, true)
        .importedFiles.map((i) => i.fileName)
        .filter((s) => !/^\.\/[\w.-]+\.js$/.test(s)),
    );
    expect(outside).to.deep.eq([]);
  });
});
