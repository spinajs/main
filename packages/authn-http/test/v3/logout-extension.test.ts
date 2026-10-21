/** POST /auth/logout with logout extensions (FLOW-3): the answer a redirect turns into, and the order of revoke and extension. */
import 'mocha';
import { expect } from 'chai';
import { TypedArray } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Ok, Redirect } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { AuthnAudit } from '@spinajs/authn';
import { Session } from '@spinajs/authn/contracts';
import type { AuthnEvent, SessionHandle } from '@spinajs/authn/contracts';

import { AuthnLogoutExtension } from '../../src/v3/logout-extension.js';
import { AuthnLoginController } from '../../src/v3/controllers/AuthnLoginController.js';

const END_SESSION = 'https://idp.example.test/realms/corp/logout?client_id=canvas&post_logout_redirect_uri=https%3A%2F%2Fapp.example.test%2F';

class Recording extends AuthnLogoutExtension {
  public readonly calls: { session: Session; req: Request; revokedAtCall: readonly string[] }[] = [];

  constructor(
    private readonly answer: () => Promise<{ redirect?: string } | void>,
    private readonly revoked: string[],
  ) {
    super();
  }

  public async afterLogout(session: Session, req: Request): Promise<{ redirect?: string } | void> {
    this.calls.push({ session, req, revokedAtCall: [...this.revoked] });
    return this.answer();
  }
}

const sessionOf = (id = 'raw-session-id'): Session =>
  new Session({
    handle: { id, state: 'active' },
    identity: { type: 'user', id: 'u1' },
    facts: { method: 'oidc', strategy: 'oidc:corp', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), external: { provider: 'oidc:corp', sid: 'idp-1' }, sessionHandle: 'a'.repeat(64) },
  });

interface World {
  readonly controller: AuthnLoginController;
  readonly revoked: string[];
  readonly warned: unknown[][];
  readonly audited: string[];
  extension(answer: () => Promise<{ redirect?: string } | void>): Recording;
  request(headers?: Record<string, string>, session?: Session | null): Request;
}

function world(): World {
  const revoked: string[] = [];
  const audited: string[] = [];
  const warned: unknown[][] = [];
  const extensions: AuthnLogoutExtension[] = [];
  const audit = { publish: async (e: AuthnEvent) => void audited.push(e.type) };
  const container = {
    resolve: async (type: unknown) => {
      if (type === AuthnAudit) return audit;
      if (type instanceof TypedArray && type.Type === AuthnLogoutExtension) return [...extensions];
      throw new Error('unexpected resolve');
    },
  } as unknown as IContainer;
  const sessions = {
    revoke: async (h: SessionHandle) => {
      revoked.push(h.id);
      return true;
    },
  };
  const controller = new AuthnLoginController();
  Object.assign(controller, { Container: container, Sessions: sessions, _cfg: { Env: 'test', get: (path: string, fallback?: unknown) => (path === 'process.env.APP_ENV' ? 'test' : fallback) } });
  Object.defineProperty(controller, 'Log', { value: { warn: (...args: unknown[]) => void warned.push(args) } });

  const extension = (answer: () => Promise<{ redirect?: string } | void>): Recording => {
    const e = new Recording(answer, revoked);
    extensions.push(e);
    return e;
  };
  const request = (headers: Record<string, string> = {}, session: Session | null = sessionOf()): Request => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { headers: { 'user-agent': 'mocha', ...lower }, get: (name: string) => lower[name.toLowerCase()], storage: { ClientIp: '192.0.2.7', AuthnSession: session } } as unknown as Request;
  };
  return { controller, revoked, warned, audited, extension, request };
}

interface Answer {
  readonly kind: 'ok' | 'redirect';
  readonly status: number;
  readonly body: unknown;
  readonly location: string | undefined;
  readonly headers: Record<string, string>;
  readonly cookies: { Name: string; Value: string }[];
}

/** What the response would send, read off the response object without an express round trip. */
function answerOf(res: unknown): Answer {
  if (res instanceof Redirect) {
    const r = res as unknown as { url: string; status: number; responseOptions?: { Headers?: { Name: string; Value: string }[]; Coockies?: { Name: string; Value: string }[] } };
    return { kind: 'redirect', status: r.status, body: undefined, location: r.url, headers: Object.fromEntries((r.responseOptions?.Headers ?? []).map((h) => [h.Name, h.Value])), cookies: r.responseOptions?.Coockies ?? [] };
  }
  expect(res).to.be.instanceOf(Ok);
  const r = res as { _errorCode: number; responseData: unknown; options?: { Headers?: { Name: string; Value: string }[]; Coockies?: { Name: string; Value: string }[] } };
  return { kind: 'ok', status: r._errorCode, body: r.responseData, location: undefined, headers: Object.fromEntries((r.options?.Headers ?? []).map((h) => [h.Name, h.Value])), cookies: r.options?.Coockies ?? [] };
}

const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate' };

