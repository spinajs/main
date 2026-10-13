import type { Findings } from './findings.js';
import { RBAC_2X_ARRAYS, RBAC_2X_DEFAULTS } from './legacy.js';
import { copy, firstNonData, getPath, isPlain, keyPath, setPath } from './values.js';
import type { Plain } from './values.js';

/** The three 3.0 roots one layer converts into, each holding its root key (`{ authz: … }`). */
export interface KeyOutput {
  readonly authz: Plain;
  readonly users: Plain;
  readonly authn: Plain;
  /** Array keys this layer needs empty (a 2.x switch turned off); an env layer cannot empty what common fills. */
  readonly cleared: string[];
}

/** 3.0 array keys a 2.x scalar becomes. Arrays concatenate across config files, so an env layer cannot replace them. */
export const SCALAR_TO_ARRAY_KEYS: readonly string[] = Object.freeze(['authz.rbac.defaultRoles', 'authz.rbac.anonymousRoles', 'authn.strategies', 'authn.mfa.steps']);

const SERVICES = {
  auth: { SimpleDbAuthProvider: 'LocalPasswordStrategy' } as Record<string, string>,
  hasher: { BasicPasswordProvider: 'Argon2PasswordHasher' } as Record<string, string>,
  mfa: { Default2FaToken: 'TotpMfaStep' } as Record<string, string>,
  guard: { DefaultRoleGuard: 'DefaultAdminGuard' } as Record<string, string>,
};
const VALIDATION_SERVICE = 'BasicPasswordValidationProvider';
const DAY_SECONDS = 24 * 60 * 60;

class Writer {
  readonly out: KeyOutput = { authz: {}, users: {}, authn: {}, cleared: [] };

  constructor(private readonly f: Findings) {}

  set(target: string, value: unknown): void {
    const path = target.split('.');
    setPath(this.out[path[0] as 'authz' | 'users' | 'authn'], path, value);
  }

  /** Copies a 2.x subtree to `target`, leaving out every part a config file cannot hold as a literal. */
  data(from: string, value: unknown, target: string): void {
    const kept = this.keepData(value, from);
    if (kept !== undefined) this.set(target, kept);
  }

  private keepData(value: unknown, at: string): unknown {
    if (isPlain(value)) {
      const out: Plain = {};
      for (const [k, v] of Object.entries(value)) {
        const kept = this.keepData(v, keyPath(at, k));
        if (kept !== undefined) out[k] = kept;
      }
      // An object emptied by what was left out says nothing; an object empty in 2.x stays.
      return Object.keys(out).length === 0 && Object.keys(value).length > 0 ? undefined : out;
    }
    const bad = firstNonData(value, at);
    if (bad !== undefined) {
      this.f.manual('not-data', `${bad} is not plain data (a function or a class instance); the converter cannot write it. Move ${at} by hand.`, at);
      return undefined;
    }
    return copy(value);
  }
}

function asString(v: unknown, at: string, f: Findings): string | undefined {
  if (typeof v === 'string' && v !== '') return v;
  f.refuse(`${at} must be a non-empty string`);
  return undefined;
}

function asBoolean(v: unknown, at: string, f: Findings): boolean | undefined {
  if (typeof v === 'boolean') return v;
  f.refuse(`${at} must be true or false`);
  return undefined;
}

function asStrings(v: unknown, at: string, f: Findings): string[] | undefined {
  if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return [...(v as string[])];
  f.refuse(`${at} must be an array of strings`);
  return undefined;
}

function asSeconds(v: unknown, at: string, f: Findings): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  f.refuse(`${at} must be a positive whole number of seconds`);
  return undefined;
}

function unknownKeys(node: Plain, known: readonly string[], at: string, f: Findings): void {
  for (const k of Object.keys(node)) {
    if (!known.includes(k)) f.manual('unknown-key', `${keyPath(at, k)} is not a SpinaJS 2.x key the converter knows; move it by hand (3.0 drops the rbac.* root: a boot fails on it unless authz.config.rejectLegacyKeys is false).`, keyPath(at, k));
  }
}

/**
 * Converts every `rbac.*` key of one layer except `grants` and `roles`. `merged` is the config the
 * layer sits in (common, or common + env): keys built from several 2.x keys read it, and are written
 * to the layer that sets one of their sources.
 */
