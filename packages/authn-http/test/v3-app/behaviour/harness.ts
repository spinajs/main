import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { ServerMiddleware } from '@spinajs/http';
import {
  AuthenticationStrategy,
  AuthnEventSink,
  AuthnResponseExtension,
  AuthnService,
  AuthnThrottle,
  CredentialExtractor,
  IdentityStore,
  ImpersonationGuard,
  MfaPolicy,
  MfaStep,
  PasswordCredentialStore,
  PrincipalFactory,
  RoleSource,
  SessionIssuer,
  TokenService,
} from '@spinajs/authn/contracts';
import type { Credentials, IdentityRef } from '@spinajs/authn/contracts';
import { MemorySessionStore, PUBLIC_DEFAULT_COOKIE_SECRET, SessionExpirationProvider, SessionProvider, sessionCookieName, appEnvOf } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { FakeIdentityStore, FakeImpersonationGuard, FakeMfaStep, FakeRoleSource, FakeStrategy, KIT_ATTRIBUTES, MemoryPasswordCredentialStore, RecordingEventSink, RecordingPrincipalFactory, UnsupportedConfig, fakeSeedPort } from '@spinajs/authn-testing';
import type { BootPort, BootSpec, ConfigOverrides, Harness, HarnessContext, HarnessFactory, HttpPort, HttpRequest, HttpResponse, HttpRoutes, PortName } from '@spinajs/authn-testing';

import { AuthnPrincipalResolver } from '../../../src/api.js';
import { AUTHN_PROBE_PATH, resetAuthnProbeHits } from '../../v3/probe.js';
import { PORT, bind, bootApp, releaseHttpServer, startServer, stopApp, switchHooksOn, useFakes } from '../app.js';
import type { AppFakes } from '../app.js';

/**
 * The kit's behaviour rules over the 3.0 http layer as N8c wires it (test/v3-app): the real AuthnMiddleware, routes,
 * N1 services and authn-session's DefaultSessionIssuer, with kit fakes for the ports other lanes own. One app and one
 * root container for every case: each case gets fresh fakes, its config applied with Configuration.set, every service
 * that read config or holds state uncached, and its own http server start.
 */

/** Config keys a case may set; any other key makes the factory throw UnsupportedConfig. */
export const SUPPORTED_CONFIG: readonly string[] = [
  'env',
  'authn.throttle',
  'authn.session.expiration.ttl',
  'authn.session.expiration.maxLifetime',
  'authn.session.pendingTtlSeconds',
  'authn.mfa.policy.force',
  'authn.freshAuth.maxAgeSeconds',
  'authn.impersonation',
  'authn.http.trustProxy',
  'authn.http.csrf',
  'authn.token.maxTtlDays',
  'authn.token.agentMaxTtlMinutes',
  'http.cors',
];

const ORIGIN = `http://127.0.0.1:${PORT}`;

// Only the modules the harness needs, loaded from the authn-token build rather than through its root.
const TOKEN_LIB = new URL('../../../../authn-token/lib/mjs/', import.meta.url);
const TOKEN_MODULES = ['generator.js', 'models/AccessToken.js', 'service/index.js', 'strategy/TokenStrategy.js', 'migrations/RbacHttpTokenInitial_2026_08_11_01_00_00.js', 'migrations/RbacHttpTokenProfile_2026_08_21_00_00_00.js', 'migrations/AuthnTokenScope_2026_10_02_00_00_00.js'];
const DB_CONNECTION = 'sqlite';

export const ROUTES: Partial<HttpRoutes> = {
  login: (login, password) => ({ method: 'POST', path: '/auth/login', body: { login, password } }),
  logout: () => ({ method: 'POST', path: '/auth/logout' }),
  whoami: () => ({ method: 'GET', path: '/auth' }),
  mfaVerify: (code) => ({ method: 'POST', path: '/auth/mfa/verify', body: { code } }),
  mfaRecovery: (code) => ({ method: 'POST', path: '/auth/mfa/recovery', body: { code } }),
  sessionsList: () => ({ method: 'GET', path: '/user/sessions' }),
  impersonateStart: (target, password) => ({ method: 'POST', path: '/auth/impersonate', body: { target: { type: target.type, id: target.id }, ...(password !== undefined ? { password } : {}) } }),
  impersonateStop: () => ({ method: 'DELETE', path: '/auth/impersonate' }),
  activeRoleSet: (role, password) => ({ method: 'POST', path: '/auth/active-role', body: { role, ...(password !== undefined ? { password } : {}) } }),
};

