import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chai from 'chai';
import chaiHttp from 'chai-http';
import * as cs from 'cookie-signature';
import { v4 as uuidv4 } from 'uuid';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { fsService } from '@spinajs/fs';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { appEnvOf, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
// Loading it registers the 3.0 authn layer (AuthnMiddleware, resolvers, route args) on the root container, as in an app.
import '@spinajs/authn-http';
import { PrincipalMiddleware } from '@spinajs/authz-http';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User } from '@spinajs/users';

import { registerAuthzHost, seedRoles } from './authz-host.js';
// Registers the password strategy a suite lists in `authn.strategies` (REAUTH_STRATEGIES) for fresh auth with a password.
import './reauth-strategy.js';
import { WORLD_KEYS } from './owned-cache.js';

chai.use(chaiHttp);

// `@HandleException` puts http's error map straight into the root cache when the response classes load; the blanket
// DI.clearCache() of older suites in this process wipes it, and every 4xx then answers 500. Kept here to put it back.
const ERROR_MAP_KEY = '__http_error_map__';
const errorMap = new Map(DI.get<Map<string, Class<unknown>>>(ERROR_MAP_KEY) ?? []);

function restoreErrorMap(): void {
  if (errorMap.size === 0) throw new Error(`http-app: ${ERROR_MAP_KEY} was empty when the harness loaded`);
  const current = DI.get<Map<string, Class<unknown>>>(ERROR_MAP_KEY);
  for (const [name, response] of errorMap) {
    if (!current?.has(name)) DI.register(response).asMapValue(ERROR_MAP_KEY, name);
  }
}

const COOKIE_SECRET = 'users-http-app-' + 'Vb7Kq2Xr'.repeat(6);

export type RoleDefs = Record<string, unknown>;

export interface UsersHttpAppOptions {
  /** The only controllers the app mounts; no controller dir is scanned. */
  readonly controllers: readonly Class<BaseController>[];
  /** `authz.rbac.roles` of the app, built from the roles the installed packages ship; default: the shipped ones. */
  readonly roles?: (shipped: RoleDefs) => RoleDefs;
  /** Values set after the package defaults load (dotted path → value), e.g. `authz.http.services`. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Added to `authz.permissions` by name; a name may hold dots, which a `config` path cannot. */
  readonly permissions?: Readonly<Record<string, unknown>>;
}

let options: UsersHttpAppOptions | undefined;

/**
 * The package defaults of every installed @spinajs package (ESM mode), as an app loads them, with this test's
 * database, mail, queue and session values. `options` replaces the roles and adds values after the defaults merged:
 * arrays merge by concatenation, so a dir list or a role set cannot be narrowed from `onLoad`.
 */
class UsersHttpAppConfiguration extends FrameworkConfiguration {
  public async load(): Promise<void> {
    await super.load();

    const opts = options ?? { controllers: [] };
    const shipped = (this.get<RoleDefs>(['authz', 'rbac', 'roles']) ?? {}) as RoleDefs;
    if (opts.roles) this.set(['authz', 'rbac', 'roles'], opts.roles(shipped));

    this.set(['system', 'dirs', 'controllers'], []);
    this.set(['http', 'port'], 0);
    this.set(['http', 'cookie', 'secret'], COOKIE_SECRET);
    const providers = (this.get<{ name?: string }[]>(['fs', 'providers']) ?? []).filter((p) => p.name !== '__fs_controller_cache__');
    this.set(['fs', 'providers'], [...providers, { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(tmpdir(), 'spinajs-users-http-test-cache') }]);
    for (const [path, value] of Object.entries(opts.config ?? {})) this.set(path.split('.'), value);
    for (const [name, def] of Object.entries(opts.permissions ?? {})) this.set(['authz', 'permissions', name], def);
  }

  protected onLoad(): unknown {
    const mail = (template: string) => ({ enabled: false, template, subject: template });
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      users: {
        email: {
          connection: 'users-http-app-email',
          created: mail('./user-creation-email-template.pug'),
          changePassword: mail('./user-change-password-template.pug'),
          activated: mail('./user-activated-email-template.pug'),
          deactivated: mail('./user-deactivated-email-template.pug'),
          deleted: mail('./user-deleted-email-template.pug'),
          banned: mail('./user-banned-email-template.pug'),
          unbanned: mail('./user-unbanned-email-template.pug'),
          passwordExpired: mail('./user-password-expired-template.pug'),
          passwordWillExpire: mail('./user-password-will-expire-soon.pug'),
        },
      },
      authz: {
        // AuthzAdmin checks it for every assignment command, the SYSTEM seeds included; no shipped fragment declares it.
        permissions: { 'authz:assignments.manage': {} },
        admin: {
          backend: 'DbAuthzAdminBackend',
          connection: 'default',
        },
      },
      authn: {
        session: {
          service: 'MemorySessionStore',
          expiration: { service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 1440 },
        },
      },
      email: { connections: [{ name: 'users-http-app-email', service: 'BlackHoleEmailSender' }] },
      queue: { default: 'users-http-app-queue', connections: [{ service: 'BlackHoleQueueClient', name: 'users-http-app-queue' }] },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { Table: 'orm_migrations', OnStartup: true, Transaction: { Mode: MigrationTransactionMode.PerMigration } },
          },
        ],
      },
    };
  }
}

// What the app resolves into the root cache; uncached by key before it boots and when it stops, never DI.clearCache().

let running: { server: HttpServer; controllers: Class<BaseController>[]; port: number } | undefined;

export interface Res {
  readonly status: number;
  readonly body: any;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A client of the running app; with a session, it sends that session's cookie. */
export class HttpClient {
  constructor(
    protected readonly port: number,
    public readonly session: SessionHandle | null = null,
  ) {}