export function convertKeys(layer: Plain, merged: Plain, f: Findings, common?: Plain): KeyOutput {
  const w = new Writer(f);
  const rbac = layer.rbac;
  if (rbac === undefined) return w.out;
  if (!isPlain(rbac)) {
    f.refuse('rbac must be an object');
    return w.out;
  }
  const m = (path: string): unknown => getPath(merged, ['rbac', ...path.split('.')]) ?? RBAC_2X_DEFAULTS[path];
  // 2.x joined these arrays with the package array; the first layer that sets one carries the package part.
  const withPackage = (path: string, values: string[]): string[] => {
    const pkg = RBAC_2X_ARRAYS[path];
    if (!pkg || (common !== undefined && getPath(common, ['rbac', ...path.split('.')]) !== undefined)) return values;
    f.info('package-array', `2.x joined rbac.${path} with the package value ${JSON.stringify(pkg)}; both parts were written.`, `rbac.${path}`);
    return [...new Set([...pkg, ...values])];
  };

  for (const [key, value] of Object.entries(rbac)) {
    const at = `rbac.${key}`;
    switch (key) {
      case 'grants':
      case 'roles':
        break;

      case 'enableGuestAccount': {
        const on = asBoolean(value, at, f);
        if (on === undefined) break;
        w.set('authz.principals.anonymous.enabled', on);
        if (on) {
          // 2.x gives the guest account the role 'guest', whatever rbac.defaultRole says.
          w.set('authz.rbac.anonymousRoles', ['guest']);
          f.info('guest-role', "The 2.x guest account always held the role 'guest'; authz.rbac.anonymousRoles is ['guest'].", at);
        }
        break;
      }

      case 'defaultRole': {
        const role = asString(value, at, f);
        if (role !== undefined) w.set('authz.rbac.defaultRoles', [role]);
        break;
      }

      case 'requireKnownRole':
        if (value === false) f.warn('require-known-role', '2.x accepted unknown roles here; 3.0 always refuses an unknown role on an assignment write and ignores (with a warning) an unknown role on a stored row.', at);
        else f.info('removed', 'Removed: 3.0 always refuses unknown roles.', at);
        break;

      case 'systemRole':
        if (value !== 'system') f.warn('system-role', `The system role was '${String(value)}'. 3.0 has no system role: SYSTEM is a principal (runAs). Role '${String(value)}' stays an ordinary role.`, at);
        else f.info('removed', "Removed: SYSTEM is a principal in 3.0; the role 'system' stays an ordinary role.", at);
        break;

      case 'roleColumn': {
        const column = asString(value, at, f);
        if (column !== undefined) w.set('authz.rbac.migration.roleColumn', column);
        break;
      }

      case 'roleSwitch': {
        if (!isPlain(value)) {
          f.refuse(`${at} must be an object`);
          break;
        }
        unknownKeys(value, ['requirePassword'], at, f);
        if (value.requirePassword !== undefined) {
          const roles = asStrings(value.requirePassword, `${at}.requirePassword`, f);
          if (roles) w.set('authz.principals.roleSwitch.requirePassword', roles);
        }
        break;
      }

      case 'impersonation': {
        if (!isPlain(value)) {
          f.refuse(`${at} must be an object`);
          break;
        }
        unknownKeys(value, ['protectedRoles', 'requirePassword'], at, f);
        if (value.protectedRoles !== undefined) {
          const roles = asStrings(value.protectedRoles, `${at}.protectedRoles`, f);
          if (roles) w.set('authz.impersonation.protectedRoles', withPackage('impersonation.protectedRoles', roles));
        }
        if (value.requirePassword !== undefined) {
          const on = asBoolean(value.requirePassword, `${at}.requirePassword`, f);
          if (on !== undefined) w.set('authn.impersonation.requirePassword', on);
        }
        break;
      }

      case 'admin':
        convertAdmin(value, at, m, w, f);
        break;

      case 'token':
        convertToken(value, at, w, f);
        break;

      case 'user':
      case 'email':
      case 'actions':
        w.data(at, value, `users.${key}`);
        break;

      case 'auth': {
        if (!isPlain(value)) {
          f.refuse(`${at} must be an object`);
          break;
        }
        unknownKeys(value, ['service'], at, f);
        if (value.service !== undefined) {
          const service = asString(value.service, `${at}.service`, f);
          const mapped = service === undefined ? undefined : SERVICES.auth[service];
          if (mapped) w.set('authn.strategies', [{ name: 'local', service: mapped }]);
          else if (service !== undefined) f.manual('custom-service', `Auth provider '${service}' is not a SpinaJS one; port it to an authn Strategy and list it in authn.strategies.`, `${at}.service`);
        }
        break;
      }

      case 'password':
        convertPassword(value, at, w, f, withPackage);
        break;

      case 'session':
        w.data(at, value, 'authn.session');
        break;

      case 'twoFactorAuth':
        convertMfa(value, at, m, w, f);
        break;

      case 'otpauth':
        w.data(at, value, 'authn.mfa.totp');
        break;

      default:
        f.manual('unknown-key', `${at} is not a SpinaJS 2.x key; 3.0 drops the rbac.* root. Move it to a root of your own.`, at);
    }
  }
  return w.out;
}

