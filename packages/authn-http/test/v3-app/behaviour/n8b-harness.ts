import { randomBytes } from 'node:crypto';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthnEventSink, CredentialAdminGuard, KeyRegistry, MfaPolicy, MfaStep, PasswordService, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnEvent, AuthnFacts, CredentialAdminAction, IdentityRef, Principal } from '@spinajs/authn/contracts';
import { FakeImpersonationGuard, totpFromProvisioning } from '@spinajs/authn-testing';
import type { FakeIdentityStore, Harness, HarnessContext, HarnessFactory, HttpRoutes, LegacyUser, PortName, SecretRowView } from '@spinajs/authn-testing';
import type { LocalPasswordService, PasswordMail } from '@spinajs/authn-local';
import type { AuthnFromUserMetadata_2026_10_02_00_01_00, DbMfaStore, DbSecretStore } from '@spinajs/authn-orm';
import type { TotpService } from '@spinajs/authn-totp/service';

import { bind } from '../app.js';
import type { AppFakes } from '../app.js';
import { PORTS, STRATEGIES, bootBehaviourApp, insertUserRow, laneHttpHarness, shutdownBehaviourApp, tokenDb } from './harness.js';
import type { HarnessLane, StrategyEntry } from './harness.js';

/**
 * The N8b harness: N8a's app and per-case steps (harness.ts) with the REAL strategy packages behind the 3.0 routes,
 * on the same sqlite database. Fakes remain only for what C1 and C3 own (IdentityStore, PasswordCredentialStore,
 * PrincipalFactory, the mailer and users' activation of invited identities).
 *
 * Each strategy package is one LanePart. A later task adds its part to PARTS: `beforeDb` imports the package
 * (migrations included, so they run when the database boots), `strategies` lists its strategy, `open` uncaches its
 * services and clears its tables per case, `ports` names and `addPorts` builds its kit ports, `close` waits for its
 * deferred work. Modules are imported dynamically, so the suites that run before this one see no strategy service;
 * the route groups with and without each package boot in their own processes (test/v3/route-groups-boot.test.ts).
 *
 * Boot the lane once per process: registrations outlive shutdownN8bApp, among them the A32 upgrade migration, which a
 * second boot would run on a database without users_metadata. Suites after auth-password.test.ts also keep its
 * recording PasswordService registered beneath authn-local's.
 */

export interface PartCase {
  readonly ctx: HarnessContext;
  readonly fakes: AppFakes;
}

export interface LanePart {
  readonly name: string;
  /** Once, before the database boots. */
  beforeDb?(): Promise<void>;
  /** Once, after the app and the database boot. */
  boot?(): Promise<void>;
  /** authn.strategies entries; one named like a STRATEGIES entry replaces it. */
  readonly strategies?: readonly StrategyEntry[];
  readonly supportedConfig?: readonly string[];
  readonly routes?: Partial<HttpRoutes>;
  readonly ports: readonly PortName[];
  open?(c: PartCase): Promise<void>;
  addPorts?(c: PartCase, base: Harness): Promise<Partial<Harness>>;
  close?(c: PartCase): Promise<void>;
}

// authn-orm's root registers DbAuthnThrottle and DbAuthnAuditSink over N8a's throttle and sink: files are loaded one by one.
const ORM_LIB = new URL('../../../../authn-orm/lib/mjs/', import.meta.url);
const ormModule = async <T>(file: string): Promise<T> => (await import(new URL(file, ORM_LIB).href)) as T;

export const PASSWORD_ROUTES: Partial<HttpRoutes> = {
  passwordResetRequest: (login) => ({ method: 'POST', path: '/auth/password/reset-request', body: { login } }),
  passwordReset: (login, secret, newPassword) => ({ method: 'POST', path: '/auth/password/reset', body: { login, secret, password: newPassword } }),
  passwordChange: (oldPassword, newPassword) => ({ method: 'PATCH', path: '/user/password', body: { oldPassword, password: newPassword } }),
};

/** Records reset and invite mails; the secret lives nowhere else (SR-09). */
class LaneMailer {
  public readonly mails: PasswordMail[] = [];

  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }

  public secretFor(id: IdentityRef, purpose: 'reset' | 'invite'): string | null {
    const mail = [...this.mails].reverse().find((m) => m.identity.type === id.type && m.identity.id === id.id && m.purpose === purpose);
    return mail?.secret ?? null;
  }
}

