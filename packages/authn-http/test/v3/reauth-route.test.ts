import 'mocha';
import { expect } from 'chai';
import { CONTROLLED_DESCRIPTOR_SYMBOL, HTTP_CONFIGURATION_SCHEMA, RouteType } from '@spinajs/http';
import type { IControllerDescriptor, Request } from '@spinajs/http';
import type { IContainer } from '@spinajs/di';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { AuthnAudit } from '@spinajs/authn';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AUTHN_FAILURE_BODY, AuthnService, IdentityStore } from '@spinajs/authn/contracts';
import type { AuthenticationResult, AuthnContext, AuthnEvent, AuthnFacts, Credentials, IdentityRef, Principal, SessionHandle } from '@spinajs/authn/contracts';
import { AUTHN_SESSION_CONFIGURATION_SCHEMA } from '@spinajs/authn-session';
import { MemorySessionIssuer } from '@spinajs/authn-testing';

import { AUTHN_HTTP_CONFIGURATION_SCHEMA } from '../../src/index.js';
import { PASSWORD_HARD_CAP } from '../../src/v3/index.js';
import { AuthnReauthController } from '../../src/v3/controllers/AuthnReauthController.js';
import { boot, disposeBooted } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_HTTP_CONFIGURATION_SCHEMA, AUTHN_SESSION_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];
const ALICE: IdentityRef = { type: 'user', id: 'alice' };
const ALICE_EMAIL = 'alice@example.test';
const GOOD = 'Alice-Pass-1234';
const STALE_MS = 3_600_000;

/** Answers reauthenticate true for GOOD; records every call. */
class StubAuthnService extends AuthnService {
  public readonly calls: { session: SessionHandle; credentials: Credentials; ctx: AuthnContext }[] = [];
  public beforeAnswer: (() => Promise<void>) | null = null;

  constructor(protected readonly sessions: MemorySessionIssuer) {
    super();
  }

  public async reauthenticate(session: SessionHandle, credentials: Credentials, ctx: AuthnContext): Promise<boolean> {
    this.calls.push({ session, credentials, ctx });
    await this.beforeAnswer?.();
    return (credentials as { password?: unknown }).password === GOOD;
  }

  public async principalOf(result: Extract<AuthenticationResult, { status: 'success' }>): Promise<Principal> {
    const stored = await this.sessions.restore(result.session!.id);
    if (!stored) throw new Error('the session of this result is gone');
    return { type: stored.identity.type, id: stored.identity.id, authenticated: true, source: 'session', attributes: {}, authn: stored.facts };
  }

  public async authenticate(): Promise<never> {
    throw new Error('not used');
  }

  public async completeMfa(): Promise<never> {
    throw new Error('not used');
  }

  public async stepUp(): Promise<never> {
    throw new Error('not used');
  }

  public strategies(): never {
    throw new Error('not used');
  }
}

interface World {
  readonly controller: AuthnReauthController;
  readonly authn: StubAuthnService;
  readonly sessions: MemorySessionIssuer;
  readonly events: Omit<AuthnEvent, 'at'>[];
  session(o?: { pending?: boolean; impersonated?: boolean }): Promise<SessionHandle>;
  request(session: SessionHandle | null, body: unknown): Promise<Request>;
}