function convertAdmin(value: unknown, at: string, m: (path: string) => unknown, w: Writer, f: Findings): void {
  if (!isPlain(value)) {
    f.refuse(`${at} must be an object`);
    return;
  }
  unknownKeys(value, ['roleGuard'], at, f);
  const guard = value.roleGuard;
  if (guard === undefined) return;
  const gat = `${at}.roleGuard`;
  if (!isPlain(guard)) {
    f.refuse(`${gat} must be an object`);
    return;
  }
  let wroteGuard = false;
  let hasPermission = false;
  let unresolved = false;
  const lockout: Record<string, boolean | undefined> = {};
  const flags = ['protectSystemRole', 'preventEscalation', 'preventSelfLockout', 'preventLastPrivilegedRemoval'];
  unknownKeys(guard, ['service', 'requireKnownRole', 'privilegedResource', 'privilegedAction', ...flags], gat, f);
  if (guard.service !== undefined) {
    const service = asString(guard.service, `${gat}.service`, f);
    if (service !== undefined) {
      const mapped = SERVICES.guard[service];
      w.set('authz.admin.guard.service', mapped ?? service);
      wroteGuard = true;
      if (!mapped) {
        f.manual(
          'custom-service',
          `Role guard '${service}' was written as found, so boot fails until a 3.0 AdminGuard of that name is registered. Port it to AdminGuard (design §6.6); leaving it out would fall back to DefaultAdminGuard, which may allow more.`,
          `${gat}.service`,
        );
      }
    }
  }
  if (guard.requireKnownRole !== undefined) f.info('removed', 'Removed: AuthzAdmin always refuses unknown roles.', `${gat}.requireKnownRole`);
  for (const flag of flags) {
    if (guard[flag] === undefined) continue;
    const on = asBoolean(guard[flag], `${gat}.${flag}`, f);
    if (on !== undefined) {
      w.set(`authz.admin.guard.${flag}`, on);
      wroteGuard = true;
      lockout[flag] = on;
    }
  }
  if (guard.privilegedResource !== undefined || guard.privilegedAction !== undefined) {
    const resource = m('admin.roleGuard.privilegedResource');
    const action = m('admin.roleGuard.privilegedAction');
    const verb = typeof action === 'string' ? /^(create|read|update|delete)(?::any)?$/.exec(action)?.[1] : undefined;
    if (typeof resource !== 'string' || resource === '' || verb === undefined) {
      unresolved = true;
      f.manual(
        'privileged-permission',
        `privilegedResource '${String(resource)}' with privilegedAction '${String(action)}' names no single 3.0 permission (an :own action has none). Set authz.admin.guard.privilegedPermission by hand.`,
        gat,
      );
    } else {
      w.set('authz.admin.guard.privilegedPermission', `${resource}:${verb}`);
      hasPermission = true;
    }
  }
  if (wroteGuard && !hasPermission && !unresolved && !(lockout.preventSelfLockout === false && lockout.preventLastPrivilegedRemoval === false)) {
    f.manual(
      'guard-privileged-permission',
      'Set authz.admin.guard.privilegedPermission: boot requires it while the self-lockout and last-holder checks are on, and the converter cannot pick it for a guard it did not write.',
      gat,
    );
  }
}

