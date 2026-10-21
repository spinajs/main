import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration';
import { CONTROLLED_DESCRIPTOR_SYMBOL, RouteType } from '@spinajs/http';
import type { IContainer } from '@spinajs/di';
import type { IControllerDescriptor, Request } from '@spinajs/http';
import { AuthnThrottle, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';

import { CsrfOriginGuard } from '../../src/middleware/csrf.js';
import { TokenServiceRegistered } from '../../src/token/gate.js';
import { AuthnTokenRevocationController } from '../../src/v3/controllers/AuthnTokenRevocationController.js';
import { fakeContainer, readingFrom } from '../support/config-boot.js';
import { callRoute } from '../support/route-call.js';

const ROUTE = '/auth/tokens/revoke';
const IP = '192.0.2.7';
const FREE = 20;
const RETRY_AFTER = 37;
const LIVE = 'spt_live-secret';

/** Revokes only `LIVE`, once; records what it was asked. */
class StubTokenService extends TokenService {
  public readonly raws: unknown[] = [];
  public readonly contexts: AuthnContext[] = [];
  private live = true;

  public async revokeByPlaintext(raw: string, ctx: AuthnContext): Promise<boolean> {
    this.raws.push(raw);
    this.contexts.push(ctx);
    const hit = this.live && raw === LIVE;
    if (hit) {
      this.live = false;
    }
    return hit;
  }

  public async create(): Promise<never> {
    throw new Error('not used');
  }

  public async list(): Promise<never> {
    throw new Error('not used');
  }

  public async revoke(): Promise<never> {
    throw new Error('not used');
  }

  public async rotate(): Promise<never> {
    throw new Error('not used');
  }

  public async update(): Promise<never> {
    throw new Error('not used');
  }

  public async revokeAllFor(): Promise<never> {
    throw new Error('not used');
  }

  public async validate(): Promise<never> {
    throw new Error('not used');
  }
}

/** Allows `FREE` attempts per flow and key, then refuses; the backoff itself is the throttle's own business. */
class CountingThrottle extends AuthnThrottle {
  public readonly attempts: { keys: readonly ThrottleKey[]; flow: ThrottleFlow }[] = [];
  private readonly counts = new Map<string, number>();

  public async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    this.attempts.push({ keys, flow });
    const ids = keys.map((k) => `${flow}|${k.kind}|${k.value}`);
    if (ids.some((id) => (this.counts.get(id) ?? 0) >= FREE)) {
      return { allowed: false, retryAfterSeconds: RETRY_AFTER };
    }
    ids.forEach((id) => this.counts.set(id, (this.counts.get(id) ?? 0) + 1));
    return { allowed: true };
  }

  public async succeed(): Promise<void> {
    throw new Error('a self-revocation has nothing to clear');
  }
}

interface World {
  readonly controller: AuthnTokenRevocationController;
  readonly tokens: StubTokenService;
  readonly throttle: CountingThrottle;
  request(body: unknown, ip?: string): Request;
}

function world(): World {
  const tokens = new StubTokenService();
  const throttle = new CountingThrottle();
  const services = new Map<unknown, unknown>([
    [TokenService, tokens],
    [AuthnThrottle, throttle],
  ]);
  const container = { resolve: async (type: unknown) => services.get(type) } as unknown as IContainer;
  const controller = readingFrom(new AuthnTokenRevocationController(), fakeContainer({}));
  (controller as unknown as { Container: IContainer }).Container = container;

  // No session, no principal and no cookie: the route is for a caller who holds nothing but the secret.
  const request = (body: unknown, ip: string = IP): Request => ({ body, headers: { 'user-agent': 'mocha' }, storage: { ClientIp: ip } }) as unknown as Request;
  return { controller, tokens, throttle, request };
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly noStore: boolean;
  readonly retryAfter: string | undefined;
}

/** What the response would send, read off the response object without an express round trip. */
function answerOf(res: unknown): Answer {
  const r = res as { _errorCode: number; responseData: unknown; options?: { Headers?: { Name: string; Value: string }[] } };
  const headers = r.options?.Headers ?? [];
  return {
    status: r._errorCode,
    body: r.responseData,
    noStore: headers.some((h) => h.Name === 'Cache-Control' && h.Value === 'no-store'),
    retryAfter: headers.find((h) => h.Name === 'Retry-After')?.Value,
  };
}