  public get(path: string, headers: Record<string, string> = {}): Promise<Res> {
    return this.send('GET', path, undefined, headers);
  }

  public patch(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return this.send('PATCH', path, body, headers);
  }

  public post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return this.send('POST', path, body, headers);
  }

  public del(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return this.send('DELETE', path, body, headers);
  }

  public async send(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const origin = `http://127.0.0.1:${this.port}`;
    const agent = chai.request(origin);
    let call = method === 'GET' ? agent.get(path) : method === 'POST' ? agent.post(path) : method === 'PATCH' ? agent.patch(path) : agent.delete(path);
    call = call.set('Accept', 'application/json');
    // The CSRF guard refuses an unsafe request from another origin; a client of the app sends its own.
    if (method !== 'GET') call = call.set('Origin', origin);
    if (this.session) call = call.set('Cookie', `${cookieName()}=${encodeURIComponent(cs.sign(this.session.id, COOKIE_SECRET))}`);
    for (const [k, v] of Object.entries(headers)) call = call.set(k, v);
    const res = body === undefined ? await call : await call.send(body as object);
    return { status: res.status, body: res.body, text: res.text, headers: res.headers as Record<string, string> };
  }
}

export interface UsersHttpApp {
  readonly port: number;
  /** No cookie, no credentials. */
  anonymous(): HttpClient;
  /** Issues a real session for user `uuid` through the app's SessionIssuer and returns a client sending its cookie. */
  signIn(uuid: string, facts?: Partial<AuthnFacts>): Promise<HttpClient>;
  /** Inserts an active user (or as `spec` says) and grants it `roles` at GLOBAL. */
  seedUser(spec?: SeedUser): Promise<User>;
}

export interface SeedUser {
  readonly login?: string;
  readonly email?: string;
  readonly active?: boolean;
  readonly roles?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

let seq = 0;

function cookieName(): string {
  const config = DI.get(Configuration)!;
  return sessionCookieName(config.get<ISessionCookieConfig>('authn.session.cookie', {}) ?? {}, appEnvOf(config));
}

function release(): void {
  for (const key of WORLD_KEYS) DI.RootContainer.uncache(key);
}

/**
 * Boots an http server on a free port with the stack a users-http app runs: authn-http's AuthnMiddleware (session
 * cookie → `req.storage.AuthnPrincipal`), authz-http's PrincipalMiddleware and AccessPolicy, users' factories,
 * adapters and relations, a real root authz host on a fresh in-memory SQLite database (`authz-host.ts`), and only
 * `opts.controllers`. Pair with {@link stopUsersHttpApp} in `after()`.
 */
export async function startUsersHttpApp(opts: UsersHttpAppOptions): Promise<UsersHttpApp> {
  if (running) throw new Error('startUsersHttpApp: an app is already running; call stopUsersHttpApp() first');
  options = opts;

  DI.setESMModuleSupport();
  DI.register(UsersHttpAppConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  DI.register(BasicPasswordProvider).as(PasswordProvider);
  DI.register(SimpleDbAuthProvider).as(AuthProvider);
  registerAuthzHost();
  release();
  restoreErrorMap();

  for (const b of (await DI.resolve(Array.ofType(Bootstrapper))) as Bootstrapper[]) {
    await b.bootstrap();
  }
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Orm);

  const before = new Set(DI.getRegisteredTypes(BaseController) ?? []);
  for (const c of opts.controllers) DI.register(c).as(BaseController);

  await DI.resolve(Controllers);
  const server = (await DI.resolve(HttpServer)) as HttpServer;
  await server.start();

  const port = (server.Server.address() as AddressInfo).port;
  // Also what http registered itself, so no controller outlives this app.
  running = { server, port, controllers: [...new Set(DI.getRegisteredTypes(BaseController) ?? [])].filter((t) => !before.has(t)) as Class<BaseController>[] };

  return {
    port,
    anonymous: () => new HttpClient(port),
    signIn: async (uuid, facts) => {
      const sessions = (await DI.resolve(SessionIssuer)) as SessionIssuer;
      const identity: IdentityRef = { type: 'user', id: uuid };
      const handle = await sessions.issue(identity, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), ...facts });
      return new HttpClient(port, handle);
    },
    seedUser: async (spec = {}) => {
      const login = spec.login ?? `user-${++seq}`;
      const user = new User({ Uuid: uuidv4(), Email: spec.email ?? `${login}@spinajs.test`, Login: login, Password: 'not-a-hash', IsActive: spec.active ?? true });
      await user.insert();
      if (spec.metadata) {
        for (const [key, value] of Object.entries(spec.metadata)) user.Metadata[key] = value;
        await user.Metadata.sync();
      }
      if (spec.roles?.length) await seedRoles(user.Uuid, spec.roles);
      return user;
    },
  };
}

/** Stops the server and removes what {@link startUsersHttpApp} registered and resolved. */
export async function stopUsersHttpApp(): Promise<void> {
  options = undefined;
  if (!running) return;
  const { server, controllers } = running;
  running = undefined;

  await server.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  for (const c of controllers) DI.unregister(c);
  DI.uncache(BaseController);
  // Middlewares keep what they resolved at boot (PrincipalMiddleware: the root AuthzService).
  await DI.get(PrincipalMiddleware)?.dispose();
  for (const type of DI.getRegisteredTypes(ServerMiddleware) ?? []) DI.uncache(type as Class<ServerMiddleware>);
  DI.uncache(ServerMiddleware);
  // Sibling suites register their own Configuration; DI hands out the last registration.
  DI.unregister(UsersHttpAppConfiguration);
  release();
}
