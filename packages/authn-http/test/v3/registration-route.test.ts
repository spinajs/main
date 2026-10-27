import 'mocha';
import { expect } from 'chai';
import { CONTROLLED_DESCRIPTOR_SYMBOL, RouteType } from '@spinajs/http';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { IControllerDescriptor, Request } from '@spinajs/http';
import { AuthnAudit } from '@spinajs/authn';
import { AuthnThrottle, IdentityRegistrar, PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, IdentityRef, PasswordPolicy, PasswordPolicyContext, PasswordViolation, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';
import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext } from '@spinajs/hooks';
import { kitHooks } from '@spinajs/authn-testing';

import { IdentityRegistrarRegistered } from '../../src/policies/v3/groups.js';
import { AuthnRegistrationController } from '../../src/v3/controllers/AuthnRegistrationController.js';
import { RegistrationMailHook } from '../../src/v3/registration-mail-hook.js';
import { callRoute } from '../support/route-call.js';
import { fakeContainer, readingFrom } from '@spinajs/testing';

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

/** Records each `authn.registration` after call, as an application hook would see it. */
class Recorder extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['authn.registration'];
  readonly outputs: unknown[] = [];
  after(ctx: AfterContext<ActionName>): void {
    this.outputs.push(ctx.output);
  }
}

interface World {
  readonly controller: AuthnRegistrationController;
  readonly mail: RegistrationMailHook;
  readonly warnings: unknown[];
  readonly registrar: StubRegistrar;
  readonly passwords: StubPasswords;
  readonly throttle: CountingThrottle;
  readonly events: AuthnEvent[];
  request(body: unknown, ip?: string): Request;
}