/**
 * Activates an invited identity on `invite.redeem`, as users does (C1, N3 hand-off). A class registration:
 * authn-local resolves its sinks with Array.ofType, which skips factories such as N8a's V3AppEventSink, so the
 * password flows' events never reach the kit's events port.
 */
class N8bInviteActivation extends AuthnEventSink {
  public async publish(e: AuthnEvent): Promise<void> {
    if (e.type === 'invite.redeem' && e.outcome === 'success' && e.identity) passwordState?.identities.setStatus(e.identity, { active: true, invitePending: false });
  }
}

interface PasswordState {
  readonly identities: FakeIdentityStore;
  readonly mailer: LaneMailer;
  readonly secrets: DbSecretStore;
  service?: LocalPasswordService;
}

let local: typeof import('@spinajs/authn-local') | undefined;
let secretModule: { DbSecretStore: new (...args: ConstructorParameters<typeof DbSecretStore>) => DbSecretStore } | undefined;
let utc: { fromUtcColumn(v: string | null | undefined): Date | undefined } | undefined;
let upgrade: { AuthnFromUserMetadata_2026_10_02_00_01_00: new () => AuthnFromUserMetadata_2026_10_02_00_01_00 } | undefined;
let passwordState: PasswordState | undefined;
let passwordBound = false;