function convertToken(value: unknown, at: string, w: Writer, f: Findings): void {
  if (!isPlain(value)) {
    f.refuse(`${at} must be an object`);
    return;
  }
  unknownKeys(value, ['rolePolicy', 'excludedRoles', 'prefix', 'length', 'generation', 'headerName', 'lastUsedUpdateInterval'], at, f);
  if (value.rolePolicy !== undefined) {
    const rp = value.rolePolicy;
    const service = isPlain(rp) ? rp.service : undefined;
    if (!isPlain(rp) || typeof service !== 'string' || Object.keys(rp).some((k) => k !== 'service')) {
      f.manual('token-role-policy', `${at}.rolePolicy is not { service }; set authz.token.rolePolicy by hand.`, `${at}.rolePolicy`);
    } else {
      w.set('authz.token.rolePolicy', { service });
      if (service !== 'OwnRolesTokenRolePolicy') {
        f.manual(
          'custom-service',
          `Token role policy '${service}' was written as found; boot fails until a 3.0 policy of that name is registered. 3.0 ports no grant-subset rule: a token's roles are the token's roles that its owner holds (B24, B07).`,
          `${at}.rolePolicy.service`,
        );
      }
    }
  }
  if (value.excludedRoles !== undefined) {
    const roles = asStrings(value.excludedRoles, `${at}.excludedRoles`, f);
    if (roles) w.set('authz.token.excludedRoles', roles);
  }
  for (const k of ['prefix', 'headerName']) {
    if (value[k] === undefined) continue;
    const s = asString(value[k], `${at}.${k}`, f);
    if (s !== undefined) w.set(`authn.token.${k}`, s);
  }
  if (value.length !== undefined) {
    if (typeof value.length !== 'number' || !Number.isInteger(value.length)) f.refuse(`${at}.length must be a whole number`);
    else {
      w.set('authn.token.length', value.length);
      if (value.length < 32) f.manual('token-length', `3.0 fails boot on authn.token.length below 32 bytes (A14); it is ${value.length}.`, `${at}.length`);
    }
  }
  if (value.lastUsedUpdateInterval !== undefined) {
    if (typeof value.lastUsedUpdateInterval !== 'number' || !Number.isInteger(value.lastUsedUpdateInterval) || value.lastUsedUpdateInterval < 0) f.refuse(`${at}.lastUsedUpdateInterval must be a whole number of seconds`);
    else w.set('authn.token.lastUsedUpdateInterval', value.lastUsedUpdateInterval);
  }
  if (value.generation !== undefined) w.data(`${at}.generation`, value.generation, 'authn.token.generation');
}

