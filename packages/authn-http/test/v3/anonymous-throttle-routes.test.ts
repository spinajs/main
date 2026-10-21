import 'mocha';
import { expect } from 'chai';
import type { IContainer } from '@spinajs/di';
import type { Request } from '@spinajs/http';
import { AuthnThrottle, PasskeyChallengesFull, PasskeyService } from '@spinajs/authn/contracts';
import type { AuthnContext, PasskeyCeremony, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';

import { AuthnPasskeyController } from '../../src/v3/controllers/AuthnPasskeyController.js';
import { AuthnVerificationController } from '../../src/v3/controllers/AuthnVerificationController.js';
import { fakeContainer, readingFrom } from '../support/config-boot.js';
import { callRoute } from '../support/route-call.js';

const IP = '192.0.2.7';
const RETRY_AFTER = 29;

class RefusingThrottle extends AuthnThrottle {
  public readonly attempts: { keys: readonly ThrottleKey[]; flow: ThrottleFlow }[] = [];
  public refuse = false;

  public async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    this.attempts.push({ keys, flow });
    return this.refuse ? { allowed: false, retryAfterSeconds: RETRY_AFTER } : { allowed: true };
  }

  public async succeed(): Promise<void> {
    throw new Error('nothing to clear');
  }
}

class StubPasskeys extends PasskeyService {
  public readonly calls: { ctx: AuthnContext; identity?: unknown }[] = [];
  public full = false;

  public async challenge(ctx: AuthnContext, identity?: unknown): Promise<PasskeyCeremony> {
    this.calls.push({ ctx, identity });
    if (this.full) throw new PasskeyChallengesFull();
    return { challengeId: 'cid', options: { challenge: 'abc' } };
  }

  public async registrationOptions(): Promise<never> {
    throw new Error('not used');
  }

  public async register(): Promise<never> {
    throw new Error('not used');
  }

  public async list(): Promise<never> {
    throw new Error('not used');
  }

  public async remove(): Promise<never> {
    throw new Error('not used');
  }
}

class StubPasswords {
  public result: unknown = { status: 'invalid' };
  public readonly secrets: string[] = [];

  public async redeemVerification(secret: string): Promise<never> {
    this.secrets.push(secret);
    return this.result as never;
  }
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly noStore: boolean;
  readonly retryAfter: string | undefined;
}

function answerOf(res: unknown): Answer {
  const r = res as { _errorCode: number; responseData: unknown; options?: { Headers?: { Name: string; Value: string }[] } };
  const headers = r.options?.Headers ?? [];
  return { status: r._errorCode, body: r.responseData, noStore: headers.some((h) => h.Name === 'Cache-Control' && h.Value === 'no-store'), retryAfter: headers.find((h) => h.Name === 'Retry-After')?.Value };
}

const request = (body: unknown, extra: object = {}, ip: string = IP): Request => ({ body, headers: { 'user-agent': 'mocha' }, storage: { ClientIp: ip, ...extra } }) as unknown as Request;

function wire<T extends object>(controller: T, services: Map<unknown, unknown>, warnings: string[] = []): T {
  const container = { resolve: async (type: unknown) => services.get(type) } as unknown as IContainer;
  Object.assign(controller, { Container: container });
  Object.defineProperty(controller, '_log', { value: { warn: (m: string) => warnings.push(m) } });
  return readingFrom(controller, fakeContainer({}));
}

describe('anonymous routes with an ip throttle', () => {
  describe('POST /auth/verify', () => {
    function world() {
      const passwords = new StubPasswords();
      const controller = wire(new AuthnVerificationController(), new Map<unknown, unknown>([[AuthnThrottle, new RefusingThrottle()]]));
      Object.assign(controller, { Passwords: passwords });
      return { controller, passwords };
    }

    it('answers 429 with Retry-After when the service reports a throttled ip, and not invalid_secret', async () => {
      const w = world();
      w.passwords.result = { status: 'throttled', retryAfterSeconds: RETRY_AFTER };
      const res = answerOf(await callRoute(w.controller, 'verify', request({ secret: 'some.secret' })));
      expect(res.status).to.eq(429);
      expect(res.retryAfter).to.eq(String(RETRY_AFTER));
      expect(res.noStore).to.eq(true);
      expect(res.body).to.deep.include({ error: 'throttled' });
    });

    it('keeps the one invalid_secret answer for a refused secret', async () => {
      const w = world();
      const res = answerOf(await callRoute(w.controller, 'verify', request({ secret: 'wrong' })));
      expect(res.status).to.eq(400);
      expect(res.body).to.deep.include({ error: 'invalid_secret' });
    });
  });

  describe('POST /auth/passkeys/challenge', () => {
    function world(warnings: string[] = []) {
      const throttle = new RefusingThrottle();
      const passkeys = new StubPasskeys();
      const controller = wire(
        new AuthnPasskeyController(),
        new Map<unknown, unknown>([
          [AuthnThrottle, throttle],
          [PasskeyService, passkeys],
        ]),
        warnings,
      );
      return { controller, throttle, passkeys };
    }

    it('counts an anonymous caller in the login flow on its ip, IPv6 on the /64', async () => {
      const w = world();
      await callRoute(w.controller, 'challenge', request({}));
      await callRoute(w.controller, 'challenge', request({}, {}, '2001:db8::1'));
      await callRoute(w.controller, 'challenge', request({}, {}, '2001:db8::ffff'));
      expect(w.throttle.attempts).to.deep.eq([
        { keys: [{ kind: 'ip', value: IP }], flow: 'login' },
        { keys: [{ kind: 'ip', value: '2001:db8::/64' }], flow: 'login' },
        { keys: [{ kind: 'ip', value: '2001:db8::/64' }], flow: 'login' },
      ]);
    });

    it('answers 429 with Retry-After to a throttled ip and issues no challenge', async () => {
      const w = world();
      w.throttle.refuse = true;
      const res = answerOf(await callRoute(w.controller, 'challenge', request({})));
      expect(res.status).to.eq(429);
      expect(res.retryAfter).to.eq(String(RETRY_AFTER));
      expect(w.passkeys.calls).to.have.length(0);
    });

    it('does not throttle the MFA step challenge of a pending session', async () => {
      const w = world();
      w.throttle.refuse = true;
      const pending = { handle: { state: 'pending' }, identity: { type: 'user', id: 'u1' } };
      const res = answerOf(await callRoute(w.controller, 'challenge', request({}, { AuthnSession: pending })));
      expect(res.status).to.eq(200);
      expect(w.throttle.attempts).to.have.length(0);
      expect(w.passkeys.calls[0].identity).to.deep.eq({ type: 'user', id: 'u1' });
    });

    it('answers 503 with Retry-After when the challenge store is full, and logs it once', async () => {
      const warnings: string[] = [];
      const w = world(warnings);
      w.passkeys.full = true;
      for (let i = 0; i < 3; i++) {
        const res = answerOf(await callRoute(w.controller, 'challenge', request({})));
        expect(res.status, `call ${i + 1}`).to.eq(503);
        expect(res.noStore).to.eq(true);
        expect(res.retryAfter).to.eq('30');
        expect(res.body).to.deep.include({ error: 'challenge_store_full' });
      }
      expect(warnings).to.have.length(1);

      w.passkeys.full = false;
      expect(answerOf(await callRoute(w.controller, 'challenge', request({}))).status).to.eq(200);
      w.passkeys.full = true;
      await callRoute(w.controller, 'challenge', request({}));
      expect(warnings, 'logged again after the store recovered').to.have.length(2);
    });
  });
});
