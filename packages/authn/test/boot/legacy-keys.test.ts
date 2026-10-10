import * as chai from 'chai';
import 'mocha';
import { InvalidOption } from '@spinajs/exceptions';

import { AUTHN_LEGACY_KEYS, authnLegacyKeysText, checkAuthnLegacyKeys, findAuthnLegacyKeys } from '../../src/index.js';
import { buildCore, violationPaths } from '../behaviour/harness.js';
import { TestLog, useTestLog } from '../audit/test-log.js';

const expect = chai.expect;

type Values = Record<string, unknown>;

function config(values: Values): { get<T>(path: string | string[]): T } {
  return {
    get<T>(path: string | string[]): T {
      const parts = Array.isArray(path) ? path : path.split('.');
      return parts.reduce<unknown>((n, k) => (n !== null && typeof n === 'object' ? (n as Values)[k] : undefined), values) as T;
    },
  };
}

function log(): { lines: string[]; warn(m: string): void } {
  const lines: string[] = [];
  return { lines, warn: (m) => lines.push(m) };
}

// A 2.x config that sets every row of the table once.
const RBAC_2X = {
  auth: { service: 'SimpleDbAuthProvider' },
  password: {
    service: 'BasicPasswordProvider',
    validation: { service: 'BasicPasswordValidationProvider', rule: { type: 'string', pattern: '^.{8,}$' } },
    generator: { length: 16 },
    passwordResetWaitTime: 3600,
    invite: { waitTime: 900 },
    resetUrl: 'https://app.example.com/reset',
    blockAfterAttempts: 3,
    lockoutTime: 900,
    expiration: { enabled: true, passwordExpirationTime: 2678400 },
  },
  session: { service: 'MemorySessionStore', expiration: { ttl: 30 } },
  twoFactorAuth: { enabled: true, forceUser: false, service: 'Default2FaToken' },
  otpauth: { issuer: 'Spinajs', digits: 6 },
  token: { prefix: 'spt_', length: 32, generation: { service: 'SecureRandomTokenProvider' }, headerName: 'x-api-key', lastUsedUpdateInterval: 60 },
  impersonation: { requirePassword: true },
  user: { profile: true },
  email: { changePassword: { enabled: true } },
  actions: { create: { notifyUser: true } },
};

