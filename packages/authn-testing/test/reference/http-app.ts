import type { AuthenticationResult, AuthnContext, IdentityRef } from '@spinajs/authn/contracts';
import type { HarnessContext } from '../../src/behaviour/index.js';
import type { Harness, HttpPort, HttpRequest, HttpResponse, HttpRoutes } from '../../src/harness/index.js';
import { buildReference } from './harness.js';
import type { ReferenceExtras, ReferenceOverrides, ReferenceParts } from './harness.js';

export const REFERENCE_ORIGIN = 'https://app.example.test';
export const REFERENCE_SOCKET = '127.0.0.1';
const PROBE_PATH = '/kit/probe';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const MFA_STEPS = 'KitMfaSteps';

type Restored = NonNullable<Awaited<ReturnType<ReferenceParts['sessions']['restore']>>>;

const routes: Partial<HttpRoutes> = {
  login: (login, password) => ({ method: 'POST', path: '/auth/login', body: { login, password } }),
  logout: () => ({ method: 'POST', path: '/auth/logout' }),
  whoami: () => ({ method: 'GET', path: '/auth' }),
  mfaVerify: (code) => ({ method: 'POST', path: '/auth/mfa/verify', body: { code } }),
  sessionsList: () => ({ method: 'GET', path: '/user/sessions' }),
  tokenList: () => ({ method: 'GET', path: '/user/tokens' }),
  activeRoleSet: (role, password) => ({ method: 'POST', path: '/auth/active-role', body: { role, password } }),
  impersonateStart: (target: IdentityRef, password) => ({ method: 'POST', path: '/auth/impersonate', body: { target: target.id, password } }),
};

/**
 * A plain in-process handler (no socket, no framework) standing in for authn-http in the kit's own tests:
 * client address, the A22 CSRF rule, the session cookie, eight routes and the probe. Not N8a.
 */
class ReferenceHttpApp {
  private hits = 0;
  private readonly secure: boolean;
  readonly cookie: string;

  constructor(private readonly parts: ReferenceParts) {
    const env = parts.ctx.config.env ?? 'test';
    this.secure = env === 'production' || env === 'staging';
    this.cookie = this.secure ? '__Host-ssid' : 'ssid';
  }

  private get config() {
    return this.parts.ctx.config.authn?.http;
  }

  private clientIp(xff: string | undefined): string {
    const hops = this.config?.trustProxy ?? null;
    if (hops === null) {
      return REFERENCE_SOCKET;
    }
    const chain = [
      ...(xff ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      REFERENCE_SOCKET,
    ];
    if (typeof hops === 'number') {
      return chain[Math.max(0, chain.length - 1 - hops)];
    }
    let i = chain.length - 1;
    while (i > 0 && hops.includes(chain[i])) i--;
    return chain[i];
  }

  /** A22: an unsafe request carrying the session cookie needs the app's own (or a listed) origin. */
  private csrfRefuses(req: HttpRequest, headers: Record<string, string>): boolean {
    const csrf = this.config?.csrf;
    if (csrf?.enabled === false || SAFE.has(req.method) || req.cookies?.[this.cookie] === undefined) {
      return false;
    }
    const origin = headers['origin'];
    if (origin !== undefined) {
      return origin !== REFERENCE_ORIGIN && !(csrf?.allowedOrigins ?? []).includes(origin);
    }
    return headers['sec-fetch-site'] !== 'same-origin';
  }

  private setCookie(value: string | null): string {
    const flags = `Path=/; HttpOnly; SameSite=Strict${this.secure ? '; Secure' : ''}`;
    return value === null ? `${this.cookie}=; Max-Age=0; ${flags}` : `${this.cookie}=${value}; ${flags}`;
  }

  private json(status: number, body: unknown, extra: { headers?: Record<string, string>; setCookie?: string[] } = {}): HttpResponse {
    return { status, headers: { 'content-type': 'application/json', ...extra.headers }, setCookie: extra.setCookie ?? [], body: JSON.parse(JSON.stringify(body)) };
  }

  private failed(r: Extract<AuthenticationResult, { status: 'failure' }> | null): HttpResponse {
    return this.json(401, { code: 'E_AUTH_FAILED' }, r?.retryAfterSeconds ? { headers: { 'retry-after': String(r.retryAfterSeconds) } } : {});
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const ip = this.clientIp(headers['x-forwarded-for']);
    const ctx = (purpose: AuthnContext['purpose']) => this.parts.ctx.clock.ctx({ ip, purpose });
    if (this.csrfRefuses(req, headers)) {
      return this.json(403, { code: 'E_CSRF' });
    }
    const raw = req.cookies?.[this.cookie];
    const session = raw ? await this.parts.sessions.restore(raw) : null;
    const active = session?.handle.state === 'active' ? session : null;
    const body = (req.body ?? {}) as Record<string, string>;
    const { service, sessions } = this.parts;

    if (req.path === PROBE_PATH) {
      this.hits++;
      const principal = active ? await this.parts.principals.principalOf(active.identity, active.facts, {}) : null;
      return this.json(200, { principal, clientIp: ip, hits: this.hits });
    }
    switch (`${req.method} ${req.path}`) {
      case 'POST /auth/login': {
        const r = await service.authenticate({ kind: 'password', login: body.login, password: body.password }, ctx('login'));
        if (r.status === 'failure') return this.failed(r);
        if (r.status === 'mfa_required') {
          await sessions.set(r.pending, MFA_STEPS, r.steps);
          return this.json(200, { MfaRequired: r.steps }, { setCookie: [this.setCookie(r.pending.id)] });
        }
        return this.json(200, {}, { setCookie: [this.setCookie(r.session!.id)] });
      }
      case 'POST /auth/logout':
        if (session) await sessions.revoke(session.handle);
        return this.json(200, {}, { setCookie: [this.setCookie(null)] });
      case 'GET /auth':
        if (session?.handle.state === 'pending') return this.json(200, { MfaRequired: this.steps(session) });
        return active ? this.json(200, { id: active.identity.id, type: active.identity.type }) : this.failed(null);
      case 'POST /auth/mfa/verify': {
        if (session?.handle.state !== 'pending') return this.failed(null);
        const r = await service.completeMfa(session.handle, this.steps(session)[0], body.code, ctx('login'));
        if (r.status !== 'success') return this.failed(r.status === 'failure' ? r : null);
        return this.json(200, {}, { setCookie: [this.setCookie(r.session!.id)] });
      }
      case 'GET /user/sessions':
      case 'GET /user/tokens':
      case 'POST /auth/active-role':
      case 'POST /auth/impersonate':
        return active ? this.json(200, {}) : this.failed(null);
      default:
        return this.json(404, { code: 'E_NOT_FOUND' });
    }
  }

  private steps(s: Restored): string[] {
    return (s.data.get(MFA_STEPS) as string[] | undefined) ?? [this.parts.step.name];
  }

  port(): HttpPort {
    return { send: (r) => this.send(r), origin: REFERENCE_ORIGIN, sessionCookie: this.cookie, socketAddress: REFERENCE_SOCKET, probePath: PROBE_PATH, routes, volatileBodyFields: [] };
  }
}

/** The reference harness plus an HttpPort over the in-process app (design §10.3). */
export function referenceHttpHarness(ctx: HarnessContext, extras?: ReferenceExtras, over?: ReferenceOverrides): Harness {
  const parts = buildReference(ctx, over);
  const base: Harness = { ...parts.harness, http: new ReferenceHttpApp(parts).port() };
  return { ...base, ...extras?.(base, parts) };
}