describe('POST /auth/logout with logout extensions', () => {
  it('without an extension answers today\'s 200 with the cleared cookie, the site data header and no-store', async () => {
    const w = world();
    for (const headers of [{}, NAVIGATE]) {
      const res = answerOf(await w.controller.logout(w.request(headers)));
      expect(res).to.deep.include({ kind: 'ok', status: 200, body: null });
      expect(res.headers['Clear-Site-Data']).to.eq('"cache", "cookies", "storage"');
      expect(res.headers['Cache-Control']).to.eq('no-store');
      expect(res.cookies).to.have.length(1);
      expect(res.cookies[0].Value).to.eq('');
    }
    expect(w.revoked).to.deep.eq(['raw-session-id', 'raw-session-id']);
  });

  it('a navigation request gets 303 to the redirect, with the cleared cookie, the site data header and no-store', async () => {
    const w = world();
    w.extension(async () => ({ redirect: END_SESSION }));
    const res = answerOf(await w.controller.logout(w.request(NAVIGATE)));
    expect(res).to.deep.include({ kind: 'redirect', status: 303, location: END_SESSION });
    expect(res.headers['Clear-Site-Data']).to.eq('"cache", "cookies", "storage"');
    expect(res.headers['Cache-Control']).to.eq('no-store');
    expect(res.cookies).to.have.length(1);
    expect(res.cookies[0].Value).to.eq('');
  });

  it('a request that accepts text/html counts as a navigation', async () => {
    const w = world();
    w.extension(async () => ({ redirect: END_SESSION }));
    expect(answerOf(await w.controller.logout(w.request({ Accept: 'text/html,application/xhtml+xml;q=0.9' }))).status).to.eq(303);
  });

  it('a script gets 200 { endSession } with the same cookie and headers', async () => {
    const w = world();
    w.extension(async () => ({ redirect: END_SESSION }));
    for (const headers of [{}, { Accept: 'application/json' }, { 'Sec-Fetch-Mode': 'cors' }] as Record<string, string>[]) {
      const res = answerOf(await w.controller.logout(w.request(headers)));
      expect(res).to.deep.include({ kind: 'ok', status: 200, body: { endSession: END_SESSION } });
      expect(res.headers['Clear-Site-Data']).to.eq('"cache", "cookies", "storage"');
      expect(res.headers['Cache-Control']).to.eq('no-store');
      expect(res.cookies[0].Value).to.eq('');
    }
  });

  it('revokes the session and audits the logout before any extension runs', async () => {
    const w = world();
    const ext = w.extension(async () => ({ redirect: END_SESSION }));
    const session = sessionOf();
    await w.controller.logout(w.request(NAVIGATE, session));
    expect(ext.calls).to.have.length(1);
    expect(ext.calls[0].revokedAtCall).to.deep.eq(['raw-session-id']);
    expect(ext.calls[0].session).to.eq(session);
    expect(w.audited).to.deep.eq(['logout']);
  });

  it('hands the extension the request it served', async () => {
    const w = world();
    const ext = w.extension(async () => undefined);
    const req = w.request(NAVIGATE);
    await w.controller.logout(req);
    expect(ext.calls[0].req).to.eq(req);
  });

  it('an extension that answers nothing, an empty object or an empty redirect leaves the answer at 200', async () => {
    for (const answer of [async () => undefined, async () => ({}), async () => ({ redirect: '' })]) {
      const one = world();
      one.extension(answer);
      expect(answerOf(await one.controller.logout(one.request(NAVIGATE)))).to.deep.include({ kind: 'ok', status: 200, body: null });
    }
  });

  it('the first redirect wins, and every extension still runs', async () => {
    const w = world();
    const first = w.extension(async () => undefined);
    const second = w.extension(async () => ({ redirect: 'https://one.example.test/logout' }));
    const third = w.extension(async () => ({ redirect: 'https://two.example.test/logout' }));
    const res = answerOf(await w.controller.logout(w.request(NAVIGATE)));
    expect(res.location).to.eq('https://one.example.test/logout');
    expect([first, second, third].map((e) => e.calls.length)).to.deep.eq([1, 1, 1]);
  });

  it('a failing extension does not fail the logout: the session stays revoked, the others still answer, and it is logged', async () => {
    const w = world();
    w.extension(async () => {
      throw new Error('idp lookup failed with secret-value');
    });
    w.extension(async () => ({ redirect: END_SESSION }));
    const res = answerOf(await w.controller.logout(w.request(NAVIGATE)));
    expect(res).to.deep.include({ kind: 'redirect', status: 303, location: END_SESSION });
    expect(w.revoked).to.deep.eq(['raw-session-id']);
    expect(w.warned).to.have.length(1);
    expect(JSON.stringify(w.warned)).to.not.include('secret-value');
  });

  it('a failing extension alone leaves the plain 200', async () => {
    const w = world();
    w.extension(async () => {
      throw new Error('boom');
    });
    expect(answerOf(await w.controller.logout(w.request(NAVIGATE)))).to.deep.include({ kind: 'ok', status: 200, body: null });
  });

  it('answers 401 without a session, revokes nothing and calls no extension', async () => {
    const w = world();
    const ext = w.extension(async () => ({ redirect: END_SESSION }));
    let thrown: unknown;
    try {
      await w.controller.logout(w.request(NAVIGATE, null));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(w.revoked).to.deep.eq([]);
    expect(ext.calls).to.have.length(0);
  });

  it('exports AuthnLogoutExtension from the package root', async () => {
    const root = await import('../../src/index.js');
    expect(root.AuthnLogoutExtension).to.eq(AuthnLogoutExtension);
  });
});