function loaded<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not loaded: bootN8bApp() has not run`);
  return value;
}

const passwordNow = (): PasswordState => loaded(passwordState, 'the password part');

async function seedLegacy(fakes: AppFakes, users: readonly LegacyUser[]): Promise<void> {
  const db = tokenDb();
  for (const u of users) {
    await db.insert().into('users').values({ Uuid: u.Uuid, Email: u.Email, Login: u.Login, Password: 'x'.repeat(20), Role: 'user', IsActive: u.IsActive });
    const [row] = (await db.select().from('users').where('Uuid', u.Uuid)) as { Id: number }[];
    for (const m of u.metadata) await db.insert().into('users_metadata').values({ Key: m.Key, Type: m.Type, Value: m.Value, user_id: row.Id });
    // C1's IdentityStore over these rows: invite-pending while 2.x saw user:invite:pending as true.
    const invitePending = u.metadata.some((m) => m.Key === 'user:invite:pending' && m.Value === 'true');
    fakes.identities.add({ id: u.Uuid, login: u.Login, email: u.Email, status: { active: u.IsActive, invitePending } });
  }
}

async function secretRows(): Promise<SecretRowView[]> {
  const { fromUtcColumn } = loaded(utc, 'authn-orm');
  const rows = (await tokenDb().select().from('authn_secret').orderBy('id')) as Record<string, string | null>[];
  return rows.map((r) => ({ identity: r.identity!, purpose: r.purpose!, secret_hash: r.secret_hash!, expires_at: fromUtcColumn(r.expires_at)!, created_at: fromUtcColumn(r.created_at)!, used_at: fromUtcColumn(r.used_at) ?? null }));
}

/** authn-orm's `<type>:<id>` identity column; the id may hold more colons. */
function identityOf(key: string): IdentityRef {
  const at = key.indexOf(':');
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

async function metadataKeys(uuid: string): Promise<string[]> {
  const db = tokenDb();
  const [user] = (await db.select().from('users').where('Uuid', uuid)) as { Id: number }[];
  return ((await db.select().from('users_metadata').where('user_id', user.Id)) as { Key: string }[]).map((r) => r.Key);
}

/** authn-local (LocalPasswordStrategy, LocalPasswordService, argon2) with authn-orm's DbSecretStore and the N4 upgrade migration. */
export const passwordPart: LanePart = {
  name: 'password',
  async beforeDb() {
    local = await import('@spinajs/authn-local');
    await ormModule('migrations/AuthnInitial_2026_10_02_00_00_00.js');
    secretModule = await ormModule('secrets/db-secret-store.js');
    utc = await ormModule('models/utc.js');
    if (!passwordBound) {
      passwordBound = true;
      bind(local.PasswordMailer, 'N8bPasswordMailer', () => passwordNow().mailer);
      // Over the DbSecretStore class the module registers: one store per case, on the current database.
      bind(SecretStore, 'N8bSecretStore', () => passwordNow().secrets);
      DI.register(N8bInviteActivation).as(AuthnEventSink);
    }
  },
  async boot() {
    // Imported after the boot: on startup there are no 2.x tables yet, and each A32 case runs it by itself.
    upgrade = await ormModule('migrations/AuthnFromUserMetadata_2026_10_02_00_01_00.js');
    await tokenDb()
      .schema()
      .createTable('users_metadata', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Key', 255).notNull();
        table.enum('Type', ['number', 'float', 'string', 'json', 'boolean', 'datetime']).notNull();
        table.text('Value');
        table.int('user_id').notNull();
      });
  },
  strategies: [{ name: 'local', service: 'LocalPasswordStrategy' }],
  supportedConfig: ['authn.local.reset.revokeTokens', 'authn.local.reset.ttlSeconds', 'authn.local.invite.ttlSeconds'],
  routes: PASSWORD_ROUTES,
  ports: ['password', 'passwordStore', 'outbox', 'secrets', 'secretStorage', 'migration'],
  async open(c) {
    const l = loaded(local, 'authn-local');
    for (const type of [PasswordService, l.LocalPasswordService, l.PasswordHasher, l.Argon2PasswordHasher, l.LocalPasswordPolicy]) DI.uncache(type as unknown as Class<unknown>);
    const db = tokenDb();
    for (const table of ['users_metadata', 'authn_secret', 'users']) await db.del().from(table);
    passwordState = { identities: c.fakes.identities, mailer: new LaneMailer(), secrets: new (loaded(secretModule, 'authn-orm').DbSecretStore)(db) };
  },
  async addPorts(c) {
    const l = loaded(local, 'authn-local');
    const state = passwordNow();
    const hasher = await DI.resolve(l.PasswordHasher);
    const service = (await DI.resolve(PasswordService)) as LocalPasswordService;
    if (!(service instanceof l.LocalPasswordService)) throw new Error(`PasswordService resolves to ${(service as object | null)?.constructor?.name}, not authn-local's`);
    state.service = service;
    return {
      seed: {
        async user(spec) {
          const ref = c.fakes.identities.add({ login: spec.login, email: spec.email ?? spec.login, status: spec.status });
          if (spec.password !== undefined) await c.fakes.passwords.set(ref, await hasher.hash(spec.password));
          await insertUserRow(ref.id);
          return ref;
        },
        setStatus: async (id, status) => c.fakes.identities.setStatus(id, status),
      },
      // N8a's spy counts its fake strategies only; none of them takes passwords here.
      spy: undefined,
      password: service,
      passwordStore: c.fakes.passwords,
      secrets: state.secrets,
      secretStorage: {
        rows: async () => (await secretRows()).map((r) => ({ identity: identityOf(r.identity), purpose: r.purpose, hash: r.secret_hash, expiresAt: r.expires_at, usedAt: r.used_at })),
      },
      outbox: {
        async secretFor(id, purpose) {
          await service.drain();
          return state.mailer.secretFor(id, purpose);
        },
      },
      migration: {
        seedLegacy: (users) => seedLegacy(c.fakes, users),
        run: () => new (loaded(upgrade, 'the upgrade migration').AuthnFromUserMetadata_2026_10_02_00_01_00)().up(tokenDb()),
        secretRows,
        metadataKeys,
      },
    };
  },
  async close() {
    await passwordState?.service?.drain();
    passwordState = undefined;
  },
};

/** Every event of the strategy packages' class-resolved sinks (see N8bInviteActivation), per case. */
export const laneEvents: AuthnEvent[] = [];

class N8bEventRecorder extends AuthnEventSink {
  public async publish(e: AuthnEvent): Promise<void> {
    laneEvents.push(e);
  }
}

let recorderBound = false;

// TotpService comes through the users-free subpath export; the step, the store base and authn-orm's DbMfaStore by file,
// since authn-totp's and authn-orm's roots load @spinajs/users or register authn-orm's throttle and audit sink.
const TOTP_LIB = new URL('../../../../authn-totp/lib/mjs/', import.meta.url);
const totpModule = async <T>(file: string): Promise<T> => (await import(new URL(file, TOTP_LIB).href)) as T;

