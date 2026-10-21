import 'mocha';
import { expect } from 'chai';
import { CONTROLLED_DESCRIPTOR_SYMBOL, HTTP_CONFIGURATION_SCHEMA, RouteType } from '@spinajs/http';
import type { IControllerDescriptor, Request } from '@spinajs/http';
import type { IContainer } from '@spinajs/di';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AuthnService } from '@spinajs/authn/contracts';
import type { AuthenticationResult, AuthnContext, Principal, SessionHandle } from '@spinajs/authn/contracts';
import { AUTHN_SESSION_CONFIGURATION_SCHEMA } from '@spinajs/authn-session';

import { AUTHN_HTTP_CONFIGURATION_SCHEMA } from '../../src/index.js';
import { AuthnMfaController } from '../../src/v3/controllers/AuthnMfaController.js';
import { boot, disposeBooted } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_HTTP_CONFIGURATION_SCHEMA, AUTHN_SESSION_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];
const ALICE = { type: 'user', id: 'alice' };
const AAL1: SessionHandle = { id: 'aal1-session-id', state: 'active' };
const AAL2: SessionHandle = { id: 'aal2-session-id', state: 'active' };
const PENDING: SessionHandle = { id: 'pending-session-id', state: 'pending' };
const GOOD_CODE = '123456';
const RETRY_AFTER = 42;

/** Answers stepUp for AAL1 with GOOD_CODE; records every call. */
class StubAuthnService extends AuthnService {
  public readonly calls: { session: SessionHandle; step: string; response: string; ctx: AuthnContext }[] = [];
  public throttled = false;

  public async stepUp(session: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult> {
    this.calls.push({ session, step, response, ctx });
    if (this.throttled) return { status: 'failure', reason: 'throttled', retryAfterSeconds: RETRY_AFTER };
    if (session.id !== AAL1.id || response !== GOOD_CODE) return { status: 'failure', reason: 'invalid_credentials' };
    return { status: 'success', identity: ALICE, facts: { method: 'password', strategy: 'local', assurance: 'aal2', mfa: [step] }, session: AAL2 };
  }

  public async principalOf(result: Extract<AuthenticationResult, { status: 'success' }>): Promise<Principal> {
    return { type: result.identity.type, id: result.identity.id, authenticated: true, source: 'session', attributes: {}, authn: { ...result.facts, authenticatedAt: new Date('2026-10-21T08:00:00Z') } };
  }

  public async authenticate(): Promise<never> {
    throw new Error('not used');
  }

  public async completeMfa(): Promise<never> {
    throw new Error('not used');
  }

  public async reauthenticate(): Promise<never> {
    throw new Error('not used');
  }

  public strategies(): never {
    throw new Error('not used');
  }
}

interface World {
  readonly controller: AuthnMfaController;
  readonly authn: StubAuthnService;
  request(session: SessionHandle | null, body: unknown): Request;
}

async function world(): Promise<World> {
  const { configuration } = await boot(SCHEMAS, { http: { cookie: { secret: 'step-up-' + 'Zq8Lw2Rt'.repeat(6) } } });
  const authn = new StubAuthnService();
  // AuthnResponseExtension lists (Array.ofType) resolve to none.
  const container = { resolve: async (type: unknown) => (type === AuthnService ? authn : []) } as unknown as IContainer;
  const controller = new AuthnMfaController();
  (controller as unknown as { Container: IContainer }).Container = container;
  Object.defineProperty(controller, '_cfg', { value: configuration });
  const request = (session: SessionHandle | null, body: unknown): Request =>
    ({
      body,
      headers: { 'user-agent': 'mocha' },
      storage: { ClientIp: '192.0.2.10', ...(session ? { AuthnSession: { handle: session, identity: ALICE, facts: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() } } } : {}) },
    }) as unknown as Request;
  return { controller, authn, request };
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

describe('POST /auth/mfa/step-up (FLOW-1)', function () {
  this.timeout(20000);
  afterEach(disposeBooted);

  it('is a POST route of the MFA controller at auth/mfa/step-up', () => {
    const d = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AuthnMfaController.prototype) as IControllerDescriptor;
    expect(d.Routes.get('stepUp')).to.include({ Type: RouteType.POST, Path: 'mfa/step-up' });
  });

  it('an aal1 session with the right code answers 200 with the new session cookie and the principal at aal2', async () => {
    const w = await world();
    const a = answerOf(await w.controller.stepUp(w.request(AAL1, { step: 'totp', code: GOOD_CODE })));

    expect(a.status).to.eq(200);
    expect(a.noStore).to.eq(true);
    expect(a.cookies).to.have.length(1);
    expect(a.cookies[0].Value).to.eq(AAL2.id);
    expect((a.body as { Authn?: { assurance?: string; mfa?: string[] } }).Authn).to.include({ assurance: 'aal2' });
    expect(w.authn.calls.map((c) => [c.session.id, c.step, c.response])).to.deep.eq([[AAL1.id, 'totp', GOOD_CODE]]);
    expect(w.authn.calls[0].ctx.ip).to.eq('192.0.2.10');
  });

  it('a wrong code answers the login failure body without a cookie', async () => {
    const w = await world();
    const a = answerOf(await w.controller.stepUp(w.request(AAL1, { step: 'totp', code: 'wrong' })));
    expect(a.status).to.eq(401);
    expect(a.cookies).to.deep.eq([]);
    expect(a.retryAfter).to.eq(undefined);
  });

  it('a throttled step-up answers 401 with Retry-After', async () => {
    const w = await world();
    w.authn.throttled = true;
    const a = answerOf(await w.controller.stepUp(w.request(AAL1, { step: 'totp', code: GOOD_CODE })));
    expect(a.status).to.eq(401);
    expect(a.retryAfter).to.eq(String(RETRY_AFTER));
  });

  it('a missing code answers the login failure body and asks the service nothing', async () => {
    const w = await world();
    const a = answerOf(await w.controller.stepUp(w.request(AAL1, { step: 'totp' })));
    expect(a.status).to.eq(401);
    expect(w.authn.calls).to.deep.eq([]);
  });

  it('without a session answers 401 unauthenticated', async () => {
    const w = await world();
    const e = await thrown(w.controller.stepUp(w.request(null, { step: 'totp', code: GOOD_CODE })));
    expect(e).to.be.instanceOf(AuthenticationFailed);
    expect((e as { error?: unknown }).error).to.eq('unauthenticated');
    expect(w.authn.calls).to.deep.eq([]);
  });

  it('a pending session is refused by the controller, as the verify route refuses a wrong state', async () => {
    const w = await world();
    const e = await thrown(w.controller.stepUp(w.request(PENDING, { step: 'totp', code: GOOD_CODE })));
    expect(e).to.be.instanceOf(Forbidden);
    expect((e as { error?: unknown }).error).to.eq('mfa_pending');
    expect(w.authn.calls).to.deep.eq([]);
  });
});