/** The ports every case's harness has; behaviour.test.ts compares the cases' needs with these. */
export const PORTS: readonly PortName[] = ['service', 'seed', 'sessions', 'throttle', 'events', 'spy', 'mfa', 'impersonation', 'guard', 'roles', 'attributed', 'principals', 'lifecycle', 'tokens', 'boot', 'http'];

interface CaseFakes extends AppFakes {
  attributedLogin: FakeStrategy;
  attributedRequest: FakeStrategy;
}

let kit: CaseFakes | null = null;

function kitFakes(): CaseFakes {
  if (!kit) throw new Error('no behaviour case is running');
  return kit;
}

// The kit's attributed credentials carry the identity to authenticate (AttributedPort), as in N1's core harness.
const attributedId = (c: Credentials): IdentityRef | undefined => (c as unknown as { id?: IdentityRef }).id;

const attributedStrategy = (name: string, interactive: boolean): FakeStrategy =>
  new FakeStrategy({
    name,
    kinds: [name],
    interactive,
    keys: (c, ctx) => [
      { kind: 'account', value: `attr:${attributedId(c)?.id}` },
      { kind: 'account-ip', value: `attr:${attributedId(c)?.id}|${ctx.ip ?? ''}` },
    ],
    verify: (c) => {
      const id = attributedId(c);
      return id ? { ok: true, identity: id, method: 'kit', attributes: KIT_ATTRIBUTES } : { ok: false, reason: 'invalid_credentials' };
    },
  });

export interface StrategyEntry {
  readonly name: string;
  readonly service: string;
}

export const STRATEGIES: readonly StrategyEntry[] = [
  { name: 'local', service: 'V3AppPasswordStrategy' },
  { name: 'kit-attributed-login', service: 'V3KitAttributedLogin' },
  { name: 'kit-attributed-request', service: 'V3KitAttributedRequest' },
  { name: 'token', service: 'TokenStrategy' },
];

function leafKeys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [prefix];
  return Object.entries(o).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

function leafValue(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o);
}

function checkSupported(config: ConfigOverrides, supported: readonly string[]): string[] {
  const leaves = leafKeys(config).filter((k) => k !== '');
  const unsupported = leaves.filter((k) => !supported.some((s) => k === s || k.startsWith(`${s}.`)));
  if (unsupported.length > 0) throw new UnsupportedConfig(unsupported);
  return leaves;
}

/** False where the factory would answer UnsupportedConfig, which makes the case pending; `lane`: a lane's own keys. */
export function supports(overrides: ConfigOverrides, lane: readonly string[] = []): boolean {
  try {
    checkSupported(overrides, [...SUPPORTED_CONFIG, ...lane]);
    return true;
  } catch (e) {
    if (e instanceof UnsupportedConfig) return false;
    throw e;
  }
}

const config = (): Configuration => DI.get(Configuration)!;

const ENV_PATH = 'process.env.APP_ENV';

/** The shallowest prefix of `path` that is not in the configuration; undefined when the whole path exists. */
function missingPrefix(c: Configuration, path: string): string | undefined {
  const parts = path.split('.');
  for (let i = 1; i <= parts.length; i++) {
    const parent = i === 1 ? undefined : c.get<unknown>(parts.slice(0, i - 1));
    const exists = i === 1 ? c.get(parts[0]) !== undefined : isObject(parent) && Object.hasOwn(parent, parts[i - 1]);
    if (!exists) return parts.slice(0, i).join('.');
  }
  return undefined;
}