export const MFA_ROUTES: Partial<HttpRoutes> = {
  mfaEnrol: () => ({ method: 'POST', path: '/user/mfa' }),
  mfaConfirm: (code) => ({ method: 'POST', path: '/user/mfa/confirm', body: { code } }),
  mfaDisable: (code) => ({ method: 'POST', path: '/user/mfa/disable', body: { code } }),
};

export const MFA_STEPS = [{ name: 'totp', service: 'TotpMfaStep' }];
const MFA_ENCRYPTION_KEY = { secret: randomBytes(32).toString('hex') };

export type TotpStepLike = MfaStep & { regenerateRecoveryCodes(id: IdentityRef): Promise<readonly string[]> };

interface TotpModules {
  readonly TotpService: new (...args: never[]) => TotpService;
  readonly TotpMfaStep: new (...args: never[]) => TotpStepLike;
  readonly MfaSecretStore: abstract new (...args: never[]) => unknown;
  readonly DbMfaStore: new (...args: ConstructorParameters<typeof DbMfaStore>) => DbMfaStore;
}

interface TotpState {
  readonly db: DbMfaStore;
  /** Set: the store's code checks throw, as a broken database would. */
  failing: boolean;
  readonly provisioning: Map<string, string>;
  readonly recoveryCodes: Map<string, readonly string[]>;
  /** Run in reverse when the case closes. */
  readonly undo: (() => void)[];
}

let totp: TotpModules | undefined;
let totpState: TotpState | undefined;
let totpBound = false;

const totpNow = (): TotpState => loaded(totpState, 'the TOTP part');
const refKey = (id: IdentityRef): string => `${id.type}:${id.id}`;

/** authn-totp's MfaSecretStore contract over authn-orm's DbMfaStore, as authn-totp's DbMfaSecretStore implements it. */
function laneMfaStore(): unknown {
  const db = (): DbMfaStore => totpNow().db;
  const guarded = <T>(work: () => Promise<T>): Promise<T> => (totpNow().failing ? Promise.reject(new Error('the lane MFA store is down')) : work());
  return {
    get: async (id: IdentityRef, step: string) => {
      const row = await db().get(id, step);
      return row && Object.freeze({ ...row });
    },
    put: (id: IdentityRef, step: string, secretEnc: string, keyId: string) => db().putPending(id, step, secretEnc, keyId),
    confirm: (id: IdentityRef, step: string, at: Date | undefined, expected: string | undefined) => {
      if (expected === undefined) return Promise.reject(new Error('the lane MFA store confirms a known cipher text only'));
      return db().confirm(id, step, at, expected);
    },
    acceptStep: (id: IdentityRef, step: string, timeStep: number) => guarded(() => db().acceptStep(id, step, timeStep)),
    remove: (id: IdentityRef, step: string) => db().remove(id, step),
    replaceRecoveryCodes: (id: IdentityRef, raw: readonly string[]) => db().replaceRecoveryCodes(id, raw),
    redeemRecoveryCode: (id: IdentityRef, raw: string) => guarded(() => db().redeemRecoveryCode(id, raw)),
    countRecoveryCodes: (id: IdentityRef) => db().countRecoveryCodes(id),
    removeRecoveryCodes: (id: IdentityRef) => db().removeRecoveryCodes(id),
  };
}

/** Sets `path` and returns what puts the old value back, or removes the key when there was none. */
function setConfig(path: string, value: unknown): () => void {
  const c = DI.get(Configuration)!;
  const dot = path.lastIndexOf('.');
  const parentPath = path.slice(0, dot);
  const key = path.slice(dot + 1);
  const parent = c.get<Record<string, unknown>>(parentPath);
  const had = Object.hasOwn(parent, key);
  const old = parent[key];
  c.set(path, value);
  return () => {
    if (had) c.set(path, old);
    else delete c.get<Record<string, unknown>>(parentPath)[key];
  };
}

/** The resolved TotpMfaStep, the one MfaStepRegistry hands out for authn.mfa.steps. */
export async function laneTotpStep(): Promise<TotpStepLike> {
  return (await DI.resolve(loaded(totp, 'authn-totp').TotpMfaStep as unknown as Class<TotpStepLike>)) as TotpStepLike;
}