/** `hooks`: the hooks the route runs besides the registration mail hook; `mail: false` leaves that out. */
async function world(config: Record<string, unknown> = { 'authn.http.registration.notifyExisting': true }, opts: { hooks?: ActionHook[]; mail?: boolean } = {}): Promise<World> {
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
  const warnings: unknown[] = [];
  const mail = readingFrom(new RegistrationMailHook(), fakeContainer(config));
  Object.assign(mail, { Container: container });
  Object.defineProperty(mail, 'Log', { value: { warn: (...args: unknown[]) => void warnings.push(args) } });
  const hooks = await kitHooks([...(opts.mail === false ? [] : [mail]), ...(opts.hooks ?? [])]);
  const controller = readingFrom(new AuthnRegistrationController(), fakeContainer(config));
  Object.assign(controller, { Container: container, Hooks: hooks });
  Object.defineProperty(controller, '_log', { value: { warn: () => undefined } });

  const request = (body: unknown, ip: string = IP): Request => ({ body, headers: { 'user-agent': 'mocha' }, storage: { ClientIp: ip } }) as unknown as Request;
  return { controller, mail, warnings, registrar, passwords, throttle, events, request };
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
      const w = await world();
      const res = answerOf(await callRoute(w.controller, 'register', w.request(BODY)));

      expect(res).to.deep.include(ACCEPTED);
      expect(w.registrar.calls).to.have.length(1);
      expect(w.registrar.calls[0].data).to.deep.eq(BODY);
      expect(w.registrar.calls[0].ctx).to.deep.include({ ip: IP, userAgent: 'mocha', purpose: 'request' });
    });

    it('requests one verification mail for the created account and no account-exists mail', async () => {
      const w = await world();
      await callRoute(w.controller, 'register', w.request(BODY));

      expect(w.passwords.verifications.map((v) => v.id)).to.deep.eq([{ type: 'user', id: 'created-1' }]);
      expect(w.passwords.notified).to.have.length(0);
    });

    it('audits identity.register as a success of the new identity', async () => {
      const w = await world();
      await callRoute(w.controller, 'register', w.request(BODY));

      expect(w.events).to.have.length(1);
      expect(w.events[0]).to.deep.include({ type: 'identity.register', outcome: 'success', identity: { type: 'user', id: 'created-1' }, ip: IP });
      expect(JSON.stringify(w.events)).to.not.contain(BODY.password);
    });

    it('still answers 202 when the verification mail cannot be requested', async () => {
      const w = await world();
      w.passwords.failMail = true;
      expect(answerOf(await callRoute(w.controller, 'register', w.request(BODY)))).to.deep.include(ACCEPTED);
    });
  });

  describe('a taken address', () => {
    const taken = { ...BODY, email: TAKEN };

    it('answers exactly what a new address answers', async () => {
      const w = await world();
      const created = answerOf(await callRoute(w.controller, 'register', w.request(BODY)));
      const exists = answerOf(await callRoute(w.controller, 'register', w.request(taken)));

      expect(exists).to.deep.eq(created);
    });

    it('requests one account-exists mail for the owner, and no verification mail', async () => {
      const w = await world();
      await callRoute(w.controller, 'register', w.request(taken));

      expect(w.passwords.notified.map((n) => n.id)).to.deep.eq([OWNER]);
      expect(w.passwords.verifications).to.have.length(0);
    });

    it('sends no account-exists mail with authn.http.registration.notifyExisting false', async () => {
      const w = await world({ 'authn.http.registration.notifyExisting': false });
      const res = answerOf(await callRoute(w.controller, 'register', w.request(taken)));

      expect(res).to.deep.include(ACCEPTED);
      expect(w.passwords.notified).to.have.length(0);
      expect(w.passwords.verifications).to.have.length(0);
    });

    it('audits identity.register as a failure with the reason exists', async () => {
      const w = await world();
      await callRoute(w.controller, 'register', w.request(taken));

      expect(w.events[0]).to.deep.include({ type: 'identity.register', outcome: 'failure', reason: 'exists', identity: OWNER });
    });

    it('still answers 202 when the mail cannot be requested', async () => {
      const w = await world();
      w.passwords.failMail = true;
      expect(answerOf(await callRoute(w.controller, 'register', w.request(taken)))).to.deep.include(ACCEPTED);
    });
  });

  describe('the mails: RegistrationMailHook, an after hook on authn.registration', () => {
    const taken = { ...BODY, email: TAKEN };

    it('is registered as an ActionHook by loading the route', () => {
      expect(DI.RootContainer.getRegisteredTypes(ActionHook) ?? []).to.include(RegistrationMailHook);
    });

    it('watches only authn.registration and defines only an after phase', () => {
      const hook = new RegistrationMailHook();
      expect([...hook.actions]).to.deep.eq(['authn.registration']);
      expect(hook.order).to.eq(0);
      expect((hook as Partial<ActionHook>).before).to.eq(undefined);
      expect((hook as Partial<ActionHook>).failed).to.eq(undefined);
    });

    it('without it the route mails nobody and answers the same 202 for a new and a taken address', async () => {
      const w = await world(undefined, { mail: false });
      const created = answerOf(await callRoute(w.controller, 'register', w.request(BODY)));
      const exists = answerOf(await callRoute(w.controller, 'register', w.request(taken)));

      expect(created).to.deep.include(ACCEPTED);
      expect(exists).to.deep.eq(created);
      expect(w.passwords.verifications).to.have.length(0);
      expect(w.passwords.notified).to.have.length(0);
      expect(w.events.map((e) => e.outcome)).to.deep.eq(['success', 'failure']);
    });

    it('takes one path for both outcomes: one send per registration, with the outcome an application hook sees too', async () => {
      const recorder = new Recorder();
      const w = await world(undefined, { hooks: [recorder] });
      const sent: unknown[] = [];
      const send = w.mail['send'].bind(w.mail);
      Object.assign(w.mail, {
        send: async (outcome: unknown, ctx: AuthnContext) => {
          sent.push(outcome);
          return send(outcome as never, ctx);
        },
      });
      await callRoute(w.controller, 'register', w.request(BODY));
      await callRoute(w.controller, 'register', w.request(taken));

      expect(sent).to.deep.eq([
        { status: 'created', id: { type: 'user', id: 'created-1' } },
        { status: 'exists', id: OWNER },
      ]);
      expect(recorder.outputs).to.deep.eq(sent);
      expect(w.passwords.verifications.map((v) => v.id)).to.deep.eq([{ type: 'user', id: 'created-1' }]);
      expect(w.passwords.notified.map((n) => n.id)).to.deep.eq([OWNER]);
    });

    it('passes the request context of the registration to the password service', async () => {
      const w = await world();
      await callRoute(w.controller, 'register', w.request(BODY));
      await callRoute(w.controller, 'register', w.request(taken));

      for (const { ctx } of [...w.passwords.verifications, ...w.passwords.notified]) expect(ctx).to.deep.include({ ip: IP, userAgent: 'mocha', purpose: 'request' });
    });

    it('mails nobody for a registration a before hook refused', async () => {
      const refusing = new (class extends ActionHook {
        readonly actions: readonly ActionPattern[] = ['authn.registration'];
        before(ctx: { refuse(code: string): never }): void {
          ctx.refuse('not-today');
        }
      })();
      const w = await world(undefined, { hooks: [refusing] });
      const res = answerOf(await callRoute(w.controller, 'register', w.request(BODY)));

      expect(res.status).to.eq(400);
      expect(w.registrar.calls).to.have.length(0);
      expect(w.passwords.verifications).to.have.length(0);
      expect(w.passwords.notified).to.have.length(0);
    });

    it('mails nobody when the registrar fails, and the error still reaches the caller', async () => {
      const w = await world();
      w.registrar.refuse = new Error('database down');
      let failure: unknown;
      try {
        await callRoute(w.controller, 'register', w.request(BODY));
      } catch (e) {
        failure = e;
      }
      expect(failure).to.be.instanceOf(Error).and.have.property('message', 'database down');
      expect(w.passwords.verifications).to.have.length(0);
    });

    it('logs a mail that cannot be requested by its class only, and the answer does not change', async () => {
      const w = await world();
      w.passwords.failMail = true;
      const created = answerOf(await callRoute(w.controller, 'register', w.request(BODY)));
      const exists = answerOf(await callRoute(w.controller, 'register', w.request(taken)));

      expect(created).to.deep.include(ACCEPTED);
      expect(exists).to.deep.eq(created);
      expect(w.warnings).to.have.length(2);
      expect(JSON.stringify(w.warnings)).to.contain('"errorName":"Error"');
      expect(JSON.stringify(w.warnings)).to.not.contain('mail queue down');
      expect(JSON.stringify(w.warnings)).to.not.contain(TAKEN);
    });
  });

  describe('the password policy', () => {
    it('is checked with the login and the email as context, before the registrar is asked', async () => {
      const w = await world();
      await callRoute(w.controller, 'register', w.request(BODY));

      expect(w.passwords.checks).to.deep.eq([{ password: BODY.password, context: { login: BODY.login, email: BODY.email } }]);
    });

    it('answers 400 password_rejected with the violations and registers nothing', async () => {
      const w = await world();
      w.passwords.violations = ['too_short', 'similar_to_identifier'];
      const res = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, password: 'short' })));

      expect(res.status).to.eq(400);
      expect(res.body).to.deep.include({ error: 'password_rejected', violations: ['too_short', 'similar_to_identifier'] });
      expect(w.registrar.calls).to.have.length(0);
      expect(w.passwords.verifications).to.have.length(0);
    });

    it('refuses a password for a taken address the same way, so the refusal tells nothing about the account', async () => {
      const w = await world();
      w.passwords.violations = ['too_short'];
      const fresh = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, password: 'short' })));
      const taken = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, email: TAKEN, password: 'short' })));

      expect(taken).to.deep.eq(fresh);
      expect(w.passwords.notified).to.have.length(0);
    });

    it('answers 400 password_rejected too_long for a password past the hard cap, without asking the service', async () => {
      const w = await world();
      const res = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, password: 'x'.repeat(1025) })));

      expect(res.status).to.eq(400);
      expect(res.body).to.deep.include({ error: 'password_rejected', violations: ['too_long'] });
      expect(w.passwords.checks).to.have.length(0);
    });

    it('answers 400 password_mismatch when confirmPassword differs', async () => {
      const w = await world();
      const res = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, confirmPassword: 'other' })));
      expect(res.status).to.eq(400);
      expect(res.body).to.deep.include({ error: 'password_mismatch' });
    });
  });

  describe('the body', () => {
    it('answers 400 and asks nobody for a missing, blank, non-string or over-long login or email', async () => {
      const w = await world();
      const bad: unknown[] = [undefined, null, 'x', [], {}, { ...BODY, login: '' }, { ...BODY, login: 7 }, { ...BODY, login: 'x'.repeat(256) }, { ...BODY, email: '' }, { ...BODY, email: ['a@b.c'] }, { ...BODY, email: 'x'.repeat(255) }, { ...BODY, email: 'no-at-sign' }, { login: BODY.login, password: BODY.password }];
      // One ip each: IpThrottle counts every refused body against its client's ip.
      for (const [i, body] of bad.entries()) {
        const res = answerOf(await callRoute(w.controller, 'register', w.request(body, `192.0.2.${100 + i}`)));
        expect(res.status, JSON.stringify(body)).to.eq(400);
        expect(res.noStore).to.eq(true);
      }
      expect(w.registrar.calls).to.have.length(0);
      expect(w.passwords.checks).to.have.length(0);
    });

    it('answers each field its own code, in the order the route checks them, and an unknown field 400 invalid_field (D5)', async () => {
      const w = await world();
      const codeOf = async (body: unknown) => (answerOf(await callRoute(w.controller, 'register', w.request(body))).body as { error?: unknown }).error;
      expect(await codeOf({ ...BODY, login: 7, email: 'no-at-sign' })).to.eq('invalid_login');
      expect(await codeOf({ ...BODY, email: 'no-at-sign', password: '' })).to.eq('invalid_email');
      expect(await codeOf({ ...BODY, password: 42 })).to.eq('invalid_password');
      expect(await codeOf({ ...BODY, confirmPassword: 42 })).to.eq('password_mismatch');
      expect(await codeOf({ ...BODY, captcha: 'x' })).to.eq('invalid_field');
      expect(w.registrar.calls).to.have.length(0);
    });

    it('answers 400 invalid_registration when the registrar refuses the input, naming the field and nothing else', async () => {
      const w = await world();
      w.registrar.refuse = new InvalidArgument('Login __system__ is reserved', 'login');
      const res = answerOf(await callRoute(w.controller, 'register', w.request(BODY)));

      expect(res.status).to.eq(400);
      expect(res.body).to.deep.eq({ error: 'invalid_registration', message: 'the registration was refused', field: 'login' });
      expect(JSON.stringify(res.body)).to.not.contain(BODY.password);
    });

    it('does not swallow a failure of the registrar that is not about the input', async () => {
      const w = await world();
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
      const w = await world();
      await callRoute(w.controller, 'register', w.request(BODY));
      await callRoute(w.controller, 'register', w.request({ ...BODY, email: 'Other@Example.test' }));

      expect(w.throttle.attempts).to.deep.eq([
        { keys: [{ kind: 'account', value: 'register:newcomer@example.test' }, { kind: 'ip', value: IP }], flow: 'register' },
        { keys: [{ kind: 'account', value: 'register:other@example.test' }, { kind: 'ip', value: IP }], flow: 'register' },
      ]);
    });

    it('answers 429 with Retry-After to the 11th request from one ip, registers nothing for it, and still serves another ip', async () => {
      const w = await world();
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
      const w = await world();
      await callRoute(w.controller, 'register', w.request(BODY, '2001:db8::1'));
      await callRoute(w.controller, 'register', w.request({ ...BODY, email: 'v6@example.test' }, '2001:db8::ffff'));
      await callRoute(w.controller, 'register', w.request({ ...BODY, email: 'v6b@example.test' }, '2001:db8:0:1::1'));

      expect(w.throttle.attempts.map((a) => a.keys[1])).to.deep.eq([{ kind: 'ip', value: '2001:db8::/64' }, { kind: 'ip', value: '2001:db8::/64' }, { kind: 'ip', value: '2001:db8:0:1::/64' }]);
    });

    it('keeps the ip counter apart from the reset flow', async () => {
      const w = await world();
      for (let i = 0; i < FREE; i++) await w.throttle.attempt([{ kind: 'ip', value: IP }], 'reset');
      expect((await w.throttle.attempt([{ kind: 'ip', value: IP }], 'reset')).allowed).to.eq(false);

      expect(answerOf(await callRoute(w.controller, 'register', w.request(BODY))).status).to.eq(202);
    });

    it('refuses an address that has used up its budget, from any ip', async () => {
      const w = await world();
      for (let i = 0; i < FREE; i++) await callRoute(w.controller, 'register', w.request({ ...BODY, email: TAKEN }));

      const refused = answerOf(await callRoute(w.controller, 'register', w.request({ ...BODY, email: TAKEN }, '192.0.2.50')));
      expect(refused.status).to.eq(429);
      expect(w.registrar.calls).to.have.length(FREE);
    });
  });
});
