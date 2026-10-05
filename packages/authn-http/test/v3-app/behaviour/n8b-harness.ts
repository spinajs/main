import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthnEventSink, PasswordService, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnEvent, IdentityRef } from '@spinajs/authn/contracts';
import type { FakeIdentityStore, Harness, HarnessContext, HarnessFactory, HttpRoutes, LegacyUser, PortName, SecretRowView } from '@spinajs/authn-testing';
import type { LocalPasswordService, PasswordMail } from '@spinajs/authn-local';
import type { AuthnFromUserMetadata_2026_10_02_00_01_00, DbSecretStore } from '@spinajs/authn-orm';

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
 * deferred work. Modules are imported dynamically: until a part loads it, no strategy service is registered, which
 * the gate suites rely on.
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
  ports: ['password', 'passwordStore', 'outbox', 'secrets', 'migration'],
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

/** The lane's parts; later tasks append theirs. */
export const PARTS: readonly LanePart[] = [passwordPart];

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
