import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';

import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { AuthorizationModel, AuthzContributor, AuthzService, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand } from '@spinajs/authz';
import { AdminAssignmentStore, AssignmentStore, ConfigRoleStore, DbAssignmentStore, RbacContributor, RbacModel, RbacService, RoleStore } from '@spinajs/authz-rbac';
import { AccessController, PrincipalMiddleware } from '@spinajs/authz-http';
import { MfaStep, PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { PasswordHasher } from '@spinajs/authn-local';
import { appEnvOf, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { FakeMfaStep } from '@spinajs/authn-testing';
import type { HttpPort, HttpRequest, HttpResponse, HttpRoutes } from '@spinajs/authn-testing';
import { testHost } from '@spinajs/authz-testing';

// authn-http's package barrel still carries 2.x code that imports @spinajs/users from its lib, a second copy beside
// the users sources this process tests; its 3.0 layer and controllers import neither, so they are loaded from the lib
// by path. Loading the layer registers it on the root container (registerAuthnHttpV3).
import '../../../authn-http/lib/mjs/v3/index.js';
import { AuthnActiveRoleController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnActiveRoleController.js';
import { AuthnImpersonationController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnImpersonationController.js';
import { AuthnLoginController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnLoginController.js';
import { AuthnMfaController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnMfaController.js';
import { AuthnSessionsController } from '../../../authn-http/lib/mjs/v3/controllers/AuthnSessionsController.js';

import { NO_PASSWORD, User } from '../../src/index.js';
import { TestConfiguration } from '../common.test.js';
import { PROBE_PATH, UsersHttpProbeController, resetProbeHits } from './AuthnProbeController.js';

/**
 * One real http app per mocha process for users' http suites (test/http, .mocharc.http.json): authn-http's 3.0 layer and
 * controllers, authn's services, authn-session's issuer over its memory store, authn-local's password strategy, and
 * users' own hooks (RoleSource, ImpersonationGuard, AuthnResponseExtension, PrincipalFactory, identity and password
 * stores) over the users sqlite test database; the kit's FakeMfaStep; authz-http's PrincipalMiddleware, which takes
 * authn's principal through AuthnPrincipalSource, and GET /user/access; a probe route.
 *
 * It runs over testHost's TestConfiguration, so authz-testing's hostHarness can share it: the configuration is seeded
 * once from a schema-checked FrameworkConfiguration (package defaults, users' test values, the app values below) and
 * every later write goes through a ConfigScope that a case undoes.
 */

export const COOKIE_SECRET = 'users-http-' + 'Hq7Kd3Wz'.repeat(6);

const MFA_STEP_SERVICE = 'UsersHttpMfaStep';

const usersDir = (...path: string[]) => resolve(normalize(join(process.cwd(), ...path)));

const APP_VALUES = {
  http: { cookie: { secret: COOKIE_SECRET } },
  authn: {
    strategies: [{ name: 'local', service: 'LocalPasswordStrategy' }],
    mfa: { steps: [{ name: 'totp', service: MFA_STEP_SERVICE }] },
  },
};

class UsersHttpSeedConfiguration extends TestConfiguration {
  protected onLoad(): unknown {
    return _.merge({}, super.onLoad(), APP_VALUES);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// Plain objects and arrays are copied; functions (middlewares) and class instances are kept.
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.keys(value).map((k) => [k, plain(value[k])]));
  return value;
}

/** The values of a schema-checked FrameworkConfiguration, resolved in a child container that is disposed after. */
async function seededValues(): Promise<Record<string, unknown>> {
  const child = DI.RootContainer.child();
  try {
    child.register(UsersHttpSeedConfiguration).as(Configuration);
    const cfg = (await child.resolve(Configuration)) as Configuration;
    return plain(cfg.RootConfig) as Record<string, unknown>;
  } finally {
    await child.dispose();
  }
}

/** Config writes undone in reverse order; parents a write created are removed when left empty. */
export class ConfigScope {
  private readonly undo: (() => void)[] = [];

  public set(path: readonly string[], value: unknown): void {
    const cfg = testHost.config();
    const created: string[][] = [];
    for (let i = 1; i < path.length; i++) {
      if (cfg.get(path.slice(0, i)) === undefined) created.push(path.slice(0, i));
    }
    const before = cfg.get<unknown>([...path]);
    cfg.set([...path], value);
    this.undo.push(() => {
      if (before !== undefined) cfg.set([...path], before);
      else cfg.unset(path);
      for (const p of created.reverse()) {
        const v = cfg.get<unknown>(p);
        if (isRecord(v) && Object.keys(v).length === 0) cfg.unset(p);
      }
    });
  }

  public restore(): void {
    for (const fn of this.undo.splice(0).reverse()) fn();
  }
}

let mfaStep = new FakeMfaStep({ name: 'totp' });

/** From now on the app's MFA step `totp` is `step` (a fresh one when omitted). */
export function useMfaStep(step: FakeMfaStep = new FakeMfaStep({ name: 'totp' })): FakeMfaStep {
  mfaStep = step;
  return step;
}

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

const CONTROLLERS: Class<BaseController>[] = [AuthnLoginController, AuthnMfaController, AuthnSessionsController, AuthnActiveRoleController, AuthnImpersonationController, AccessController, UsersHttpProbeController] as unknown as Class<BaseController>[];

export interface UsersHttpApp {
  readonly origin: string;
  readonly port: number;
  /** One request on its own connection, so stopping the server never waits on a socket. */
  send(req: HttpRequest): Promise<HttpResponse>;
  /** The kit's HttpPort over this app (session cookie name read now). */
  httpPort(): HttpPort;
}

export interface StartOptions {
  /** Root registrations that must exist before the root authz domain boots (it boots once the server listens). */
  register?(): void;
}

let app: { server: HttpServer; port: number; controllers: Class<BaseController>[] } | undefined;
const rootUndo: (() => void)[] = [];

function headerMap(raw: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name === 'set-cookie' || value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function send(port: number, req: HttpRequest): Promise<HttpResponse> {
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
  return new Promise((done, fail) => {
    const r = request({ host: '127.0.0.1', port, method: req.method, path: req.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', fail);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text === '' ? undefined : text;
        if (text !== '' && /json/i.test(res.headers['content-type'] ?? '')) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        done({ status: res.statusCode ?? 0, headers: headerMap(res.headers), setCookie: res.headers['set-cookie'] ?? [], body });
      });
    });
    r.on('error', fail);
    r.end(payload);
  });
}

function sessionCookie(): string {
  const cfg = testHost.config();
  return sessionCookieName(cfg.get<ISessionCookieConfig>('authn.session.cookie', {}) ?? {}, appEnvOf(cfg));
}

function handle(port: number): UsersHttpApp {
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    port,
    send: (req) => send(port, req),
    httpPort: () => ({ send: (req) => send(port, req), origin, sessionCookie: sessionCookie(), socketAddress: '127.0.0.1', probePath: `/${PROBE_PATH}`, routes: ROUTES, volatileBodyFields: [] }),
  };
}

/** The running app; throws before `startUsersHttpApp()`. */
export function usersHttpApp(): UsersHttpApp {
  if (!app) throw new Error('the users http app is not started: call startUsersHttpApp() in a before hook');
  return handle(app.port);
}

/**
 * Boots the app once per process on a free port: bootstrappers, the seeded TestConfiguration (testHost.installHost), the
 * users test database (users' and authz-rbac's migrations), the controllers, the server. Pair with stopUsersHttpApp().
 */
export async function startUsersHttpApp(opts: StartOptions = {}): Promise<UsersHttpApp> {
  if (app) throw new Error('startUsersHttpApp: the app is already running; call stopUsersHttpApp() first');

  // Config sources pick lib/mjs over lib/cjs on their first resolve: a lib/cjs file would load a CommonJS copy of DI.
  DI.setESMModuleSupport();
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  rootUndo.push(testHost.registerInRoot(MfaStep as unknown as Class<MfaStep>, { [MFA_STEP_SERVICE]: () => mfaStep }[MFA_STEP_SERVICE]));

  for (const b of (await DI.resolve(Array.ofType(Bootstrapper))) as Bootstrapper[]) await b.bootstrap();
  const seeded = await seededValues();

  const cfg = await testHost.installHost();
  cfg.set([], seeded);
  cfg.set(['http', 'port'], 0);
  // Package defaults list the controller dirs of every installed package; this app registers its own.
  cfg.set(['system', 'dirs', 'controllers'], []);
  // Configured, the scan replaces its defaults, which include users' lib/mjs build: a second copy of users' models.
  cfg.set(['system', 'dirs', 'migrations'], [usersDir('src', 'migrations')]);
  cfg.set(['fs', 'providers'], [...(cfg.get<{ name?: string }[]>(['fs', 'providers']) ?? []).filter((p) => p.name !== '__fs_controller_cache__'), { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(tmpdir(), 'spinajs-users-http-test-cache') }, { service: 'fsNative', name: 'users-http-test', basePath: join(tmpdir(), 'spinajs-users-http-test') }]);
  cfg.set(['fs', 'defaultProvider'], 'users-http-test');

  opts.register?.();
  await DI.resolve(fsService);
  await DI.resolve(Orm);

  const before = new Set(DI.getRegisteredTypes(BaseController) ?? []);
  for (const c of CONTROLLERS) DI.register(c).as(BaseController);
  await DI.resolve(Controllers);
  const server = (await DI.resolve(HttpServer)) as HttpServer;
  await server.start();
  resetProbeHits();

  const port = (server.Server.address() as AddressInfo).port;
  app = { server, port, controllers: [...new Set(DI.getRegisteredTypes(BaseController) ?? [])].filter((t) => !before.has(t)) as Class<BaseController>[] };
  return handle(port);
}

/** Stops the server, disposes the database and the root authz domain, and removes what startUsersHttpApp added. */
export async function stopUsersHttpApp(): Promise<void> {
  if (!app) return;
  const { server, controllers } = app;
  app = undefined;

  await server.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  for (const c of controllers) DI.unregister(c);
  DI.uncache(BaseController);
  await DI.get(PrincipalMiddleware)?.dispose();
  for (const type of DI.getRegisteredTypes(ServerMiddleware) ?? []) DI.uncache(type as Class<ServerMiddleware>);
  DI.uncache(ServerMiddleware);
  await DI.get(Orm)?.dispose();
  DI.uncache(Orm);
  for (const undo of rootUndo.splice(0)) undo();
  await testHost.uninstallHost();
}

let rootModel: RbacModel | undefined;

/**
 * A root authz host over the users test database: roles from `authz.rbac.roles`, assignments in `authz_assignment`,
 * AuthzAdmin on users' DbAuthzAdminBackend, RbacService over the model. Pass it as `register` to startUsersHttpApp;
 * stopUsersHttpApp removes it. A hostHarness suite registers its models in the test domain instead.
 */
export function registerRootRbac(): void {
  rootModel = undefined;
  const model = (c: IContainer): RbacModel => (rootModel ??= new RbacModel({ roles: c.resolve(RoleStore) as RoleStore, assignments: c.resolve(AssignmentStore) as AssignmentStore }));
  rootUndo.push(
    testHost.registerInRoot(RoleStore, ConfigRoleStore),
    testHost.registerInRoot(AssignmentStore, DbAssignmentStore),
    testHost.registerInRoot(AdminAssignmentStore, DbAssignmentStore),
    testHost.registerInRoot(AuthorizationModel, (c: IContainer) => model(c)),
    testHost.registerInRoot(AuthzContributor, (c: IContainer) => new RbacContributor(model(c))),
    testHost.registerInRoot(RbacService, (c: IContainer) => new RbacService(model(c))),
    () => {
      rootModel = undefined;
      for (const t of [ConfigRoleStore, DbAssignmentStore] as Class<unknown>[]) DI.uncache(t);
    },
  );
}

/** The root RbacModel of registerRootRbac; undefined until the root domain builds it. */
export function rootRbacModel(): RbacModel | undefined {
  return rootModel;
}

/** GLOBAL assignments through the root AuthzAdmin, as SYSTEM. */
export async function grantGlobal(subject: IdentityRef, roles: readonly string[]): Promise<void> {
  const admin = ((await DI.resolve(AuthzService)) as AuthzService).admin();
  const commands: AuthzCommand[] = roles.map((role) => ({ kind: 'assignment.grant', subject: { type: subject.type, id: subject.id }, role, scope: GLOBAL }));
  const results = await admin.execute(SYSTEM, commands, { reason: 'users http test' });
  if (!results.every((r) => r.ok)) throw new Error(`grant ${roles.join(', ')} to ${subject.id} failed: ${JSON.stringify(results)}`);
}

export interface AccountSpec {
  readonly login: string;
  /** Default: the login. */
  readonly email?: string;
  readonly password?: string;
  /** The users row's Uuid, so a world principal `user:<id>` names this row; default a fresh uuid. */
  readonly uuid?: string;
  readonly active?: boolean;
}

/** A users row, its password hashed by authn-local's hasher into users' password store. */
export async function seedAccount(spec: AccountSpec): Promise<IdentityRef> {
  const uuid = spec.uuid ?? uuidv4();
  await new User({ Email: spec.email ?? spec.login, Login: spec.login, Password: NO_PASSWORD, IsActive: spec.active ?? true, Uuid: uuid }).insert();
  const ref: IdentityRef = { type: 'user', id: uuid };
  if (spec.password !== undefined) {
    const hash = await ((await DI.resolve(PasswordHasher)) as PasswordHasher).hash(spec.password);
    await ((await DI.resolve(PasswordCredentialStore)) as PasswordCredentialStore).set(ref, hash);
  }
  return ref;
}

/** Deletes the users rows, their metadata and their assignments, so a later case can seed the same login. */
export async function removeAccounts(refs: readonly IdentityRef[]): Promise<void> {
  const ids = refs.map((r) => r.id);
  if (ids.length === 0) return;
  const driver = User.query().Driver;
  const rows = (await driver.select().from('users').columns(['Id']).whereIn('Uuid', ids)) as { Id: number }[];
  if (rows.length > 0)
    await driver
      .del()
      .from('users_metadata')
      .whereIn(
        'user_id',
        rows.map((r) => r.Id),
      );
  await driver.del().from('users').whereIn('Uuid', ids);
  await driver.del().from('authz_assignment').where('subject_type', 'user').whereIn('subject_id', ids);
}