async function world(): Promise<World> {
  const { configuration } = await boot(SCHEMAS, { http: { cookie: { secret: 'reauth-' + 'Zq8Lw2Rt'.repeat(6) } } });
  const sessions = new MemorySessionIssuer();
  const authn = new StubAuthnService(sessions);
  const events: Omit<AuthnEvent, 'at'>[] = [];
  const audit = { publish: async (e: AuthnEvent) => void events.push(e) };
  const identities = { display: async () => ({ email: ALICE_EMAIL }) };
  // AuthnResponseExtension lists (Array.ofType) resolve to none.
  const container = { resolve: async (type: unknown) => (type === AuthnService ? authn : type === IdentityStore ? identities : type === AuthnAudit ? audit : []) } as unknown as IContainer;
  const controller = new AuthnReauthController();
  Object.assign(controller as unknown as { Container: IContainer; Sessions: MemorySessionIssuer }, { Container: container, Sessions: sessions });
  Object.defineProperty(controller, '_cfg', { value: configuration });

  const session = async (o: { pending?: boolean; impersonated?: boolean } = {}): Promise<SessionHandle> => {
    const facts: AuthnFacts = {
      method: 'password',
      strategy: 'local',
      assurance: 'aal2',
      mfa: ['totp'],
      authenticatedAt: new Date(Date.now() - STALE_MS),
      ...(o.impersonated ? { impersonator: { type: 'user', id: 'admin' } } : {}),
    };
    return sessions.issue(ALICE, facts, o.pending ? { pending: { steps: ['totp'] } } : undefined);
  };
  const request = async (handle: SessionHandle | null, body: unknown): Promise<Request> => {
    const stored = handle ? await sessions.restore(handle.id) : null;
    return { body, headers: { 'user-agent': 'mocha' }, storage: { ClientIp: '192.0.2.10', ...(stored ? { AuthnSession: stored } : {}) } } as unknown as Request;
  };
  return { controller, authn, sessions, events, session, request };
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly cookies: { Name: string; Value: string }[];
  readonly noStore: boolean;
  readonly retryAfter: string | undefined;
}

function answerOf(res: unknown): Answer {
  const r = res as { _errorCode: number; responseData: unknown; options?: { Headers?: { Name: string; Value: string }[]; Coockies?: { Name: string; Value: string }[] } };
  const headers = r.options?.Headers ?? [];
  return {
    status: r._errorCode,
    body: r.responseData,
    cookies: r.options?.Coockies ?? [],
    noStore: headers.some((h) => h.Name === 'Cache-Control' && h.Value === 'no-store'),
    retryAfter: headers.find((h) => h.Name === 'Retry-After')?.Value,
  };
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
}

const failureBodyOf = (a: Answer) => (a.body as { error?: unknown }).error;

