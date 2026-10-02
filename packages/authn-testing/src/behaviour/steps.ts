import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import type { AuthenticationResult, AuthnEventType, AuthnFacts, Credentials, IdentityRef, IdentityStatus, ThrottleKey } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE } from '../harness/config.js';
import type { ConfigOverrides } from '../harness/config.js';
import type { HttpPort, HttpRequest, HttpResponse, HttpRoutes } from '../harness/http.js';
import type { BackoffParams, EventsPort, FlowParams, Harness, ThrottleParams } from '../harness/ports.js';
import { CookieJar, parseSetCookie } from '../helpers/cookies.js';
import type { SetCookie } from '../helpers/cookies.js';
import type { CaseKit } from './types.js';

export interface KitUser {
  readonly login: string;
  readonly password: string;
}

export const ALICE: KitUser = Object.freeze({ login: 'alice@example.test', password: 'Alice-Pass-1234' });
export const BOB: KitUser = Object.freeze({ login: 'bob@example.test', password: 'Bob-Pass-2345x' });
export const CAROL: KitUser = Object.freeze({ login: 'carol@example.test', password: 'Carol-Pass-3456' });
export const DAVE: KitUser = Object.freeze({ login: 'dave@example.test', password: 'Dave-Pass-4567x' });
export const NOBODY = 'nobody@example.test';
export const WRONG = 'Wrong-Pass-9876';
export const NEW_PW = 'New-Pass-5678x';
export const IP_A = '192.0.2.10';
export const IP_B = '192.0.2.20';
export const SPOOF_IP = '203.0.113.66';
export const attackerIp = (i: number): string => `198.18.${(i >> 8) & 255}.${i & 255}`;
export const ORIGIN_EVIL = 'https://evil.example.net';
export const ORIGIN_PARTNER = 'https://partner.example.org';
export const KIT_ATTRIBUTES: Readonly<Record<string, unknown>> = Object.freeze({ profile: 'kit-p' });

type StatusFlags = Partial<Omit<IdentityStatus, 'exists'>>;
type Failure = Extract<AuthenticationResult, { status: 'failure' }>;

export const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password });

export const pwKeys = (login: string, ip: string): ThrottleKey[] => [
  { kind: 'account', value: login },
  { kind: 'account-ip', value: `${login}|${ip}` },
  { kind: 'ip', value: ip },
];

/** `h.service.authenticate(c, k.ctx(over))`. */
export const auth = (h: Harness, k: CaseKit, c: Credentials, over?: Parameters<CaseKit['ctx']>[0]): Promise<AuthenticationResult> => h.service!.authenticate(c, k.ctx(over));

/** Seeds the user with its password (and status flags); returns the IdentityRef. */
export const seedUser = (h: Harness, u: KitUser, status?: StatusFlags): Promise<IdentityRef> => h.seed!.user({ login: u.login, password: u.password, ...(status ? { status } : {}) });

export const factsAal1 = (k: CaseKit): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: k.clock.now() });

/** F(r): a failure with that reason and no retryAfterSeconds. */
export const isFailure = (res: AuthenticationResult, reason: string): boolean => res.status === 'failure' && res.reason === reason && (res as Failure).retryAfterSeconds === undefined;

/** T(s): the throttled failure with exactly that Retry-After. */
export const isThrottled = (res: AuthenticationResult, s: number): boolean => isDeepStrictEqual({ ...res }, { status: 'failure', reason: 'throttled', retryAfterSeconds: s });

export function expectFailure(res: AuthenticationResult, reason: string, msg?: string): void {
  assert.deepStrictEqual({ status: res.status, reason: (res as Failure).reason }, { status: 'failure', reason }, msg);
  assert.strictEqual((res as Failure).retryAfterSeconds, undefined, msg ?? 'only a throttled failure carries retryAfterSeconds');
}

export function expectThrottled(res: AuthenticationResult, s: number, msg?: string): void {
  assert.deepStrictEqual({ ...res }, { status: 'failure', reason: 'throttled', retryAfterSeconds: s }, msg);
}

export function expectSuccess(res: AuthenticationResult, msg?: string): asserts res is Extract<AuthenticationResult, { status: 'success' }> {
  assert.strictEqual(res.status, 'success', msg ?? `result ${JSON.stringify(res)}`);
}

export function expectMfaRequired(res: AuthenticationResult, msg?: string): asserts res is Extract<AuthenticationResult, { status: 'mfa_required' }> {
  assert.strictEqual(res.status, 'mfa_required', msg ?? `result ${JSON.stringify(res)}`);
}

/** FAIL: status 'failure', reason not asserted. */
export function expectFail(res: AuthenticationResult, msg?: string): void {
  assert.strictEqual(res.status, 'failure', msg);
}

/** FAIL_OR_REJECT: the promise rejects, or resolves to a result that is not a success. */
export async function expectFailOrReject(p: Promise<AuthenticationResult>, msg?: string): Promise<void> {
  let res: AuthenticationResult;
  try {
    res = await p;
  } catch {
    return;
  }
  assert.notStrictEqual(res.status, 'success', msg ?? 'expected a failure or a rejection');
}

