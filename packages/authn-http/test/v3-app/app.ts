import chai from 'chai';
import chaiHttp from 'chai-http';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as cs from 'cookie-signature';
import { join, normalize, resolve } from 'node:path';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { BaseController, Controllers, HttpServer } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { MemoryTarget } from '@spinajs/log';
import { AuthenticationStrategy, AuthnEventSink, AuthnResponseExtension, AuthnThrottle, IdentityStore, ImpersonationGuard, PasswordCredentialStore, PrincipalFactory, RoleSource } from '@spinajs/authn/contracts';
import type { IdentityRef, Principal } from '@spinajs/authn/contracts';
import { appEnvOf, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { FakeIdentityStore, FakeImpersonationGuard, FakeMfaStep, FakeRoleSource, FakeStrategy, MemoryPasswordCredentialStore, RecordingEventSink, RecordingPrincipalFactory, RecordingThrottle, fakeHash } from '@spinajs/authn-testing';

import { registerAuthnHttpV3 } from '../../src/v3/register.js';
import { dropOwnCompiledDirs } from '../token-db-common.js';

chai.use(chaiHttp);

/**
 * The 3.0 account routes as N8c switches them on: registerAuthnHttpV3() on the root container, the 3.0 controllers
 * scanned instead of the 2.x account ones, kit fakes for the ports C1 and C3 supply. This mocha process loads neither
 * the package barrel nor @spinajs/users, so the 2.x middlewares are absent and authn-session's MemorySessionStore is
 * the only one registered.
 */

export const PORT = 8890;
export const APP_ORIGIN = `http://localhost:${PORT}`;
export const COOKIE_SECRET = 'v3-app-' + 'Zq8Lw2Rt'.repeat(6);

export const dir = (path: string) => resolve(normalize(join(process.cwd(), 'test', path)));

export class V3AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    dropOwnCompiledDirs(this);
  }

  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Memory', type: 'MemoryTarget', limit: 100000 }],
        rules: [{ name: '*', level: 'trace', target: 'Memory' }],
      },
      system: { dirs: { controllers: [dir('./../src/v3/controllers'), dir('./v3-app/support')] } },
      fs: { defaultProvider: 'fs-temp', providers: [{ service: 'fsNative', name: 'fs-temp', basePath: dir('./files') }] },
      http: {
        port: PORT,
        cookie: { secret: COOKIE_SECRET },
        middlewares: [express.json({ limit: '5mb' }), express.urlencoded({ extended: true }), cookieParser()],
        AcceptHeaders: 1,
      },
      authn: {
        // No authn.session.cookie: the shipped flags apply (SR-16).
        session: { service: 'MemorySessionStore', expiration: { service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 1440 }, pendingTtlSeconds: 300 },
        strategies: [
          { name: 'local', service: 'V3AppPasswordStrategy' },
          { name: 'token', service: 'V3AppTokenStrategy' },
        ],
        throttle: { service: 'V3AppThrottle' },
        mfa: { steps: [{ name: 'totp', service: 'V3AppMfaStep' }] },
        freshAuth: { maxAgeSeconds: 300 },
        impersonation: { requirePassword: true, requireMfa: true, maxMinutes: 60 },
      },
    };
  }
}

/** Adds `Access` to every answer it is asked to extend, and records the calls. */
export class V3AppResponseExtension extends AuthnResponseExtension {
  public static calls: { kind: string; principal: Principal }[] = [];

  public async extend(kind: 'login' | 'mfa' | 'role-switch' | 'impersonation' | 'whoami', principal: Principal, body: Record<string, unknown>): Promise<void> {
    V3AppResponseExtension.calls.push({ kind, principal });
    body.Access = { kind, id: principal.id, roles: principal.ceiling?.roles ?? null };
  }
}

export const identities = new FakeIdentityStore();
export const passwords = new MemoryPasswordCredentialStore();
export const throttle = new RecordingThrottle();
export const step = new FakeMfaStep({ name: 'totp' });
export const guard = new FakeImpersonationGuard();
export const roles = new FakeRoleSource();
export const principals = new RecordingPrincipalFactory();
export const passwordStrategy = FakeStrategy.password({ identities, passwords, name: 'local' });
export const tokens = new Map<string, IdentityRef>();
export const tokenStrategy = FakeStrategy.bearer({ tokens, name: 'token' });
export const events = new RecordingEventSink();

