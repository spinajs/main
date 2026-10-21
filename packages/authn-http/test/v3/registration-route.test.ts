import 'mocha';
import { expect } from 'chai';
import { CONTROLLED_DESCRIPTOR_SYMBOL, RouteType } from '@spinajs/http';
import type { IContainer } from '@spinajs/di';
import type { IControllerDescriptor, Request } from '@spinajs/http';
import { AuthnAudit } from '@spinajs/authn';
import { AuthnThrottle, IdentityRegistrar, PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, IdentityRef, PasswordPolicy, PasswordPolicyContext, PasswordViolation, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';

import { IdentityRegistrarRegistered } from '../../src/policies/v3/groups.js';
import { AuthnRegistrationController } from '../../src/v3/controllers/AuthnRegistrationController.js';
import { fakeContainer, readingFrom } from '../support/config-boot.js';
import { callRoute } from '../support/route-call.js';

const ROUTE = 'auth/register';
const IP = '192.0.2.7';
const FREE = 10;
const RETRY_AFTER = 41;
const OWNER: IdentityRef = { type: 'user', id: 'owner-1' };
const BODY = { login: 'newcomer', email: 'newcomer@example.test', password: 'Newcomer-Pass-6789' };
const TAKEN = 'taken@example.test';

type Registration = { readonly login: string; readonly email: string; readonly password: string };

/** A taken address answers exists with OWNER, any other creates `created-<n>`. */
class StubRegistrar extends IdentityRegistrar {
  public readonly calls: { data: Registration; ctx: AuthnContext }[] = [];
  public refuse?: Error;

  public async register(data: Registration, ctx: AuthnContext) {
    this.calls.push({ data, ctx });
    if (this.refuse) throw this.refuse;
    return data.email === TAKEN ? ({ status: 'exists', id: OWNER } as const) : ({ status: 'created', id: { type: 'user', id: `created-${this.calls.length}` } } as const);
  }
}

class StubPasswords extends PasswordService {
  public readonly checks: { password: string; context?: PasswordPolicyContext }[] = [];
  public readonly verifications: { id: IdentityRef; ctx: AuthnContext }[] = [];
  public readonly notified: { id: IdentityRef; ctx: AuthnContext }[] = [];
  public violations: PasswordViolation[] = [];
  public failMail = false;

  public async check(password: string, context?: PasswordPolicyContext): Promise<readonly PasswordViolation[]> {
    this.checks.push({ password, ...(context ? { context } : {}) });
    return this.violations;
  }

  public async requestVerification(id: IdentityRef, ctx: AuthnContext) {
    this.verifications.push({ id, ctx });
    if (this.failMail) throw new Error('mail queue down');
    return { status: 'accepted' } as const;
  }

  public async notifyAccountExists(id: IdentityRef, ctx: AuthnContext): Promise<void> {
    this.notified.push({ id, ctx });
    if (this.failMail) throw new Error('mail queue down');
  }

  public policy(): PasswordPolicy {
    return { minLength: 8, maxLength: 128 };
  }

  public change(): never {
    throw new Error('not used');
  }
  public requestReset(): never {
    throw new Error('not used');
  }
  public redeemReset(): never {
    throw new Error('not used');
  }
  public invite(): never {
    throw new Error('not used');
  }
  public set(): never {
    throw new Error('not used');
  }
  public expire(): never {
    throw new Error('not used');
  }
}

/** Allows FREE attempts per flow and key, then refuses. */
class CountingThrottle extends AuthnThrottle {
  public readonly attempts: { keys: readonly ThrottleKey[]; flow: ThrottleFlow }[] = [];
  private readonly counts = new Map<string, number>();

  public async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    this.attempts.push({ keys, flow });
    const ids = keys.map((k) => `${flow}|${k.kind}|${k.value}`);
    if (ids.some((id) => (this.counts.get(id) ?? 0) >= FREE)) return { allowed: false, retryAfterSeconds: RETRY_AFTER };
    ids.forEach((id) => this.counts.set(id, (this.counts.get(id) ?? 0) + 1));
    return { allowed: true };
  }

  public async succeed(): Promise<void> {
    throw new Error('a registration has nothing to clear');
  }
}

interface World {
  readonly controller: AuthnRegistrationController;
  readonly registrar: StubRegistrar;
  readonly passwords: StubPasswords;
  readonly throttle: CountingThrottle;
  readonly events: AuthnEvent[];
  request(body: unknown, ip?: string): Request;
}