/** The TotpService class the subpath export registered. */
export const laneTotpServiceClass = (): TotpModules['TotpService'] => loaded(totp, 'authn-totp').TotpService;

/** Replaces authn.mfa.steps or authn.mfa.encryptionKey (undefined removes it) until the case ends. */
export async function laneMfaConfig(over: { steps?: unknown; encryptionKey?: unknown }): Promise<void> {
  const state = totpNow();
  for (const [key, value] of Object.entries(over)) state.undo.push(setConfig(`authn.mfa.${key}`, value));
  // It lists the steps once per resolve.
  const { MfaStepRegistry } = await import('@spinajs/authn');
  DI.uncache(MfaStepRegistry as unknown as Class<unknown>);
}

/** Puts the lane's TOTP store out of order (code checks throw) until the case ends. */
export function failMfaStore(): void {
  totpNow().failing = true;
}

/** authn-totp: the real TotpMfaStep as the `totp` step and TotpService behind the enrolment routes, on authn_mfa in sqlite. */
export const totpPart: LanePart = {
  name: 'totp',
  async beforeDb() {
    const { TotpService } = await import('@spinajs/authn-totp/service');
    const { TotpMfaStep } = await totpModule<{ TotpMfaStep: TotpModules['TotpMfaStep'] }>('step/totp-step.js');
    const { MfaSecretStore } = await totpModule<{ MfaSecretStore: TotpModules['MfaSecretStore'] }>('store/store.js');
    const { DbMfaStore } = await ormModule<{ DbMfaStore: TotpModules['DbMfaStore'] }>('mfa/db-mfa-store.js');
    // A second copy of the module graph would register a second TotpMfaStep beside the subpath's.
    if (!(DI.getRegisteredTypes(MfaStep as unknown as Class<unknown>) ?? []).includes(TotpMfaStep as unknown as Class<unknown>)) throw new Error('authn-totp is loaded twice: the step loaded by file is not the one the subpath registered');
    totp = { TotpService, TotpMfaStep, MfaSecretStore, DbMfaStore };
    if (!totpBound) {
      totpBound = true;
      bind(MfaSecretStore, 'N8bMfaSecretStore', laneMfaStore);
    }
    if (!recorderBound) {
      recorderBound = true;
      DI.register(N8bEventRecorder).as(AuthnEventSink);
    }
  },
  supportedConfig: ['authn.mfa.totp'],
  routes: MFA_ROUTES,
  ports: ['mfa'],
  async open() {
    const t = loaded(totp, 'authn-totp');
    for (const type of [t.TotpService, t.TotpMfaStep]) DI.uncache(type as unknown as Class<unknown>);
    const db = tokenDb();
    for (const table of ['authn_mfa', 'authn_recovery_code']) await db.del().from(table);
    laneEvents.length = 0;
    const undo = [setConfig('authn.mfa.steps', MFA_STEPS), setConfig('authn.mfa.encryptionKey', MFA_ENCRYPTION_KEY)];
    totpState = { db: new t.DbMfaStore(db), failing: false, provisioning: new Map(), recoveryCodes: new Map(), undo };
  },
  async addPorts() {
    const state = totpNow();
    const step = await laneTotpStep();
    const provisioningOf = (id: IdentityRef): string => {
      const uri = state.provisioning.get(refKey(id));
      if (!uri) throw new Error(`${refKey(id)} is not enrolled through mfa.enrol`);
      return uri;
    };
    return {
      mfa: {
        step,
        async enrol(id) {
          const { provisioning } = await step.beginEnrolment(id);
          // The previous time step confirms, so the current one stays free for code().
          const { recoveryCodes } = await step.confirmEnrolment(id, totpFromProvisioning(provisioning, new Date(Date.now() - 30_000)));
          state.provisioning.set(refKey(id), provisioning);
          state.recoveryCodes.set(refKey(id), recoveryCodes ?? []);
        },
        code: async (id) => totpFromProvisioning(provisioningOf(id), new Date()),
        recoveryCodes: async (id) => state.recoveryCodes.get(refKey(id)) ?? [],
      },
    };
  },
  async close() {
    totpState?.undo.reverse().forEach((u) => u());
    totpState = undefined;
  },
};