describe('authn legacy key detector', () => {
  it('finds no key when there is no rbac tree', () => {
    expect(findAuthnLegacyKeys(undefined)).to.deep.eq([]);
    expect(findAuthnLegacyKeys(null)).to.deep.eq([]);
    expect(findAuthnLegacyKeys({})).to.deep.eq([]);
  });

  it('reports every authn row of the table, leaf by leaf, with its 3.0 key', () => {
    const found = findAuthnLegacyKeys(RBAC_2X);
    const byPath = new Map(found.map((f) => [f.path, f.to]));
    expect(byPath.get('rbac.auth.service')).to.eq('authn.strategies');
    expect(byPath.get('rbac.password.service')).to.eq('authn.local.hasher.service');
    expect(byPath.get('rbac.password.validation.rule.pattern')).to.eq('authn.local.policy.rule.pattern');
    expect(byPath.get('rbac.password.generator.length')).to.eq('authn.local.generator.length');
    expect(byPath.get('rbac.password.invite.waitTime')).to.eq('authn.local.invite.ttlSeconds');
    expect(byPath.get('rbac.password.blockAfterAttempts')).to.eq('authn.throttle.login.account.free');
    expect(byPath.get('rbac.password.lockoutTime')).to.eq(null);
    expect(byPath.get('rbac.session.expiration.ttl')).to.eq('authn.session.expiration.ttl');
    expect(byPath.get('rbac.twoFactorAuth.enabled')).to.eq('authn.mfa.steps');
    expect(byPath.get('rbac.otpauth.issuer')).to.eq('authn.mfa.totp.issuer');
    expect(byPath.get('rbac.token.generation.service')).to.eq('authn.token.generation.service');
    expect(byPath.get('rbac.impersonation.requirePassword')).to.eq('authn.impersonation.requirePassword');
    const rows = new Set(AUTHN_LEGACY_KEYS.filter((r) => r.family === 'authn').map((r) => r.from));
    for (const from of rows) expect(found.some((f) => f.path === from || f.path.startsWith(`${from}.`)), from).to.eq(true);
  });

  it('leaves users rows to the users detector and other rbac keys to authz', () => {
    const found = findAuthnLegacyKeys({ user: { profile: true }, email: { a: 1 }, actions: { b: 2 }, grants: { admin: {} }, roles: [{ Name: 'Admin' }], token: { rolePolicy: { service: 'X' } }, __file__: ['x.js'] });
    expect(found).to.deep.eq([]);
  });

  it('keeps the note of a dropped or converted row', () => {
    const found = findAuthnLegacyKeys({ password: { lockoutTime: 900, blockAfterAttempts: 0 } });
    expect(found.find((f) => f.path === 'rbac.password.lockoutTime')?.note).to.match(/H31/);
    expect(found.find((f) => f.path === 'rbac.password.blockAfterAttempts')?.note).to.match(/free/);
  });

  it('survives cycles', () => {
    const a: Values = { service: 'x' };
    a.self = a;
    expect(() => findAuthnLegacyKeys({ password: a })).to.not.throw();
  });

  describe('at boot', () => {
    const OFF = { authn: { config: { rejectLegacyKeys: false } } };

    it('warns once, naming each key and where it goes, and boots when authn.config.rejectLegacyKeys is false', () => {
      const l = log();
      const found = checkAuthnLegacyKeys(config({ ...OFF, rbac: { password: { lockoutTime: 900, resetUrl: 'https://secret.example.com/reset?k=1' } } }), l);
      expect(found.map((f) => f.path)).to.deep.eq(['rbac.password.lockoutTime', 'rbac.password.resetUrl']);
      expect(l.lines).to.have.length(1);
      expect(l.lines[0]).to.contain('rbac.password.lockoutTime -> dropped').and.contain('rbac.password.resetUrl -> authn.local.reset.url');
      expect(l.lines[0]).to.not.contain('secret.example.com');
    });

    it('says nothing without rbac keys of the table', () => {
      const l = log();
      expect(checkAuthnLegacyKeys(config({ rbac: { grants: {} } }), l)).to.deep.eq([]);
      expect(checkAuthnLegacyKeys(config({}), l)).to.deep.eq([]);
      expect(l.lines).to.deep.eq([]);
    });

    it('fails boot unless authn.config.rejectLegacyKeys is false', () => {
      const rbac = { session: { service: 'MemorySessionStore' } };
      expect(() => checkAuthnLegacyKeys(config({ rbac, authn: { config: { rejectLegacyKeys: true } } }), log())).to.throw(InvalidOption, /rbac\.session\.service -> authn\.session\.service/);
      expect(() => checkAuthnLegacyKeys(config({ rbac }), log())).to.throw(InvalidOption, /rbac\.session\.service -> authn\.session\.service/);
      expect(() => checkAuthnLegacyKeys(config({ rbac, ...OFF }), log())).to.not.throw();
      expect(() => checkAuthnLegacyKeys(config({ authn: { config: { rejectLegacyKeys: true } } }), log())).to.not.throw();
    });

    it('treats anything but an explicit false as rejecting; the schema types it as a boolean', () => {
      for (const v of ['false', 0, null, undefined]) {
        expect(() => checkAuthnLegacyKeys(config({ rbac: { session: { service: 'MemorySessionStore' } }, authn: { config: { rejectLegacyKeys: v } } }), log()), String(v)).to.throw(InvalidOption);
      }
    });

    it('points at the converter and at the switch that only warns, never printing a value', () => {
      const text = authnLegacyKeysText(findAuthnLegacyKeys({ session: { service: 'MemorySessionStore' } }));
      expect(text).to.contain('rbac.session.service -> authn.session.service').and.contain('spinajs-authz-convert').and.contain('authn.config.rejectLegacyKeys: false');
      expect(text).to.not.contain('MemorySessionStore');
    });
  });
});

describe('DefaultAuthnService boot: legacy keys', function () {
  // Each case boots one or two containers.
  this.timeout(20000);
  useTestLog();

  const failure = async (raw: Values): Promise<unknown> => {
    try {
      const p = await buildCore({}, { raw });
      await p.dispose();
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it('fails boot on a 2.x key of the table by default, naming the key, its 3.0 key and the converter', async () => {
    const error = await failure({ rbac: { session: { service: 'MemorySessionStore' } } });
    expect(error).to.be.instanceOf(InvalidOption);
    expect((error as Error).message).to.contain('rbac.session.service -> authn.session.service').and.contain('spinajs-authz-convert');
  });

  it('fails boot on a 2.x key of the table when authn.config.rejectLegacyKeys is true', async () => {
    const error = await failure({ rbac: { password: { lockoutTime: 900 } }, authn: { config: { rejectLegacyKeys: true } } });
    expect(error).to.be.instanceOf(InvalidOption);
    expect((error as Error).message).to.contain('rbac.password.lockoutTime -> dropped');
  });

  it('boots with a warning naming the key when authn.config.rejectLegacyKeys is false', async () => {
    const p = await buildCore({}, { raw: { rbac: { session: { cookie: { name: 'sid' } } }, authn: { config: { rejectLegacyKeys: false } } } });
    await p.dispose();
    const warned = TestLog.lines.filter((l) => l.startsWith('warn ') && l.includes('rbac.session.cookie.name'));
    expect(warned).to.have.length(1);
    expect(warned[0]).to.contain('authn.session.cookie.name').and.contain('spinajs-authz-convert');
  });

  it('refuses a malformed authn.config through the schema, naming the path', async () => {
    const paths = await violationPaths(buildCore({}, { raw: { authn: { config: { rejectLegacyKeys: 'yes' } } } }));
    expect(paths).to.include('authn.config.rejectLegacyKeys');
  });
});