function world(config: Record<string, unknown> = { 'authn.http.registration.notifyExisting': true }): World {
  const registrar = new StubRegistrar();
  const passwords = new StubPasswords();
  const throttle = new CountingThrottle();
  const events: AuthnEvent[] = [];
  const audit = { publish: async (e: AuthnEvent) => void events.push(e) };
  const services = new Map<unknown, unknown>([
    [IdentityRegistrar, registrar],
    [PasswordService, passwords],
    [AuthnThrottle, throttle],
    [AuthnAudit, audit],
  ]);
  const container = { resolve: async (type: unknown) => services.get(type) } as unknown as IContainer;
  const controller = readingFrom(new AuthnRegistrationController(), fakeContainer(config));
  Object.assign(controller, { Container: container });
  Object.defineProperty(controller, '_log', { value: { warn: () => undefined } });

  const request = (body: unknown, ip: string = IP): Request => ({ body, headers: { 'user-agent': 'mocha' }, storage: { ClientIp: ip } }) as unknown as Request;
  return { controller, registrar, passwords, throttle, events, request };
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
  return {
    status: r._errorCode,
    body: r.responseData,
    noStore: headers.some((h) => h.Name === 'Cache-Control' && h.Value === 'no-store'),
    retryAfter: headers.find((h) => h.Name === 'Retry-After')?.Value,
  };
}

const ACCEPTED = { status: 202, body: { status: 'accepted' }, noStore: true };

