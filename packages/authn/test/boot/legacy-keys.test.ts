import * as chai from 'chai';
import 'mocha';
import { InvalidOption } from '@spinajs/exceptions';

import { AUTHN_LEGACY_KEYS, checkAuthnLegacyKeys, findAuthnLegacyKeys } from '../../src/index.js';
import { buildCore } from '../behaviour/harness.js';
import { useTestLog } from '../audit/test-log.js';

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
    it('warns once, naming each key and where it goes, and boots', () => {
      const l = log();
      const found = checkAuthnLegacyKeys(config({ rbac: { password: { lockoutTime: 900, resetUrl: 'https://secret.example.com/reset?k=1' } } }), l);
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

    it('fails boot only when authn.config.rejectLegacyKeys is true', () => {
      const rbac = { session: { service: 'MemorySessionStore' } };
      expect(() => checkAuthnLegacyKeys(config({ rbac, authn: { config: { rejectLegacyKeys: true } } }), log())).to.throw(InvalidOption, /rbac\.session\.service -> authn\.session\.service/);
      expect(() => checkAuthnLegacyKeys(config({ rbac, authn: { config: { rejectLegacyKeys: false } } }), log())).to.not.throw();
      expect(() => checkAuthnLegacyKeys(config({ rbac }), log())).to.not.throw();
      expect(() => checkAuthnLegacyKeys(config({ authn: { config: { rejectLegacyKeys: true } } }), log())).to.not.throw();
    });

    it('refuses a rejectLegacyKeys that is not a boolean', () => {
      for (const v of ['true', 1, null]) {
        expect(() => checkAuthnLegacyKeys(config({ authn: { config: { rejectLegacyKeys: v } } }), log()), String(v)).to.throw(InvalidOption, /rejectLegacyKeys/);
      }
      expect(() => checkAuthnLegacyKeys(config({ authn: { config: 'on' } }), log())).to.throw(InvalidOption, /authn\.config/);
    });
  });
});

describe('DefaultAuthnService boot: legacy keys', function () {
  // Each case boots one or two containers.
  this.timeout(20000);
  useTestLog();

  it('fails boot on a 2.x key of the table only when authn.config.rejectLegacyKeys is true', async () => {
    const rbac = { password: { lockoutTime: 900 } };
    let error: unknown;
    try {
      const p = await buildCore({}, { raw: { rbac, authn: { config: { rejectLegacyKeys: true } } } });
      await p.dispose();
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidOption);
    expect((error as Error).message).to.contain('rbac.password.lockoutTime -> dropped');
    const p = await buildCore({}, { raw: { rbac } });
    await p.dispose();
  });

  it('fails boot on a malformed authn.config', async () => {
    let error: unknown;
    try {
      const p = await buildCore({}, { raw: { authn: { config: { rejectLegacyKeys: 'yes' } } } });
      await p.dispose();
    } catch (e) {
      error = e;
    }
    expect((error as Error | undefined)?.message).to.match(/authn\.config\.rejectLegacyKeys/);
  });
});