// N8a's harness loads authn-token's service, strategy and migrations by file from this build (harness.ts); the same
// URL gives the same module, so TokenProfilePolicy below is the base DbTokenService injects.
const TOKEN_LIB = new URL('../../../../authn-token/lib/mjs/', import.meta.url);

export const TOKEN_ROUTES: Partial<HttpRoutes> = {
  tokenCreate: (o) => ({ method: 'POST', path: '/user/tokens', body: { name: o.name, expiresAt: o.expiresAt.toISOString(), ...(o.reauthPassword !== undefined ? { reauthPassword: o.reauthPassword } : {}) } }),
  tokenList: () => ({ method: 'GET', path: '/user/tokens' }),
};

/** The profiles the lane's TokenProfilePolicy offers every owner; none at the start of a case, as authn-token's default. */
let tokenProfiles: readonly string[] = [];
let tokenBound = false;

/** Lets every owner pin a token to `profiles` until the case ends. */
export function laneTokenProfiles(profiles: readonly string[]): void {
  tokenProfiles = [...profiles];
}

/** authn-token: DbTokenService behind the token routes and TokenStrategy behind bearer requests, on rbac_access_tokens in sqlite. */
export const tokenPart: LanePart = {
  name: 'token',
  async beforeDb() {
    const { TokenProfilePolicy } = (await import(new URL('service/index.js', TOKEN_LIB).href)) as { TokenProfilePolicy: abstract new () => unknown };
    if (!tokenBound) {
      tokenBound = true;
      // Over authn-token's NoTokenProfilesPolicy, which offers none.
      bind(TokenProfilePolicy, 'N8bTokenProfiles', () => ({ allowedProfiles: async () => [...tokenProfiles] }));
    }
  },
  routes: TOKEN_ROUTES,
  ports: ['tokens'],
  async open() {
    tokenProfiles = [];
  },
  async addPorts(_c, base) {
    const name = (base.tokens as object | undefined)?.constructor?.name;
    if (name !== 'DbTokenService') throw new Error(`TokenService resolves to ${name}, not authn-token's DbTokenService`);
    return {};
  },
  async close() {
    tokenProfiles = [];
  },
};

export const KEY_ROUTES: Partial<HttpRoutes> = {
  keyChallenge: (req) => ({ method: 'POST', path: '/auth/keys/challenge', body: req.purpose === 'login' ? { purpose: 'login', kid: req.kid } : { purpose: 'register' } }),
  keyLogin: (c) => ({ method: 'POST', path: '/auth/keys/login', body: { keyId: c.keyId, challengeId: c.challengeId, signature: c.signature } }),
};

/** The audience clients put in challenge signatures and assertions (authn.keys.assertion.audience). */
export const KEYS_AUDIENCE = 'https://n8b-lane.example.test';

let keysModule: typeof import('@spinajs/authn-keys') | undefined;
let keysUndo: (() => void) | undefined;

export const laneKeys = (): typeof import('@spinajs/authn-keys') => loaded(keysModule, 'authn-keys');

/**
 * Sets these leaves of authn.keys (path below authn.keys → value) until the case ends. Leaves, not the block:
 * Configuration.set skips the schema, so a replaced block would lose the defaults authn-keys' range floor checks.
 */
export function laneKeysConfig(leaves: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(leaves)) {
    const undo = setConfig(`authn.keys.${path}`, value);
    const earlier = keysUndo;
    keysUndo = () => {
      undo();
      earlier?.();
    };
  }
}

/** The authn.mfa.policy.service of a case whose key logins must pass TOTP; no other login asks for a step. */
export const KEY_LOGIN_MFA_POLICY = 'N8bKeyLoginMfaPolicy';

class N8bKeyLoginMfaPolicy extends MfaPolicy {
  public async required(_id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]> {
    return facts.method === 'key-challenge' ? ['totp'] : [];
  }
}

let keyPolicyBound = false;

/**
 * authn-keys: DefaultKeyRegistry over authn_key (OrmKeyStore) behind the key routes, KeyChallengeStrategy for key
 * logins and JwsAssertionStrategy for key principals, challenges in the password part's DbSecretStore, assertion jtis
 * in authn_nonce (authn-orm's AuthnInitial). Its root loads no @spinajs/users.
 */
