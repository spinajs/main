import { expect } from 'chai';

import { Findings, configModule, convertKeys, literal } from '../src/index.js';
import type { KeyOutput } from '../src/index.js';

function run(rbac: Record<string, unknown>, mergedRbac?: Record<string, unknown>): { out: KeyOutput; f: Findings } {
  const f = new Findings();
  const out = convertKeys({ rbac }, { rbac: mergedRbac ?? rbac }, f);
  return { out, f };
}

const codes = (f: Findings, severity?: string) => f.list.filter((x) => !severity || x.severity === severity).map((x) => x.code);

function refused(rbac: Record<string, unknown>, pattern: RegExp): void {
  const { f } = run(rbac);
  expect(f.problems.some((p) => pattern.test(p)), f.problems.join('\n')).to.equal(true);
}

describe('convertKeys', () => {
  describe('authz keys', () => {
    it('maps the guest account, the default role and the role switch', () => {
      const { out, f } = run({ enableGuestAccount: true, defaultRole: 'guest', roleSwitch: { requirePassword: ['admin'] } });
      expect(out.authz).to.deep.equal({
        authz: {
          principals: { anonymous: { enabled: true }, roleSwitch: { requirePassword: ['admin'] } },
          rbac: { anonymousRoles: ['guest'], defaultRoles: ['guest'] },
        },
      });
      expect(codes(f)).to.include('guest-role');
    });

    it('turns the guest account off without anonymous roles', () => {
      const { out } = run({ enableGuestAccount: false });
      expect(out.authz).to.deep.equal({ authz: { principals: { anonymous: { enabled: false } } } });
    });

    it('drops requireKnownRole and systemRole, warning where 2.x behaved differently', () => {
      expect(codes(run({ requireKnownRole: true, systemRole: 'system' }).f, 'warning')).to.deep.equal([]);
      expect(codes(run({ requireKnownRole: false, systemRole: 'root' }).f, 'warning')).to.deep.equal(['require-known-role', 'system-role']);
      expect(run({ requireKnownRole: false }).out.authz).to.deep.equal({});
    });

    it('keeps the role column for the users.Role copy migration', () => {
      expect(run({ roleColumn: 'Roles' }).out.authz).to.deep.equal({ authz: { rbac: { migration: { roleColumn: 'Roles' } } } });
    });

    it('splits impersonation between authz (who) and authn (how), keeping the 2.x package part of the protected roles', () => {
      const { out, f } = run({ impersonation: { requirePassword: true, protectedRoles: ['admin'] } });
      expect(out.authz).to.deep.equal({ authz: { impersonation: { protectedRoles: ['system', 'admin'] } } });
      expect(codes(f)).to.deep.equal(['package-array']);
      const env = new Findings();
      const later = convertKeys({ rbac: { impersonation: { protectedRoles: ['root'] } } }, {}, env, { rbac: { impersonation: { protectedRoles: ['admin'] } } });
      expect(later.authz).to.deep.equal({ authz: { impersonation: { protectedRoles: ['root'] } } });
      expect(out.authn).to.deep.equal({ authn: { impersonation: { requirePassword: true } } });
    });

    it('maps the default role guard and its privileged permission', () => {
      const { out, f } = run({
        admin: {
          roleGuard: {
            service: 'DefaultRoleGuard',
            requireKnownRole: true,
            protectSystemRole: true,
            preventEscalation: false,
            preventSelfLockout: true,
            preventLastPrivilegedRemoval: true,
            privilegedResource: 'users',
            privilegedAction: 'update:any',
          },
        },
      });
      expect(out.authz).to.deep.equal({
        authz: {
          admin: {
            guard: {
              service: 'DefaultAdminGuard',
              protectSystemRole: true,
              preventEscalation: false,
              preventSelfLockout: true,
              preventLastPrivilegedRemoval: true,
              privilegedPermission: 'users:update',
            },
          },
        },
      });
      expect(codes(f, 'manual')).to.deep.equal([]);
    });

    it('reads the other half of the privileged permission from the merged view', () => {
      const { out } = run({ admin: { roleGuard: { privilegedAction: 'delete:any' } } }, { admin: { roleGuard: { privilegedResource: 'users', privilegedAction: 'delete:any' } } });
      expect(out.authz).to.deep.equal({ authz: { admin: { guard: { privilegedPermission: 'users:delete' } } } });
    });

    it('leaves an :own privileged action for a person', () => {
      const { out, f } = run({ admin: { roleGuard: { privilegedResource: 'users', privilegedAction: 'update:own' } } });
      expect(out.authz).to.deep.equal({});
      expect(codes(f, 'manual')).to.deep.equal(['privileged-permission']);
    });

    it('writes a custom guard as found, so boot fails until it is ported, and says so', () => {
      const { out, f } = run({ admin: { roleGuard: { service: 'ScopedRoleGuard' } } });
      expect(out.authz).to.deep.equal({ authz: { admin: { guard: { service: 'ScopedRoleGuard' } } } });
      expect(codes(f, 'manual')).to.deep.equal(['custom-service', 'guard-privileged-permission']);
    });

    it('flags a guard written without privilegedPermission, unless both lockout checks are off', () => {
      const flagged = run({ admin: { roleGuard: { service: 'ScopedRoleGuard', preventEscalation: false } } });
      expect(codes(flagged.f, 'manual')).to.include('guard-privileged-permission');
      expect(flagged.out.authz).to.not.deep.include({ authz: { admin: { guard: { preventSelfLockout: false, preventLastPrivilegedRemoval: false } } } });
      const off = run({ admin: { roleGuard: { preventSelfLockout: false, preventLastPrivilegedRemoval: false } } });
      expect(codes(off.f, 'manual')).to.not.include('guard-privileged-permission');
    });

    it('splits the token keys between authz and authn', () => {
      const { out, f } = run({
        token: {
          rolePolicy: { service: 'OwnRolesTokenRolePolicy' },
          excludedRoles: ['route.*'],
          generation: { service: 'SecureRandomTokenProvider' },
          prefix: 'spt_',
          length: 32,
          headerName: 'x-api-key',
          lastUsedUpdateInterval: 60,
        },
      });
      expect(out.authz).to.deep.equal({ authz: { token: { rolePolicy: { service: 'OwnRolesTokenRolePolicy' }, excludedRoles: ['route.*'] } } });
      expect(out.authn).to.deep.equal({
        authn: { token: { prefix: 'spt_', headerName: 'x-api-key', length: 32, lastUsedUpdateInterval: 60, generation: { service: 'SecureRandomTokenProvider' } } },
      });
      expect(codes(f, 'manual')).to.deep.equal([]);
    });

    it('leaves a custom token role policy and a short token for a person', () => {
      const { out, f } = run({ token: { rolePolicy: { service: 'GrantSubsetTokenRolePolicy' }, length: 16 } });
      expect(out.authz).to.deep.equal({ authz: { token: { rolePolicy: { service: 'GrantSubsetTokenRolePolicy' } } } });
      expect(codes(f, 'manual')).to.deep.equal(['custom-service', 'token-length']);
    });
  });

  describe('users keys', () => {
    it('moves identity keys under users with the same sub-path', () => {
      const { out } = run({ user: { profile: 'BasicProfileProvider' }, email: { connection: 'mail', created: { enabled: true } } });
      expect(out.users).to.deep.equal({ users: { user: { profile: 'BasicProfileProvider' }, email: { connection: 'mail', created: { enabled: true } } } });
    });

    it('leaves out what a config file cannot hold and keeps the rest', () => {
      const hook = () => undefined;
      const { out, f } = run({ actions: { create: { beforeCreate: [], afterCreate: [hook] } } });
      expect(out.users).to.deep.equal({ users: { actions: { create: { beforeCreate: [] } } } });
      expect(run({ actions: { create: { afterCreate: [hook] }, update: {} } }).out.users).to.deep.equal({ users: { actions: { update: {} } } });
      expect(f.list.filter((x) => x.severity === 'manual').map((x) => x.path)).to.deep.equal(['rbac.actions.create.afterCreate']);
    });
  });

  describe('authn keys', () => {
    it('maps the 2.x defaults of rbac.auth and rbac.password', () => {
      const { out, f } = run({
        auth: { service: 'SimpleDbAuthProvider' },
        password: {
          service: 'BasicPasswordProvider',
          generator: { length: 16, characters: ['abc'] },
          validation: { service: 'BasicPasswordValidationProvider', rule: { pattern: '^(?=.*\\d).{8,}$', type: 'string' }, description: 'At least 8' },
          expiration: { enabled: true, passwordExpirationTime: 31 * 24 * 60 * 60 },
          passwordResetWaitTime: 3600,
          invite: { waitTime: 900 },
          resetUrl: 'https://app/reset',
          blockAfterAttempts: 5,
          lockoutTime: 900,
        },
      });
      expect(out.authn).to.deep.equal({
        authn: {
          strategies: [{ name: 'local', service: 'LocalPasswordStrategy' }],
          local: {
            hasher: { service: 'Argon2PasswordHasher' },
            generator: { length: 16, characters: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789', 'abc'] },
            policy: { rule: { pattern: '^(?=.*\\d).{8,}$', type: 'string' }, description: 'At least 8' },
            expiration: { enabled: true, maxAgeDays: 31 },
            reset: { ttlSeconds: 3600, url: 'https://app/reset' },
            invite: { ttlSeconds: 900 },
          },
          throttle: { login: { account: { free: 5, baseDelayMs: 1000, maxDelayMs: 60000 } } },
        },
      });
      expect(codes(f, 'warning')).to.deep.equal(['lockout-to-backoff', 'lockout-time']);
      expect(codes(f, 'manual')).to.deep.equal([]);
    });

    it('keeps the default throttle when 2.x turned throttling off', () => {
      const { out, f } = run({ password: { blockAfterAttempts: 0 } });
      expect(out.authn).to.deep.equal({});
      expect(codes(f, 'warning')).to.deep.equal(['throttle-off']);
    });

    it('leaves an expiry that is not a whole number of days for a person', () => {
      const { out, f } = run({ password: { expiration: { passwordExpirationTime: 36 * 60 * 60 } } });
      expect(out.authn).to.deep.equal({});
      expect(codes(f, 'manual')).to.deep.equal(['expiration-days']);
    });

    it('leaves custom auth, password and validation providers for a person', () => {
      const { out, f } = run({ auth: { service: 'LdapAuth' }, password: { service: 'Bcrypt', validation: { service: 'Mine' } } });
      expect(out.authn).to.deep.equal({});
      expect(codes(f, 'manual')).to.deep.equal(['custom-service', 'custom-service', 'custom-service']);
    });

    it('moves the session block as it is', () => {
      const session = { service: 'DbSessionStore', expiration: { service: 'SlidingExpiration', ttl: 1440 }, cookie: { sameSite: 'none', secure: true } };
      expect(run({ session }).out.authn).to.deep.equal({ authn: { session } });
    });

    it('turns the 2.x two-factor switch into the totp step', () => {
      const { out, f } = run({ twoFactorAuth: { enabled: true, forceUser: true, service: 'Default2FaToken' }, otpauth: { issuer: 'SN', digits: 6 } });
      expect(out.authn).to.deep.equal({
        authn: { mfa: { policy: { force: true }, steps: [{ name: 'totp', service: 'TotpMfaStep' }], totp: { issuer: 'SN', digits: 6 } } },
      });
      expect(codes(f, 'warning')).to.deep.equal([]);
    });

    it('reads the two-factor switch from the merged view and writes no step when it is off', () => {
      const { out, f } = run({ twoFactorAuth: { forceUser: false, enabled: false } }, { twoFactorAuth: { enabled: false, service: 'Default2FaToken' } });
      expect(out.authn).to.deep.equal({ authn: { mfa: { policy: { force: false } } } });
      expect(out.cleared).to.deep.equal(['authn.mfa.steps']);
      expect(codes(f)).to.deep.equal(['mfa-off']);
    });

    it('leaves a forced two-factor login without a step for a person, which the authn schema refuses at boot', () => {
      const { out, f } = run({ twoFactorAuth: { enabled: false } }, { twoFactorAuth: { enabled: false, forceUser: true } });
      expect(out.cleared).to.deep.equal(['authn.mfa.steps']);
      expect(codes(f, 'manual')).to.deep.equal(['mfa-force-without-steps']);
      expect(codes(run({ twoFactorAuth: { enabled: false, forceUser: false } }).f, 'manual')).to.deep.equal([]);
    });

    it('falls back on the 2.x package default (on, Default2FaToken) when the app sets only forceUser', () => {
      const { out } = run({ twoFactorAuth: { forceUser: true } });
      expect(out.authn).to.deep.equal({ authn: { mfa: { policy: { force: true }, steps: [{ name: 'totp', service: 'TotpMfaStep' }] } } });
    });

    it('leaves a custom two-factor service for a person', () => {
      const { f } = run({ twoFactorAuth: { enabled: true, service: 'SmsToken' } });
      expect(codes(f, 'manual')).to.deep.equal(['custom-service']);
    });
  });

  describe('everything else', () => {
    it('leaves keys that are not SpinaJS keys for a person', () => {
      const { out, f } = run({ accountTypes: { a: 1 }, password: { pepper: 'x' } });
      expect(out).to.deep.equal({ authz: {}, users: {}, authn: {}, cleared: [] });
      expect(f.list.filter((x) => x.severity === 'manual').map((x) => x.path)).to.deep.equal(['rbac.accountTypes', 'rbac.password.pepper']);
    });

    it('refuses values of the wrong type', () => {
      refused({ defaultRole: ['user'] }, /rbac\.defaultRole must be a non-empty string/);
      refused({ enableGuestAccount: 'yes' }, /must be true or false/);
      refused({ password: { passwordResetWaitTime: -1 } }, /positive whole number of seconds/);
      refused({ session: 'x', admin: 1 }, /rbac\.admin must be an object/);
    });

    it('skips grants and roles, which convertGrants handles', () => {
      expect(run({ grants: { a: {} }, roles: [] }).out).to.deep.equal({ authz: {}, users: {}, authn: {}, cleared: [] });
    });
  });
});

describe('literal', () => {
  it('writes plain data as a TypeScript literal with quoted keys only where needed', () => {
    expect(literal({ a: 1, 'b.c': [true, null], d: 'x' })).to.equal("{ a: 1, 'b.c': [true, null], d: 'x' }");
  });

  it('escapes backslashes, quotes and line terminators', () => {
    const s = ['a', String.fromCharCode(0x5c), "b'c", String.fromCharCode(0x0a), 'd', String.fromCharCode(0x2028)].join('');
    const text = literal(s);
    expect([...text].some((c) => [0x0a, 0x2028].includes(c.charCodeAt(0)))).to.equal(false);
    expect(new Function(`return ${text};`)()).to.equal(s);
  });

  it('escapes a lone surrogate, which a file write would turn into U+FFFD, and keeps a pair whole', () => {
    const lone = String.fromCharCode(0xd800);
    const pair = String.fromCharCode(0xd83d, 0xde00);
    const text = literal(`${lone}${pair}`);
    expect([...text].some((c) => c === lone)).to.equal(false);
    expect(new Function(`return ${text};`)()).to.equal(`${lone}${pair}`);
  });

  it('keeps line terminators of a header line out of the code', () => {
    const text = configModule({ a: 1 }, [`from a${String.fromCharCode(0x0a)}export const x = 1;`]);
    expect(text.split(String.fromCharCode(0x0a))).to.deep.equal(['// from a export const x = 1;', 'export default { a: 1 };', '']);
  });

  it('breaks nested objects over lines and reads back equal', () => {
    const value = { authz: { rbac: { roles: { user: { extends: ['base'], grants: ['Doc:read', { permission: 'Doc:update', relation: 'owner' }] } } } } };
    const text = literal(value);
    expect(text.split('\n').length).to.be.greaterThan(3);
    expect(new Function(`return ${text};`)()).to.deep.equal(value);
  });
});