describe('POST /auth/register (FEAT-4)', () => {
  describe('route table', () => {
    const descriptor = (): IControllerDescriptor => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AuthnRegistrationController.prototype) as IControllerDescriptor;

    it('mounts one anonymous POST route behind the IdentityRegistrar gate', () => {
      const d = descriptor();
      expect([...d.Routes.keys()]).to.deep.eq(['register']);
      expect(d.Routes.get('register')).to.include({ Type: RouteType.POST, Path: ROUTE });
      expect(d.Policies.map((group) => group.map((p) => p.Type))).to.deep.eq([[IdentityRegistrarRegistered]]);
      expect(d.Routes.get('register')!.Policies ?? [], 'no session and no principal').to.have.length(0);
    });
  });

  describe('gate', () => {
    const gateOver = (resolved: unknown, registered = true) => {
      const gate = new IdentityRegistrarRegistered();
      (gate as unknown as { Container: unknown }).Container = { hasRegistered: () => registered, resolve: async () => resolved };
      return gate.execute({} as Request, {} as never, {} as never);
    };

    it('answers 404 not_found while no IdentityRegistrar is registered', async () => {
      const err = await gateOver(undefined, false).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).to.deep.include({ error: 'not_found' });
    });

    it('answers 404 not_found while the registered one resolves to nothing (users.registration.enabled is off)', async () => {
      const err = await gateOver(null).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).to.deep.include({ error: 'not_found' });
    });

    it('lets a request through while a registrar resolves', async () => {
      await gateOver(new StubRegistrar());
    });
  });

  describe('a new address', () => {
    it('answers 202 { status: accepted } with no-store, and registers the login, email and password as given', async () => {
      const w = world();
      const res = answerOf(await callRoute(w.controller, 'register', w.request(BODY)));

      expect(res).to.deep.include(ACCEPTED);
      expect(w.registrar.calls).to.have.length(1);
      expect(w.registrar.calls[0].data).to.deep.eq(BODY);
      expect(w.registrar.calls[0].ctx).to.deep.include({ ip: IP, userAgent: 'mocha', purpose: 'request' });
    });

    it('requests one verification mail for the created account and no account-exists mail', async () => {
      const w = world();
      await callRoute(w.controller, 'register', w.request(BODY));

      expect(w.passwords.verifications.map((v) => v.id)).to.deep.eq([{ type: 'user', id: 'created-1' }]);
      expect(w.passwords.notified).to.have.length(0);
    });

    it('audits identity.register as a success of the new identity', async () => {
      const w = world();
      await callRoute(w.controller, 'register', w.request(BODY));

      expect(w.events).to.have.length(1);
      expect(w.events[0]).to.deep.include({ type: 'identity.register', outcome: 'success', identity: { type: 'user', id: 'created-1' }, ip: IP });
      expect(JSON.stringify(w.events)).to.not.contain(BODY.password);
    });

    it('still answers 202 when the verification mail cannot be requested', async () => {
      const w = world();
      w.passwords.failMail = true;
      expect(answerOf(await callRoute(w.controller, 'register', w.request(BODY)))).to.deep.include(ACCEPTED);
    });
  });

  describe('a taken address', () => {
    const taken = { ...BODY, email: TAKEN };

    it('answers exactly what a new address answers', async () => {
      const w = world();
      const created = answerOf(await callRoute(w.controller, 'register', w.request(BODY)));
      const exists = answerOf(await callRoute(w.controller, 'register', w.request(taken)));

      expect(exists).to.deep.eq(created);
    });

    it('requests one account-exists mail for the owner, and no verification mail', async () => {
      const w = world();
      await callRoute(w.controller, 'register', w.request(taken));

      expect(w.passwords.notified.map((n) => n.id)).to.deep.eq([OWNER]);
      expect(w.passwords.verifications).to.have.length(0);
    });

    it('sends no account-exists mail with authn.http.registration.notifyExisting false', async () => {
      const w = world({ 'authn.http.registration.notifyExisting': false });
      const res = answerOf(await callRoute(w.controller, 'register', w.request(taken)));

      expect(res).to.deep.include(ACCEPTED);
      expect(w.passwords.notified).to.have.length(0);
      expect(w.passwords.verifications).to.have.length(0);
    });

    it('audits identity.register as a failure with the reason exists', async () => {
      const w = world();
      await callRoute(w.controller, 'register', w.request(taken));

      expect(w.events[0]).to.deep.include({ type: 'identity.register', outcome: 'failure', reason: 'exists', identity: OWNER });
    });

    it('still answers 202 when the mail cannot be requested', async () => {
      const w = world();
      w.passwords.failMail = true;
      expect(answerOf(await callRoute(w.controller, 'register', w.request(taken)))).to.deep.include(ACCEPTED);
    });
  });

  describe('the password policy', () => {
    it('is checked with the login and the email as context, before the registrar is asked', async () => {
      const w = world();
      await callRoute(w.controller, 'register', w.request(BODY));

      expect(w.passwords.checks).to.deep.eq([{ password: BODY.password, context: { login: BODY.login, email: BODY.email } }]);
    });

    it('answers 400 password_rejected with the violations and registers nothing', async () => {
      const w = world();
      w.passwords.violations = ['too_short', 'similar_to_identifier'];
      const res = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, password: 'short' })));

      expect(res.status).to.eq(400);
      expect(res.body).to.deep.include({ error: 'password_rejected', violations: ['too_short', 'similar_to_identifier'] });
      expect(w.registrar.calls).to.have.length(0);
      expect(w.passwords.verifications).to.have.length(0);
    });

    it('refuses a password for a taken address the same way, so the refusal tells nothing about the account', async () => {
      const w = world();
      w.passwords.violations = ['too_short'];
      const fresh = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, password: 'short' })));
      const taken = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, email: TAKEN, password: 'short' })));

      expect(taken).to.deep.eq(fresh);
      expect(w.passwords.notified).to.have.length(0);
    });

    it('answers 400 password_rejected too_long for a password past the hard cap, without asking the service', async () => {
      const w = world();
      const res = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, password: 'x'.repeat(1025) })));

      expect(res.status).to.eq(400);
      expect(res.body).to.deep.include({ error: 'password_rejected', violations: ['too_long'] });
      expect(w.passwords.checks).to.have.length(0);
    });

    it('answers 400 password_mismatch when confirmPassword differs', async () => {
      const w = world();
      const res = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, confirmPassword: 'other' })));
      expect(res.status).to.eq(400);
      expect(res.body).to.deep.include({ error: 'password_mismatch' });
    });
  });

  describe('the body', () => {
    it('answers 400 and asks nobody for a missing, blank, non-string or over-long login or email', async () => {
      const w = world();
      const bad: unknown[] = [undefined, null, 'x', [], {}, { ...BODY, login: '' }, { ...BODY, login: 7 }, { ...BODY, login: 'x'.repeat(256) }, { ...BODY, email: '' }, { ...BODY, email: ['a@b.c'] }, { ...BODY, email: 'x'.repeat(255) }, { ...BODY, email: 'no-at-sign' }, { login: BODY.login, password: BODY.password }];
      for (const body of bad) {
        const res = answerOf(await callRoute(w.controller, 'register', w.request(body)));
        expect(res.status, JSON.stringify(body)).to.eq(400);
        expect(res.noStore).to.eq(true);
      }
      expect(w.registrar.calls).to.have.length(0);
      expect(w.passwords.checks).to.have.length(0);
    });

    it('answers each field its own code, in the order the route checks them, and an unknown field 400 invalid_field (D5)', async () => {
      const w = world();
      const codeOf = async (body: unknown) => (answerOf(await callRoute(w.controller, 'register', w.request(body))).body as { error?: unknown }).error;
      expect(await codeOf({ ...BODY, login: 7, email: 'no-at-sign' })).to.eq('invalid_login');
      expect(await codeOf({ ...BODY, email: 'no-at-sign', password: '' })).to.eq('invalid_email');
      expect(await codeOf({ ...BODY, password: 42 })).to.eq('invalid_password');
      expect(await codeOf({ ...BODY, confirmPassword: 42 })).to.eq('password_mismatch');
      expect(await codeOf({ ...BODY, captcha: 'x' })).to.eq('invalid_field');
      expect(w.registrar.calls).to.have.length(0);
    });

    it('answers 400 invalid_registration when the registrar refuses the input, naming the field and nothing else', async () => {
      const w = world();
      w.registrar.refuse = new InvalidArgument('Login __system__ is reserved', 'login');
      const res = answerOf(await callRoute(w.controller, 'register', w.request(BODY)));

      expect(res.status).to.eq(400);
      expect(res.body).to.deep.eq({ error: 'invalid_registration', message: 'the registration was refused', field: 'login' });
      expect(JSON.stringify(res.body)).to.not.contain(BODY.password);
    });

    it('does not swallow a failure of the registrar that is not about the input', async () => {
      const w = world();
      w.registrar.refuse = new Error('database down');
      let failure: unknown;
      try {
        await callRoute(w.controller, 'register', w.request(BODY));
      } catch (e) {
        failure = e;
      }
      expect(failure).to.be.instanceOf(Error).and.have.property('message', 'database down');
    });
  });

  describe('throttle', () => {
    it('counts each request in the register flow, keyed on the client ip and the address', async () => {
      const w = world();
      await callRoute(w.controller, 'register', w.request(BODY));
      await callRoute(w.controller, 'register', w.request({ ...BODY, email: 'Other@Example.test' }));

      expect(w.throttle.attempts).to.deep.eq([
        { keys: [{ kind: 'account', value: 'register:newcomer@example.test' }, { kind: 'ip', value: IP }], flow: 'register' },
        { keys: [{ kind: 'account', value: 'register:other@example.test' }, { kind: 'ip', value: IP }], flow: 'register' },
      ]);
    });

    it('answers 429 with Retry-After to the 11th request from one ip, registers nothing for it, and still serves another ip', async () => {
      const w = world();
      for (let i = 0; i < FREE; i++) {
        expect(answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, email: `n${i}@example.test` }))).status, `request ${i + 1}`).to.eq(202);
      }
      const refused = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, email: 'late@example.test' })));

      expect(refused.status).to.eq(429);
      expect(refused.retryAfter).to.eq(String(RETRY_AFTER));
      expect(refused.noStore).to.eq(true);
      expect(refused.body).to.deep.include({ error: 'throttled' });
      expect(w.registrar.calls).to.have.length(FREE);

      expect(answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, email: 'late@example.test' }, '192.0.2.99'))).status).to.eq(202);
    });

    it('keys an IPv6 client on its /64, so its addresses share one counter', async () => {
      const w = world();
      await callRoute(w.controller, 'register', w.request(BODY, '2001:db8::1'));
      await callRoute(w.controller, 'register', w.request({ ...BODY, email: 'v6@example.test' }, '2001:db8::ffff'));
      await callRoute(w.controller, 'register', w.request({ ...BODY, email: 'v6b@example.test' }, '2001:db8:0:1::1'));

      expect(w.throttle.attempts.map((a) => a.keys[1])).to.deep.eq([{ kind: 'ip', value: '2001:db8::/64' }, { kind: 'ip', value: '2001:db8::/64' }, { kind: 'ip', value: '2001:db8:0:1::/64' }]);
    });

    it('keeps the ip counter apart from the reset flow', async () => {
      const w = world();
      for (let i = 0; i < FREE; i++) await w.throttle.attempt([{ kind: 'ip', value: IP }], 'reset');
      expect((await w.throttle.attempt([{ kind: 'ip', value: IP }], 'reset')).allowed).to.eq(false);

      expect(answerOf(await callRoute(w.controller, 'register', w.request(BODY))).status).to.eq(202);
    });

    it('refuses an address that has used up its budget, from any ip', async () => {
      const w = world();
      for (let i = 0; i < FREE; i++) await callRoute(w.controller, 'register', w.request({ ...BODY, email: TAKEN }));

      const refused = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, email: TAKEN }, '192.0.2.50')));
      expect(refused.status).to.eq(429);
      expect(w.registrar.calls).to.have.length(FREE);
    });
  });
});