/** The instances the registrations below answer with; the behaviour harness swaps in a fresh set per case. */
export interface AppFakes {
  identities: FakeIdentityStore;
  passwords: MemoryPasswordCredentialStore;
  throttle: AuthnThrottle;
  step: FakeMfaStep;
  guard: FakeImpersonationGuard;
  roles: FakeRoleSource;
  principals: RecordingPrincipalFactory;
  passwordStrategy: FakeStrategy;
  tokenStrategy: FakeStrategy;
  events: RecordingEventSink;
}

const shared: AppFakes = { identities, passwords, throttle, step, guard, roles, principals, passwordStrategy, tokenStrategy, events };
let current: AppFakes = shared;

/** From now on the registrations answer with `fakes`; without an argument, with the shared ones the account suites use. */
export function useFakes(fakes: AppFakes = shared): void {
  current = fakes;
}

/** A named factory (registries look services up by the registration's name) answering with the current fake. */
export function bind(base: Class<unknown> | (abstract new (...args: never[]) => unknown), name: string, value: () => unknown): void {
  const factory = { [name]: () => value() }[name];
  DI.register(factory).as(base as Class<unknown>);
}

let wired = false;
let hooksOn = false;
const ENV_KEYS = ['NODE_ENV', 'APP_ENV'] as const;
const savedEnv: Record<string, string | undefined> = {};

async function wire(): Promise<void> {
  if (wired) return;
  wired = true;
  DI.setESMModuleSupport();
  DI.register(V3AppConfiguration).as(Configuration);
  bind(IdentityStore, 'V3AppIdentityStore', () => current.identities);
  bind(PasswordCredentialStore, 'V3AppPasswordStore', () => current.passwords);
  bind(PrincipalFactory, 'V3AppPrincipalFactory', () => current.principals);
  bind(AuthnThrottle, 'V3AppThrottle', () => current.throttle);
  // Before anything resolves AuthnAudit, which reads its sinks once.
  bind(AuthnEventSink, 'V3AppEventSink', () => current.events);
  bind(AuthenticationStrategy, 'V3AppPasswordStrategy', () => current.passwordStrategy);
  bind(AuthenticationStrategy, 'V3AppTokenStrategy', () => current.tokenStrategy);
  const { MfaStep } = await import('@spinajs/authn/contracts');
  bind(MfaStep, 'V3AppMfaStep', () => current.step);
  DI.register(V3AppResponseExtension).as(AuthnResponseExtension);
  await registerAuthnHttpV3();
}

/**
 * Registers RoleSource and ImpersonationGuard, which switch the role switch and impersonation route groups on. They
 * are never unregistered (DI.unregister under an abstract base leaves an empty key), so suites that need the groups off
 * run before this.
 */
export async function switchHooksOn(): Promise<void> {
  if (hooksOn) return;
  hooksOn = true;
  bind(RoleSource, 'V3AppRoleSource', () => current.roles);
  bind(ImpersonationGuard, 'V3AppImpersonationGuard', () => current.guard);
  // It reads the guard when it resolves, which a request with a session may have done already.
  const { AuthnImpersonationService } = await import('@spinajs/authn');
  DI.uncache(AuthnImpersonationService);
}

let booted = false;

/** Wires and boots the app (once per process) without any app env (SR-16), so every cookie gets the production flags. */
export async function bootApp(): Promise<void> {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  if (booted) return;
  booted = true;
  await wire();
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
}

export async function startServer(): Promise<void> {
  await DI.resolve(Controllers);
  await (await DI.resolve(HttpServer)).start();
}

export async function startApp(): Promise<void> {
  await bootApp();
  await startServer();
}

/** releaseHttpServer() of packages/http/test/common.ts, which imports http's sources and so cannot be shared. */
export async function releaseHttpServer(): Promise<void> {
  await DI.get(HttpServer)?.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  DI.uncache(BaseController);
}