export function expectAllowed(r: { allowed: boolean }, msg?: string): void {
  assert.deepStrictEqual({ ...r }, { allowed: true }, msg);
}

export function expectRefused(r: { allowed: boolean }, retryAfterSeconds: number, msg?: string): void {
  assert.deepStrictEqual({ ...r }, { allowed: false, retryAfterSeconds }, msg);
}

/** ev(type, outcome?): the events port holds an event of that type (and outcome). */
export const hasEvent = (events: EventsPort, type: AuthnEventType, outcome?: 'success' | 'failure'): boolean => events.all().some((e) => e.type === type && (outcome === undefined || e.outcome === outcome));

const mergeBackoff = (base: BackoffParams | undefined, over: Partial<BackoffParams> | undefined): BackoffParams | undefined => (over ? ({ ...base, ...over } as BackoffParams) : base);

const mergeFlow = (base: FlowParams, over: { account?: Partial<BackoffParams>; ip?: Partial<BackoffParams> } | undefined): FlowParams => {
  if (!over) {
    return base;
  }
  const out: { account?: BackoffParams; ip?: BackoffParams } = {};
  const account = mergeBackoff(base.account, over.account);
  const ip = mergeBackoff(base.ip, over.ip);
  if (account) out.account = account;
  if (ip) out.ip = ip;
  return out;
};

/** `authn.throttle` overrides merged over DEFAULT_THROTTLE, per flow and key (what ThrottlePort.params reports). */
export function throttleParams(config: ConfigOverrides = {}): ThrottleParams {
  const o = config.authn?.throttle;
  if (!o) {
    return DEFAULT_THROTTLE;
  }
  return {
    login: mergeFlow(DEFAULT_THROTTLE.login, o.login),
    mfa: mergeFlow(DEFAULT_THROTTLE.mfa, o.mfa),
    reset: mergeFlow(DEFAULT_THROTTLE.reset, o.reset),
    reauth: mergeFlow(DEFAULT_THROTTLE.reauth, o.reauth),
    resetAfterSeconds: o.resetAfterSeconds ?? DEFAULT_THROTTLE.resetAfterSeconds,
    global: o.global === undefined ? DEFAULT_THROTTLE.global : (o.global as BackoffParams | null),
  };
}

// HTTP

type WithHttp = Pick<Required<Harness>, 'http'>;

/** The route builders; a case lists the ones it uses in `needs`. */
export const routes = (h: WithHttp): HttpRoutes => h.http.routes as HttpRoutes;

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Adds the app's own Origin to unsafe requests that carry neither Origin nor Sec-Fetch-Site (a browser on the app's page). */
export function withOrigin(http: HttpPort, req: HttpRequest): HttpRequest {
  if (SAFE.has(req.method)) {
    return req;
  }
  const names = Object.keys(req.headers ?? {}).map((n) => n.toLowerCase());
  if (names.includes('origin') || names.includes('sec-fetch-site')) {
    return req;
  }
  return { ...req, headers: { ...req.headers, origin: http.origin } };
}

/** send(R, jar): Origin added as a browser would, cookies from and into the jar (a fresh jar when omitted). */
export async function send(h: WithHttp, req: HttpRequest, jar: CookieJar = new CookieJar()): Promise<HttpResponse> {
  return jar.store(await h.http.send(jar.apply(withOrigin(h.http, req))));
}

/** No header added: only A22 and A31 use it. */
export async function sendRaw(h: WithHttp, req: HttpRequest, jar: CookieJar = new CookieJar()): Promise<HttpResponse> {
  return jar.store(await h.http.send(jar.apply(req)));
}

export const probe = (h: WithHttp, method: HttpRequest['method']): HttpRequest => ({ method, path: h.http.probePath });

/** in4xx: 401 or 403. */
export const in4xx = (status: number): boolean => status === 401 || status === 403;

export function stripBody(h: WithHttp, body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const drop = new Set(h.http.volatileBodyFields ?? []);
  return Object.fromEntries(Object.entries(body).filter(([k]) => !drop.has(k)));
}

/** sameBody(x, y): equal bodies once the volatile top-level keys are dropped. */
export function expectSameBody(h: WithHttp, x: HttpResponse, y: HttpResponse, msg?: string): void {
  assert.deepStrictEqual(stripBody(h, x.body), stripBody(h, y.body), msg);
}

/** The session cookie a response sets, if any. */
export const sessionCookieOf = (h: WithHttp, res: HttpResponse): SetCookie | undefined => parseSetCookie(res.setCookie).find((c) => c.name === h.http.sessionCookie);

/** A jar holding only the session cookie with this value. */
export function sessionJar(h: WithHttp, value: string): CookieJar {
  const jar = new CookieJar();
  jar.set(h.http.sessionCookie, value);
  return jar;
}