function convertPassword(value: unknown, at: string, w: Writer, f: Findings, withPackage: (path: string, values: string[]) => string[]): void {
  if (!isPlain(value)) {
    f.refuse(`${at} must be an object`);
    return;
  }
  unknownKeys(value, ['service', 'generator', 'validation', 'expiration', 'passwordResetWaitTime', 'invite', 'resetUrl', 'blockAfterAttempts', 'lockoutTime'], at, f);

  if (value.service !== undefined) {
    const service = asString(value.service, `${at}.service`, f);
    const mapped = service === undefined ? undefined : SERVICES.hasher[service];
    if (mapped) w.set('authn.local.hasher.service', mapped);
    else if (service !== undefined) f.manual('custom-service', `Password provider '${service}' is not a SpinaJS one; port it to a PasswordHasher (argon2 keeps its library defaults, H30).`, `${at}.service`);
  }
  if (value.generator !== undefined) {
    w.data(`${at}.generator`, value.generator, 'authn.local.generator');
    const chars = isPlain(value.generator) ? value.generator.characters : undefined;
    if (Array.isArray(chars) && chars.every((c) => typeof c === 'string')) w.set('authn.local.generator.characters', withPackage('password.generator.characters', chars as string[]));
  }

  const validation = value.validation;
  if (validation !== undefined) {
    const vat = `${at}.validation`;
    if (!isPlain(validation)) f.refuse(`${vat} must be an object`);
    else {
      unknownKeys(validation, ['service', 'rule', 'description'], vat, f);
      if (validation.service !== undefined && validation.service !== VALIDATION_SERVICE) {
        f.manual('custom-service', `Password validation provider '${String(validation.service)}' is not a SpinaJS one; 3.0 checks authn.local.policy (rule, lengths, blocklist).`, `${vat}.service`);
      }
      if (validation.rule !== undefined) w.data(`${vat}.rule`, validation.rule, 'authn.local.policy.rule');
      if (validation.description !== undefined) {
        const d = asString(validation.description, `${vat}.description`, f);
        if (d !== undefined) w.set('authn.local.policy.description', d);
      }
    }
  }

  const expiration = value.expiration;
  if (expiration !== undefined) {
    const eat = `${at}.expiration`;
    if (!isPlain(expiration)) f.refuse(`${eat} must be an object`);
    else {
      unknownKeys(expiration, ['enabled', 'passwordExpirationTime'], eat, f);
      if (expiration.enabled !== undefined) {
        const on = asBoolean(expiration.enabled, `${eat}.enabled`, f);
        if (on !== undefined) w.set('authn.local.expiration.enabled', on);
      }
      if (expiration.passwordExpirationTime !== undefined) {
        const s = asSeconds(expiration.passwordExpirationTime, `${eat}.passwordExpirationTime`, f);
        if (s !== undefined) {
          if (s % DAY_SECONDS === 0) w.set('authn.local.expiration.maxAgeDays', s / DAY_SECONDS);
          else f.manual('expiration-days', `passwordExpirationTime is ${s} s, not a whole number of days; set authn.local.expiration.maxAgeDays by hand.`, `${eat}.passwordExpirationTime`);
        }
      }
    }
  }

  if (value.passwordResetWaitTime !== undefined) {
    const s = asSeconds(value.passwordResetWaitTime, `${at}.passwordResetWaitTime`, f);
    if (s !== undefined) w.set('authn.local.reset.ttlSeconds', s);
  }
  if (value.invite !== undefined) {
    const iat = `${at}.invite`;
    if (!isPlain(value.invite)) f.refuse(`${iat} must be an object`);
    else {
      unknownKeys(value.invite, ['waitTime'], iat, f);
      if (value.invite.waitTime !== undefined) {
        const s = asSeconds(value.invite.waitTime, `${iat}.waitTime`, f);
        if (s !== undefined) w.set('authn.local.invite.ttlSeconds', s);
      }
    }
  }
  if (value.resetUrl !== undefined) {
    if (typeof value.resetUrl !== 'string') f.refuse(`${at}.resetUrl must be a string`);
    else w.set('authn.local.reset.url', value.resetUrl);
  }

  if (value.blockAfterAttempts !== undefined) {
    const n = value.blockAfterAttempts;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) f.refuse(`${at}.blockAfterAttempts must be a whole number`);
    else if (n === 0) {
      f.warn('throttle-off', '2.x blockAfterAttempts 0 turned throttling off. 3.0 always backs off (H31); the default authn.throttle.login.account.free stays.', `${at}.blockAfterAttempts`);
    } else {
      // The schema wants the whole triple; the delays are its defaults.
      w.set('authn.throttle.login.account', { free: n, baseDelayMs: 1000, maxDelayMs: 60000 });
      f.warn(
        'lockout-to-backoff',
        `After ${n} failed logins 2.x locked the account; 3.0 never locks. It waits min(baseDelayMs × 2^(n − free), maxDelayMs) before each further attempt, per account and per IP (H31, A06).`,
        `${at}.blockAfterAttempts`,
      );
    }
  }
  if (value.lockoutTime !== undefined) {
    f.warn('lockout-time', 'Dropped: 3.0 never locks an account (H31). The nearest knob is authn.throttle.login.account.maxDelayMs.', `${at}.lockoutTime`);
  }
}

function convertMfa(value: unknown, at: string, m: (path: string) => unknown, w: Writer, f: Findings): void {
  if (!isPlain(value)) {
    f.refuse(`${at} must be an object`);
    return;
  }
  unknownKeys(value, ['enabled', 'forceUser', 'service'], at, f);
  if (value.forceUser !== undefined) {
    const on = asBoolean(value.forceUser, `${at}.forceUser`, f);
    if (on !== undefined) w.set('authn.mfa.policy.force', on);
  }
  if (value.enabled !== undefined && asBoolean(value.enabled, `${at}.enabled`, f) === undefined) return;
  if (value.service !== undefined && asString(value.service, `${at}.service`, f) === undefined) return;

  const enabled = m('twoFactorAuth.enabled');
  const service = m('twoFactorAuth.service');
  if (enabled !== true) {
    w.out.cleared.push('authn.mfa.steps');
    f.info('mfa-off', 'Two-factor login is off here, so authn.mfa.steps stays empty.', at);
    if (m('twoFactorAuth.forceUser') === true) {
      f.manual('mfa-force-without-steps', 'forceUser is on while two-factor login is off: authn refuses authn.mfa.policy.force without a step at boot. Turn force off or list a step in authn.mfa.steps.', `${at}.forceUser`);
    }
    return;
  }
  const mapped = typeof service === 'string' ? SERVICES.mfa[service] : undefined;
  if (!mapped) {
    f.manual('custom-service', `2FA service '${String(service)}' is not a SpinaJS one; port it to an MfaStep and list it in authn.mfa.steps.`, `${at}.service`);
    return;
  }
  w.set('authn.mfa.steps', [{ name: 'totp', service: mapped }]);
}