function removeKey(c: Configuration, path: string): void {
  const dot = path.lastIndexOf('.');
  // Configuration has no unset; every top-level key a case touches is in the app config, so this branch stays unused.
  if (dot < 0) c.set(path, undefined);
  else delete c.get<Record<string, unknown>>(path.slice(0, dot))[path.slice(dot + 1)];
}

/**
 * Sets the case's keys (over the harness strategy list and the design §22.5 session expiry) and returns what undoes
 * it; undo removes what did not exist before. An env is named through APP_ENV as well, because the configuration
 * counts 'development' as a fallback unless some env source names it.
 */
function applyConfig(leaves: readonly string[], overrides: ConfigOverrides, strategies: readonly StrategyEntry[] = STRATEGIES): () => void {
  const c = config();
  const saved: { path: string; value: unknown; missing: string | undefined }[] = [];
  const set = (path: string, value: unknown) => {
    saved.push({ path, value: c.get(path), missing: missingPrefix(c, path) });
    c.set(path, value);
  };
  const savedAppEnv = process.env.APP_ENV;
  try {
    set('authn.strategies', strategies);
    set('authn.session.expiration.ttl', 30);
    set('authn.session.expiration.maxLifetime', 480);
    for (const path of leaves) {
      if (path === 'env') continue;
      set(path, leafValue(overrides, path));
    }
    if (overrides.env !== undefined) {
      set(ENV_PATH, overrides.env);
      process.env.APP_ENV = overrides.env;
    }
  } catch (e) {
    undo();
    throw e;
  }
  function undo(): void {
    for (const { path, value, missing } of saved.reverse()) {
      if (missing === undefined) c.set(path, value);
      else removeKey(c, missing);
    }
    if (savedAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = savedAppEnv;
  }
  return undo;
}

/**
 * Every service that read config or holds per-case state, so the next resolve builds it again from the case's config
 * and fakes. Factories (the fakes' registrations) are never cached.
 */
async function uncacheCaseServices(): Promise<void> {
  const authn = await import('@spinajs/authn');
  const bases: (Class<unknown> | (abstract new (...args: never[]) => unknown))[] = [
    AuthnService,
    SessionIssuer,
    SessionProvider,
    SessionExpirationProvider,
    AuthenticationStrategy,
    MfaStep,
    MfaPolicy,
    AuthnEventSink,
    AuthnThrottle,
    IdentityStore,
    PasswordCredentialStore,
    PrincipalFactory,
    RoleSource,
    ImpersonationGuard,
    AuthnResponseExtension,
    TokenService,
    CredentialExtractor,
    AuthnPrincipalResolver,
    ServerMiddleware,
  ];
  for (const base of bases) {
    for (const type of DI.getRegisteredTypes(base as Class<unknown>) ?? []) DI.uncache(type as Class<unknown>);
    DI.uncache(base as Class<unknown>);
  }
  for (const type of [authn.StrategyRegistry, authn.AuthnAudit, authn.FreshAuthCheck, authn.AuthnImpersonationService, authn.AccountLinkService]) DI.uncache(type as Class<unknown>);
}

function freshFakes(): CaseFakes {
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  return {
    identities,
    passwords,
    // Built from the case's config; MemoryAuthnThrottle reads authn.throttle on first use.
    throttle: undefined as unknown as AuthnThrottle,
    step: new FakeMfaStep({ name: 'totp' }),
    guard: new FakeImpersonationGuard(),
    roles: new FakeRoleSource(),
    principals: new RecordingPrincipalFactory(),
    passwordStrategy: FakeStrategy.password({ identities, passwords, name: 'local' }),
    tokenStrategy: FakeStrategy.bearer({ tokens: new Map(), name: 'token' }),
    events: new RecordingEventSink(),
    attributedLogin: attributedStrategy('kit-attributed-login', true),
    attributedRequest: attributedStrategy('kit-attributed-request', false),
  };
}

/** The harness database: sqlite in memory, also the Orm's 'default' connection. */
export function tokenDb(): OrmDriver {
  const connection = DI.get(Orm)?.Connections.get(DB_CONNECTION);
  if (!connection) throw new Error('the behaviour harness database is not booted');
  return connection;
}

/** A `users` row for the identity: authn-token's UsersTableTokenOwnerResolver maps token owners through that table. */
export async function insertUserRow(uuid: string): Promise<void> {
  await tokenDb()
    .insert()
    .into('users')
    .values({ Uuid: uuid, Email: `${uuid}@spinajs.test`, Password: 'not-a-hash', Login: uuid, Role: 'user', IsActive: 1 });
}

/** In-memory sqlite with authn-token's migrations and the columns of the users table it reads (no @spinajs/users). */
async function bootTokenDb(): Promise<void> {
  for (const file of TOKEN_MODULES) await import(new URL(file, TOKEN_LIB).href);
  // users' bootstrapper registers on import; the 2.x session store it brings shares no base with authn-session's.
  const users = (DI.getRegisteredTypes(Bootstrapper) ?? []).some((t) => t.name === 'RbacBootstrapper');
  const stores = DI.getRegisteredTypes(SessionProvider) ?? [];
  if (users || stores.length !== 1 || stores[0] !== MemorySessionStore) {
    throw new Error(`@spinajs/users is loaded (${users}) or another SessionProvider is registered (${stores.map((t) => t.name).join(', ')})`);
  }
  const c = config();
  c.set('db', {
    DefaultConnection: DB_CONNECTION,
    Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: DB_CONNECTION, Migration: { Table: 'orm_migrations', OnStartup: true } }],
  });
  await DI.resolve(Orm);
  await tokenDb()
    .schema()
    .createTable('users', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Uuid', 36).notNull();
      table.string('Email', 64).unique().notNull();
      table.string('Password', 128).notNull();
      table.string('Login', 64).notNull();
      table.string('Role', 256).notNull();
      table.boolean('IsActive').notNull().default().value(0);
      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('DeletedAt');
      table.dateTime('LastLoginAt');
    });
}