describe('POST /auth/tokens/revoke (self-revocation by plaintext)', () => {
  describe('route table', () => {
    const descriptor = (): IControllerDescriptor => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AuthnTokenRevocationController.prototype) as IControllerDescriptor;

    it('mounts one POST route, behind the TokenService gate and nothing else', () => {
      const d = descriptor();
      expect([...d.Routes.keys()]).to.deep.eq(['revoke']);
      expect(d.Routes.get('revoke')).to.include({ Type: RouteType.POST, Path: 'auth/tokens/revoke' });
      expect(d.Policies.map((group) => group.map((p) => p.Type))).to.deep.eq([[TokenServiceRegistered]]);
      expect(d.Routes.get('revoke')!.Policies ?? [], 'the route needs no session, no principal and no fresh authentication').to.have.length(0);
    });
  });

  describe('answers', () => {
    it('revokes a live token by its plaintext and answers 200 {} with no-store, for a caller without a session', async () => {
      const w = world();
      const res = answerOf(await callRoute(w.controller, 'revoke', w.request({ token: LIVE })));

      expect(res).to.deep.include({ status: 200, body: {}, noStore: true });
      expect(w.tokens.raws).to.deep.eq([LIVE]);
      expect(w.tokens.contexts[0]).to.deep.include({ ip: IP, userAgent: 'mocha', purpose: 'request' });
      expect(w.tokens.contexts[0].session, 'there is no session to name').to.eq(undefined);
    });

    it('answers the same 200 {} for an unknown token and for one that is already revoked, and nothing else tells them apart', async () => {
      const w = world();
      const live = answerOf(await callRoute(w.controller, 'revoke', w.request({ token: LIVE })));
      const again = answerOf(await callRoute(w.controller, 'revoke', w.request({ token: LIVE })));
      const unknown = answerOf(await callRoute(w.controller, 'revoke', w.request({ token: 'spt_never-issued' })));

      expect(w.tokens.raws).to.deep.eq([LIVE, LIVE, 'spt_never-issued']);
      expect(again).to.deep.eq(live);
      expect(unknown).to.deep.eq(live);
      expect(JSON.stringify(unknown.body)).to.eq('{}');
    });

    it('answers 200 {} without asking the service when the token is missing, blank, not a string or longer than 1024 characters', async () => {
      const w = world();
      const bodies: unknown[] = [undefined, null, 'token=x', [], {}, { token: '' }, { token: 42 }, { token: null }, { token: [LIVE] }, { token: { toString: () => LIVE } }, { token: 'x'.repeat(1025) }];
      for (const body of bodies) {
        expect(answerOf(await callRoute(w.controller, 'revoke', w.request(body))), JSON.stringify(body)).to.deep.include({ status: 200, body: {}, noStore: true });
      }
      expect(w.tokens.raws).to.deep.eq([]);
    });

    it('accepts a token of 1024 characters', async () => {
      const w = world();
      const long = 'x'.repeat(1024);
      expect(answerOf(await callRoute(w.controller, 'revoke', w.request({ token: long }))).status).to.eq(200);
      expect(w.tokens.raws).to.deep.eq([long]);
    });

    it("takes RFC 7009's token_type_hint and ignores it; any other field answers the same 200 {} and revokes nothing (D5)", async () => {
      const w = world();
      expect(answerOf(await callRoute(w.controller, 'revoke', w.request({ token: LIVE, token_type_hint: 'access_token' }))).status).to.eq(200);
      expect(answerOf(await callRoute(w.controller, 'revoke', w.request({ token: LIVE, id: 'abc', owner: { type: 'user', id: 'x' } })))).to.deep.include({ status: 200, body: {}, noStore: true });
      expect(w.tokens.raws).to.deep.eq([LIVE]);
    });
  });

  describe('throttle', () => {
    it('keys an IPv6 client on its /64', async () => {
      const w = world();
      await callRoute(w.controller, 'revoke', w.request({}, '2001:db8::1'));
      await callRoute(w.controller, 'revoke', w.request({}, '2001:db8::ffff'));
      await callRoute(w.controller, 'revoke', w.request({}, '2001:db8:0:1::1'));

      expect(w.throttle.attempts.map((a) => a.keys)).to.deep.eq([[{ kind: 'ip', value: '2001:db8::/64' }], [{ kind: 'ip', value: '2001:db8::/64' }], [{ kind: 'ip', value: '2001:db8:0:1::/64' }]]);
    });

    it('counts each request in the reset flow, keyed on the client ip alone', async () => {
      const w = world();
      await callRoute(w.controller, 'revoke', w.request({ token: LIVE }));
      await callRoute(w.controller, 'revoke', w.request({}));

      expect(w.throttle.attempts).to.deep.eq([
        { keys: [{ kind: 'ip', value: IP }], flow: 'reset' },
        { keys: [{ kind: 'ip', value: IP }], flow: 'reset' },
      ]);
    });

    it('answers 429 with Retry-After to the 21st request from one ip, without asking the service, and still serves another ip', async () => {
      const w = world();
      for (let i = 0; i < FREE; i++) {
        expect(answerOf(await callRoute(w.controller, 'revoke', w.request({ token: `spt_guess-${i}` }))).status, `request ${i + 1}`).to.eq(200);
      }
      expect(w.tokens.raws).to.have.length(FREE);

      const refused = answerOf(await callRoute(w.controller, 'revoke', w.request({ token: LIVE })));
      expect(refused.status).to.eq(429);
      expect(refused.retryAfter).to.eq(String(RETRY_AFTER));
      expect(refused.noStore).to.eq(true);
      expect(refused.body).to.deep.include({ error: 'throttled' });
      expect(JSON.stringify(refused.body)).to.not.include(LIVE);
      expect(w.tokens.raws, 'a refused request revokes nothing').to.have.length(FREE);

      const other = answerOf(await callRoute(w.controller, 'revoke', w.request({ token: LIVE }, '192.0.2.99')));
      expect(other).to.deep.include({ status: 200, body: {} });
      expect(w.tokens.raws).to.have.length(FREE + 1);
    });

    it('counts a request with no usable token too, so guessing cannot dodge the budget', async () => {
      const w = world();
      for (let i = 0; i < FREE; i++) {
        await callRoute(w.controller, 'revoke', w.request({}));
      }
      expect(answerOf(await callRoute(w.controller, 'revoke', w.request({ token: LIVE }))).status).to.eq(429);
      expect(w.tokens.raws).to.deep.eq([]);
    });
  });

  describe('CSRF origin guard', () => {
    const OWN = 'http://app.example.test';
    const EVIL = 'https://evil.example.net';

    function guard(): CsrfOriginGuard {
      const mw = new CsrfOriginGuard();
      const values = {
        'authn.http.csrf.enabled': true,
        'authn.http.csrf.allowedOrigins': [],
        'authn.session.cookie': { name: 'ssid' },
        'authn.http.trustProxy': null,
        'http.trustProxy': null,
        'http.controllers.route.prefix': '',
      };
      Object.defineProperty(mw, CONFIGURATION_CONTAINER_KEY, { value: fakeContainer(values) });
      Object.defineProperty(mw, 'Log', { value: { warn: () => undefined } });
      return mw;
    }

    function passes(headers: Record<string, string>): boolean {
      const res = { status: () => res, json: () => res };
      const next = sinon.spy();
      const req = { method: 'POST', path: ROUTE, headers: { host: 'app.example.test', ...headers }, socket: { remoteAddress: '127.0.0.1' }, storage: {} } as any;
      guard().before()!(req, res as any, next);
      return next.calledOnce;
    }

    it('X1 lets a non-browser client post without a cookie, and checks a browser like on any route', () => {
      expect(passes({})).to.eq(true);
      expect(passes({ origin: OWN })).to.eq(true);
      expect(passes({ origin: EVIL })).to.eq(false);
      expect(passes({ 'sec-fetch-site': 'cross-site' })).to.eq(false);
    });
  });
});