export const keysPart: LanePart = {
  name: 'keys',
  async beforeDb() {
    keysModule = await import('@spinajs/authn-keys');
    if (!keyPolicyBound) {
      keyPolicyBound = true;
      DI.register(N8bKeyLoginMfaPolicy).as(MfaPolicy);
    }
  },
  strategies: [
    { name: 'keys-challenge', service: 'KeyChallengeStrategy' },
    { name: 'keys-jws', service: 'JwsAssertionStrategy' },
  ],
  supportedConfig: ['authn.mfa.policy.service'],
  routes: KEY_ROUTES,
  ports: ['keys', 'keyProofs', 'assertion'],
  async open() {
    const k = laneKeys();
    // The registry holds the case's SecretStore and throttle; the strategies are uncached with the case services.
    for (const base of [KeyRegistry, k.KeyNonceStore] as Class<unknown>[]) {
      for (const type of DI.getRegisteredTypes(base) ?? []) DI.uncache(type as Class<unknown>);
      DI.uncache(base);
    }
    const db = tokenDb();
    for (const table of ['authn_key', 'authn_nonce']) await db.del().from(table);
    keysUndo = undefined;
    laneKeysConfig({ 'assertion.audience': KEYS_AUDIENCE });
  },
  async addPorts() {
    const k = laneKeys();
    const keys = await DI.resolve(KeyRegistry);
    if (!(keys instanceof k.DefaultKeyRegistry)) throw new Error(`KeyRegistry resolves to ${(keys as object | null)?.constructor?.name}, not authn-keys' DefaultKeyRegistry`);
    return {
      keys,
      keyProofs: { sign: async (challenge, purpose, key) => k.signChallenge(challenge, purpose, KEYS_AUDIENCE, key.privateKey, key.alg) },
      assertion: { audience: KEYS_AUDIENCE, issuerOf: k.assertionIssuer },
    };
  },
  async close() {
    keysUndo?.();
    keysUndo = undefined;
  },
};

const adminPath = (target: IdentityRef, action: string): string => `/authn/admin/users/${encodeURIComponent(target.id)}/${action}`;

export const ADMIN_ROUTES: Partial<HttpRoutes> = {
  adminPasswordReset: (target) => ({ method: 'POST', path: adminPath(target, 'password-reset') }),
  adminMfaReset: (target) => ({ method: 'POST', path: adminPath(target, 'mfa-reset') }),
  adminSessionsRevoke: (target) => ({ method: 'DELETE', path: adminPath(target, 'sessions') }),
  adminTokensRevoke: (target) => ({ method: 'DELETE', path: adminPath(target, 'tokens') }),
};

interface AdminState {
  /** Identities that hold users:credentials. */
  readonly rights: Set<string>;
  /** The kit's targetGuard port: the target rule users' guard asks AuthzTargetGuard for. */
  readonly targets: FakeImpersonationGuard;
  readonly calls: { actor: Principal; target: IdentityRef; action: CredentialAdminAction }[];
}

let adminState: AdminState | undefined;
let adminBound = false;
let admins = 0;

const adminNow = (): AdminState => loaded(adminState, 'the admin part');

/** The calls the lane's CredentialAdminGuard got in this case. */
export const laneAdminGuardCalls = (): AdminState['calls'] => adminNow().calls;

/**
 * Stands in for users' AuthzCredentialAdminGuard: an impersonating actor or one without users:credentials is
 * `forbidden`, then the targetGuard port decides.
 */
class N8bCredentialAdminGuard extends CredentialAdminGuard {
  public async allowed(actor: Principal, target: IdentityRef, action: CredentialAdminAction): Promise<{ ok: true } | { ok: false; code: 'forbidden' | 'protected_role' | 'escalation' | 'not_found' }> {
    const state = adminNow();
    state.calls.push({ actor, target, action });
    if (actor.authn?.impersonator !== undefined || !state.rights.has(actor.id)) return { ok: false, code: 'forbidden' };
    return state.targets.allowed(actor, target);
  }
}

/**
 * The credential admin routes behind the lane's CredentialAdminGuard. Registered on the first boot of the lane and never
 * removed, so test/v3-app/auth-admin.test.ts, which needs the group off, sorts before behaviour/.
 */