let booted = false;
let registered = false;

/**
 * Once per suite, before the first case (outside the kit's FakeClock). A later suite may boot again after
 * shutdownBehaviourApp, on a fresh database; `beforeDb` runs before the database boots, so the migrations it imports
 * run on startup.
 */
export async function bootBehaviourApp(opts: { beforeDb?: () => Promise<void> } = {}): Promise<void> {
  if (booted) return;
  await bootApp();
  await switchHooksOn();
  if (!registered) {
    registered = true;
    bind(AuthenticationStrategy, 'V3KitAttributedLogin', () => kitFakes().attributedLogin);
    bind(AuthenticationStrategy, 'V3KitAttributedRequest', () => kitFakes().attributedRequest);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  }
  await opts.beforeDb?.();
  await bootTokenDb();
  booted = true;
}

export async function shutdownBehaviourApp(): Promise<void> {
  await releaseHttpServer();
  useFakes();
  kit = null;
  await uncacheCaseServices();
  await DI.get(Orm)?.dispose();
  DI.uncache(Orm);
  await stopApp();
  booted = false;
}

function headerMap(raw: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name === 'set-cookie' || value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** One request on its own connection (no keep-alive), so stopping the server between cases never waits on a socket. */
function send(req: HttpRequest): Promise<HttpResponse> {
  const headers: Record<string, string> = { accept: 'application/json', connection: 'close' };
  for (const [name, value] of Object.entries(req.headers ?? {})) headers[name.toLowerCase()] = value;
  const cookies = Object.entries(req.cookies ?? {});
  if (cookies.length > 0) headers.cookie = cookies.map(([n, v]) => `${n}=${v}`).join('; ');
  let payload: Buffer | undefined;
  if (req.body !== undefined) {
    payload = Buffer.from(JSON.stringify(req.body));
    headers['content-type'] ??= 'application/json';
    headers['content-length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const json = /json/i.test(res.headers['content-type'] ?? '');
        let body: unknown = text === '' ? undefined : text;
        if (json && text !== '') {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        resolve({ status: res.statusCode ?? 0, headers: headerMap(res.headers), setCookie: res.headers['set-cookie'] ?? [], body });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

function sessionCookie(): string {
  const c = config();
  return sessionCookieName(c.get<ISessionCookieConfig>('authn.session.cookie', {}) ?? {}, appEnvOf(c));
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base: Record<string, unknown>, over: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

function isolatedConfiguration(values: Record<string, unknown>, env: string | undefined): Class<Configuration> {
  const json = JSON.stringify(values);
  return class BehaviourCheckConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      if (env !== undefined) this.Env = env;
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

const BOOT_SUPPORTED: readonly string[] = ['env', 'authn.http', 'http.cors', 'http.trustProxy'];
const strong = (): string => randomBytes(32).toString('hex');

/**
 * checkConfig: authn's checkAuthnConfig (what authn:check-config prints) over an isolated configuration built from the
 * spec, in a child container. Secrets the spec leaves out are strong; the pepper is off. No app boot: A24 is N1's.
 */
function bootPort(): BootPort {
  return {
    async start(): Promise<never> {
      throw new Error('the N8a http harness boots no app (A24 runs in N1)');
    },
    async checkConfig(spec: BootSpec) {
      if ((spec.strategies?.length ?? 0) > 0) throw new UnsupportedConfig(['boot.strategies']);
      if (spec.mfaStep === 'secret-storing') throw new UnsupportedConfig(['boot.mfaStep']);
      const given = spec.config ?? {};
      checkSupported(given, BOOT_SUPPORTED);
      const s = spec.secrets ?? {};
      const values = deepMerge(
        {
          http: { cookie: { secret: s.cookie === 'public' ? PUBLIC_DEFAULT_COOKIE_SECRET : s.cookie === 'missing' ? null : strong() } },
          authn: { strategies: [], local: { pepper: { secret: s.pepper === 'strong' ? strong() : null, version: 1 } }, mfa: { steps: [], encryptionKey: { secret: s.mfaKey === 'missing' ? null : strong() } } },
        },
        { ...(given.http ? { http: given.http } : {}), ...(given.authn ? { authn: given.authn } : {}) } as Record<string, unknown>,
      );
      const child: IContainer = DI.RootContainer.child();
      try {
        child.register(isolatedConfiguration(values, spec.env ?? given.env)).as(Configuration);
        await child.resolve(Configuration);
        const { checkAuthnConfig } = await import('@spinajs/authn');
        return await checkAuthnConfig(child);
      } finally {
        await child.dispose();
      }
    },
  };
}

/**
 * What a later lane puts over this harness (behaviour/n8b-harness.ts): its strategy list, config keys, route
 * builders and ports, around the same app, fakes and per-case steps.
 */
export interface HarnessLane {
  /** authn.strategies of every case, in place of STRATEGIES. */
  readonly strategies: readonly StrategyEntry[];
  /** Config keys the lane applies, over SUPPORTED_CONFIG. */
  readonly supportedConfig: readonly string[];
  /** Over ROUTES. */
  readonly routes: Partial<HttpRoutes>;
  /** Per case, after the case config, fakes and uncaching, before the server starts; may replace fakes. */
  open(ctx: HarnessContext, fakes: AppFakes): Promise<void>;
  /** The lane's ports over the N8a ones; a port set to undefined is removed. */
  ports(base: Harness, fakes: AppFakes): Promise<Partial<Harness>>;
  /** Per case, first on dispose, after a successful open. */
  close(): Promise<void>;
}

/** The lane's harness factory for runAuthnBehaviour; bootBehaviourApp must have run. */
export const httpHarness: HarnessFactory = (ctx) => buildHarness(ctx);

/** httpHarness with `lane` over it. */
export const laneHttpHarness =
  (lane: HarnessLane): HarnessFactory =>
  (ctx) =>
    buildHarness(ctx, lane);

async function buildHarness(ctx: HarnessContext, lane?: HarnessLane): Promise<Harness> {
  if (!booted) throw new Error('bootBehaviourApp() has not run');
  const leaves = checkSupported(ctx.config, lane ? [...SUPPORTED_CONFIG, ...lane.supportedConfig] : SUPPORTED_CONFIG);
  const undoConfig = applyConfig(leaves, ctx.config, lane?.strategies);
  const fakes = freshFakes();
  let started = false;
  let opened = false;
  const release = async () => {
    try {
      if (opened) await lane?.close();
    } finally {
      if (started) await releaseHttpServer();
      useFakes();
      kit = null;
      await uncacheCaseServices();
      undoConfig();
    }
  };
  try {
    const { MemoryAuthnThrottle, AuthnImpersonationService } = await import('@spinajs/authn');
    fakes.throttle = new MemoryAuthnThrottle();
    kit = fakes;
    useFakes(fakes);
    await uncacheCaseServices();
    await tokenDb().del().from('rbac_access_tokens');
    resetAuthnProbeHits();
    if (lane) {
      await lane.open(ctx, fakes);
      opened = true;
    }
    started = true;
    await startServer();

    const service = await DI.resolve(AuthnService);
    const sessions = await DI.resolve(SessionIssuer);
    const tokens = await DI.resolve(TokenService);
    const base = fakeSeedPort(fakes.identities, fakes.passwords);
    const impersonation = () => DI.resolve(AuthnImpersonationService);
    const endFor = async (id: IdentityRef) => {
      await (await impersonation()).endFor(id);
    };
    const http: HttpPort = { send, origin: ORIGIN, sessionCookie: sessionCookie(), socketAddress: '127.0.0.1', probePath: `/${AUTHN_PROBE_PATH}`, routes: lane ? { ...ROUTES, ...lane.routes } : ROUTES, volatileBodyFields: [] };

    const h: Harness = {
      service,
      seed: {
        // C1's users always have an email, and inline re-authentication names the identity by it (fresh-auth.ts).
        async user(spec) {
          const ref = await base.user({ ...spec, email: spec.email ?? spec.login });
          await insertUserRow(ref.id);
          return ref;
        },
        setStatus: (id, status) => base.setStatus(id, status),
      },
      sessions,
      throttle: { throttle: fakes.throttle, params: (fakes.throttle as InstanceType<typeof MemoryAuthnThrottle>).params },
      events: fakes.events,
      spy: { verifyCalls: () => [fakes.passwordStrategy, fakes.attributedLogin, fakes.attributedRequest].reduce((n, s) => n + s.verifyCalls.length, 0) },
      mfa: { step: fakes.step, enrol: async (id) => fakes.step.enrol(id), code: async (id) => fakes.step.nextCode(id) },
      impersonation: {
        start: async (session, target, ctx, reauth) => (await impersonation()).start(session, target, ctx, reauth),
        stop: async (session, ctx) => (await impersonation()).stop(session, ctx),
        principalOf: async (session, ctx) => (await impersonation()).principalOf(session, ctx),
      },
      guard: fakes.guard,
      roles: fakes.roles,
      attributed: { credentials: async (mode, id) => ({ kind: mode === 'interactive' ? 'kit-attributed-login' : 'kit-attributed-request', id }) as unknown as Credentials },
      principals: { calls: () => fakes.principals.calls },
      // What C1's ban and deactivate must do (N8a-D4): set the flag, then end every session of the identity, its
      // impersonations included. Without the call the next request through SessionPrincipalResolver ends them.
      lifecycle: {
        async ban(id) {
          fakes.identities.setStatus(id, { banned: true });
          await endFor(id);
        },
        async deactivate(id) {
          fakes.identities.setStatus(id, { active: false });
          await endFor(id);
        },
      },
      tokens,
      boot: bootPort(),
      http,
      dispose: release,
    };
    if (lane) {
      const over = await lane.ports(h, fakes);
      const out = { ...h, ...over } as Record<string, unknown>;
      for (const [name, port] of Object.entries(over)) if (port === undefined) delete out[name];
      return out as Harness;
    }
    const given = Object.keys(h).filter((k) => k !== 'dispose').sort();
    if (given.join() !== [...PORTS].sort().join()) throw new Error(`PORTS lists ${[...PORTS].sort().join()}, the harness has ${given.join()}`);
    return h;
  } catch (e) {
    await release();
    throw e;
  }
}