export async function stopApp(): Promise<void> {
  await releaseHttpServer();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

export const config = (): Configuration => DI.get(Configuration)!;

export function cookieName(): string {
  const c = config();
  return sessionCookieName(c.get<ISessionCookieConfig>('authn.session.cookie', {}) ?? {}, appEnvOf(c));
}

export const logLines = (): string[] => (DI.get(MemoryTarget) as MemoryTarget | undefined)?.getRecords().map((r) => JSON.stringify(r)) ?? [];

export function clearLog(): void {
  (DI.get(MemoryTarget) as MemoryTarget | undefined)?.clear();
}

export interface Res {
  status: number;
  body: any;
  text: string;
  headers: Record<string, string | string[] | undefined>;
  setCookie: string[];
}

/** A browser on the app: keeps the session cookie between calls and sends the app's Origin on unsafe methods. */
export class Client {
  public cookie: string | null = null;

  constructor(cookie?: string) {
    this.cookie = cookie ?? null;
  }

  public get(path: string, headers: Record<string, string> = {}): Promise<Res> {
    return this.send('GET', path, undefined, headers);
  }

  public post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return this.send('POST', path, body, headers);
  }

  public del(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return this.send('DELETE', path, body, headers);
  }

  public patch(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return this.send('PATCH', path, body, headers);
  }

  public async send(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const agent = chai.request(APP_ORIGIN);
    let call = method === 'GET' ? agent.get(path) : method === 'POST' ? agent.post(path) : method === 'PATCH' ? agent.patch(path) : agent.delete(path);
    call = call.set('Accept', 'application/json');
    if (method !== 'GET') call = call.set('Origin', APP_ORIGIN);
    if (this.cookie !== null) call = call.set('Cookie', `${cookieName()}=${encodeURIComponent(this.cookie)}`);
    for (const [k, v] of Object.entries(headers)) call = call.set(k, v);
    const res = body === undefined ? await call : await call.send(body as object);
    const setCookie = ([] as string[]).concat(res.header['set-cookie'] ?? []);
    const mine = setCookie.find((c) => c.startsWith(`${cookieName()}=`));
    if (mine) {
      const value = decodeURIComponent(mine.split(';')[0].slice(cookieName().length + 1));
      this.cookie = value === '' ? null : value;
    }
    return { status: res.status, body: res.body, text: res.text, headers: res.header, setCookie };
  }

  /** The raw session id behind the signed cookie value. */
  public get sessionId(): string | null {
    if (this.cookie === null) return null;
    const id = cs.unsign(this.cookie, COOKIE_SECRET);
    return id === false ? null : id;
  }
}

/** The signed cookie value for a raw session id, as the server sets it. */
export const signed = (rawId: string): string => cs.sign(rawId, COOKIE_SECRET);

let users = 0;

export interface KitUser {
  ref: IdentityRef;
  login: string;
  password: string;
}

export async function seedUser(o: { status?: Parameters<FakeIdentityStore['add']>[0]['status']; email?: boolean } = {}): Promise<KitUser> {
  users++;
  const login = `user${users}-${Date.now()}@example.test`;
  const password = `Pass-${users}-word`;
  const ref = identities.add({ login, ...(o.email === false ? {} : { email: login }), ...(o.status ? { status: o.status } : {}) });
  await passwords.set(ref, fakeHash(password));
  return { ref, login, password };
}

/** Logs `u` in through POST /auth/login and returns the client holding the cookie. */
export async function loggedIn(u: KitUser): Promise<Client> {
  const c = new Client();
  const res = await c.post('/auth/login', { login: u.login, password: u.password });
  if (res.status !== 200 || c.cookie === null) throw new Error(`login answered ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}

/** Logs in an MFA-enrolled `u` and completes the step: an aal2 session. */
export async function loggedInAal2(u: KitUser): Promise<Client> {
  step.enrol(u.ref);
  const c = await loggedIn(u);
  const res = await c.post('/auth/mfa/verify', { code: step.nextCode(u.ref) });
  if (res.status !== 200) throw new Error(`mfa verify answered ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}

export function resetRecorders(): void {
  throttle.attempts.length = 0;
  throttle.succeeds.length = 0;
  passwordStrategy.verifyCalls.length = 0;
  V3AppResponseExtension.calls.length = 0;
  events.clear();
}

/** Parsed Set-Cookie of the session cookie: the value and the lower-cased attribute names and values. */
export function sessionSetCookie(res: Res): { value: string; attrs: Map<string, string> } | undefined {
  const raw = res.setCookie.find((c) => c.startsWith(`${cookieName()}=`));
  if (!raw) return undefined;
  const [pair, ...rest] = raw.split(';').map((p) => p.trim());
  const attrs = new Map<string, string>();
  for (const a of rest) {
    const i = a.indexOf('=');
    attrs.set((i < 0 ? a : a.slice(0, i)).toLowerCase(), i < 0 ? '' : a.slice(i + 1));
  }
  return { value: decodeURIComponent(pair.slice(pair.indexOf('=') + 1)), attrs };
}