describe('POST /auth/reauth (FLOW-4)', function () {
  this.timeout(20000);
  afterEach(disposeBooted);

  it('is a POST route of AuthnReauthController at auth/reauth', () => {
    const d = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AuthnReauthController.prototype) as IControllerDescriptor;
    expect(d.BasePath).to.eq('auth');
    expect(d.Routes.get('reauth')).to.include({ Type: RouteType.POST, Path: 'reauth' });
  });

  it('an old session with the right password answers 200 with the cookie of a new id whose authenticatedAt is now', async () => {
    const w = await world();
    const old = await w.session();
    await w.sessions.set(old, 'ActiveRole', 'editor');
    const a = answerOf(await w.controller.reauth(await w.request(old, { password: GOOD })));

    expect(a.status).to.eq(200);
    expect(a.noStore).to.eq(true);
    expect(a.cookies).to.have.length(1);
    const next = a.cookies[0].Value;
    expect(next).to.not.eq(old.id);
    expect(await w.sessions.restore(old.id), 'the old id is dead').to.eq(null);

    expect(w.authn.calls).to.have.length(1);
    const call = w.authn.calls[0];
    expect(call.session.id).to.eq(old.id);
    expect(call.credentials).to.deep.eq({ kind: 'password', login: ALICE_EMAIL, password: GOOD });
    expect(call.ctx).to.include({ purpose: 'reauth', ip: '192.0.2.10' });
    expect(call.ctx.session?.id).to.eq(old.id);

    const now = (await w.sessions.restore(next))!;
    expect(now.identity).to.deep.eq(ALICE);
    expect(now.facts.authenticatedAt.getTime()).to.eq(call.ctx.now.getTime());
    expect(now.facts.assurance, 'a re-authentication keeps the assurance').to.eq('aal2');
    expect([...now.facts.mfa]).to.deep.eq(['totp']);
    expect(now.data.get('ActiveRole')).to.eq('editor');
    expect((a.body as { Authn?: { authenticatedAt?: string } }).Authn?.authenticatedAt).to.eq(call.ctx.now.toISOString());
  });

  it('a wrong password answers the login failure body without a cookie or Retry-After and leaves the session as it was', async () => {
    const w = await world();
    const old = await w.session();
    const before = await w.sessions.restore(old.id);
    const a = answerOf(await w.controller.reauth(await w.request(old, { password: 'Wrong-Pass-9876' })));
    expect(a.status).to.eq(401);
    expect(failureBodyOf(a)).to.deep.eq(AUTHN_FAILURE_BODY.error);
    expect(a.cookies).to.deep.eq([]);
    expect(a.retryAfter).to.eq(undefined);
    expect(w.authn.calls).to.have.length(1);
    expect((await w.sessions.restore(old.id))?.facts).to.deep.eq(before?.facts);
  });

  for (const [label, body] of [
    ['a missing password', {}],
    ['an empty password', { password: '' }],
    ['a password that is no string', { password: ['a', 'b'] }],
  ] as const) {
    it(`${label} answers the login failure body and asks the service nothing`, async () => {
      const w = await world();
      const a = answerOf(await w.controller.reauth(await w.request(await w.session(), body)));
      expect(a.status).to.eq(401);
      expect(w.authn.calls).to.deep.eq([]);
    });
  }

  it('a password over PASSWORD_HARD_CAP answers the login failure body, asks the service nothing and is audited', async () => {
    const w = await world();
    const a = answerOf(await w.controller.reauth(await w.request(await w.session(), { password: 'x'.repeat(PASSWORD_HARD_CAP + 1) })));
    expect(a.status).to.eq(401);
    expect(w.authn.calls).to.deep.eq([]);
    expect(w.events.map((e) => [e.type, e.outcome, e.reason])).to.deep.eq([['reauth', 'failure', 'password_too_long']]);
  });

  it('without a session answers 401 unauthenticated', async () => {
    const w = await world();
    const e = await thrown(w.controller.reauth(await w.request(null, { password: GOOD })));
    expect(e).to.be.instanceOf(AuthenticationFailed);
    expect((e as { error?: unknown }).error).to.eq('unauthenticated');
    expect(w.authn.calls).to.deep.eq([]);
  });

  it('a pending session is refused with mfa_pending', async () => {
    const w = await world();
    const pending = await w.session({ pending: true });
    const e = await thrown(w.controller.reauth(await w.request(pending, { password: GOOD })));
    expect(e).to.be.instanceOf(Forbidden);
    expect((e as { error?: unknown }).error).to.eq('mfa_pending');
    expect(w.authn.calls).to.deep.eq([]);
    expect((await w.sessions.restore(pending.id))?.handle.state).to.eq('pending');
  });

  it('an impersonation is refused with impersonating and asks the service nothing', async () => {
    const w = await world();
    const e = await thrown(w.controller.reauth(await w.request(await w.session({ impersonated: true }), { password: GOOD })));
    expect(e).to.be.instanceOf(Forbidden);
    expect((e as { error?: unknown }).error).to.eq('impersonating');
    expect(w.authn.calls).to.deep.eq([]);
  });

  it('a session that ends during the re-authentication answers 401 unauthenticated and issues nothing', async () => {
    const w = await world();
    const old = await w.session();
    w.authn.beforeAnswer = async () => void (await w.sessions.revoke(old));
    const e = await thrown(w.controller.reauth(await w.request(old, { password: GOOD })));
    expect(e).to.be.instanceOf(AuthenticationFailed);
    expect((e as { error?: unknown }).error).to.eq('unauthenticated');
    expect(await w.sessions.storage.storedKeys()).to.deep.eq([]);
  });
});