export const adminPart: LanePart = {
  name: 'admin',
  async beforeDb() {
    if (!adminBound) {
      adminBound = true;
      const guard = new N8bCredentialAdminGuard();
      bind(CredentialAdminGuard, 'N8bCredentialAdminGuard', () => guard);
    }
  },
  routes: ADMIN_ROUTES,
  ports: ['actors', 'targetGuard'],
  async open() {
    adminState = { rights: new Set(), targets: new FakeImpersonationGuard(), calls: [] };
  },
  async addPorts(c, base) {
    const state = adminNow();
    const seed = base.seed!;
    // TotpService (adminReset's mfa.disable) resolves its sinks with Array.ofType, which skips N8a's factory sink behind
    // the events port; the class recorder gets every event. Only for A25, so the other rules' event counts stay as claimed.
    const events = c.ctx.rule === 'A25' ? { events: { all: () => [...laneEvents], clear: () => void (laneEvents.length = 0) } } : {};
    return {
      ...events,
      targetGuard: state.targets,
      actors: {
        async admin({ credentialsRight }) {
          admins++;
          const login = `lane-admin-${admins}@example.test`;
          const password = `Lane-Admin-Pass-${admins}`;
          const ref = await seed.user({ login, password });
          if (credentialsRight) state.rights.add(ref.id);
          return { ref, login, password };
        },
      },
    };
  },
  async close() {
    adminState = undefined;
  },
};

/** The lane's parts; later tasks append theirs. */
export const PARTS: readonly LanePart[] = [passwordPart, totpPart, tokenPart, keysPart, adminPart];

/** The config keys the parts apply over N8a's. */
export const N8B_SUPPORTED_CONFIG: readonly string[] = PARTS.flatMap((p) => p.supportedConfig ?? []);

function strategiesOf(parts: readonly LanePart[]): StrategyEntry[] {
  const out = [...STRATEGIES];
  for (const entry of parts.flatMap((p) => p.strategies ?? [])) {
    const at = out.findIndex((e) => e.name === entry.name);
    if (at >= 0) out[at] = entry;
    else out.push(entry);
  }
  return out;
}

/** Every port of an N8b case: N8a's without its spy, and each part's. */
export const N8B_PORTS: readonly PortName[] = [...new Set([...PORTS.filter((p) => p !== 'spy'), ...PARTS.flatMap((p) => p.ports)])];

function laneOf(parts: readonly LanePart[]): HarnessLane {
  let current: PartCase | undefined;
  return {
    strategies: strategiesOf(parts),
    supportedConfig: parts.flatMap((p) => p.supportedConfig ?? []),
    routes: Object.assign({}, ...parts.map((p) => p.routes ?? {})) as Partial<HttpRoutes>,
    async open(ctx, fakes) {
      current = { ctx, fakes };
      for (const p of parts) await p.open?.(current);
    },
    async ports(base) {
      const c = loaded(current, 'the case');
      let h: Harness = base;
      const over: Partial<Harness> = {};
      for (const p of parts) {
        const added = (await p.addPorts?.(c, h)) ?? {};
        Object.assign(over, added);
        h = { ...h, ...added };
      }
      const merged = h as Record<string, unknown>;
      const given = Object.keys(merged)
        .filter((k) => k !== 'dispose' && merged[k] !== undefined)
        .sort();
      if (given.join() !== [...N8B_PORTS].sort().join()) throw new Error(`N8B_PORTS lists ${[...N8B_PORTS].sort().join()}, the harness has ${given.join()}`);
      return over;
    },
    async close() {
      const c = current;
      current = undefined;
      if (c) for (const p of [...parts].reverse()) await p.close?.(c);
    },
  };
}

export const n8bHarness: HarnessFactory = laneHttpHarness(laneOf(PARTS));

/** Boots the app and a fresh database with every part loaded; after N8a's suite has shut its own down. */
export async function bootN8bApp(): Promise<void> {
  await bootBehaviourApp({
    beforeDb: async () => {
      for (const p of PARTS) await p.beforeDb?.();
    },
  });
  for (const p of PARTS) await p.boot?.();
}

export const shutdownN8bApp = shutdownBehaviourApp;
