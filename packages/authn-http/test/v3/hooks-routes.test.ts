/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the tamper tests write into hook inputs untyped, as a careless hook would */
/** The action hooks of the 3.0 routes (HOOK-3): each refusal's answer, and that a refused route changes nothing. */
import 'mocha';
import { expect } from 'chai';
import { TypedArray } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { Request } from '@spinajs/http';
import { Forbidden, InvalidArgument } from '@spinajs/exceptions';
import { ActionRefused } from '@spinajs/hooks';
import type { Hooks } from '@spinajs/hooks';
import { AuthnAudit, FreshAuthCheck } from '@spinajs/authn';
import { AuthnThrottle, IdentityRegistrar, KeyRegistry, PasskeyService, PasswordService, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, AuthnFacts, IdentityRef, Principal, Session } from '@spinajs/authn/contracts';
import { MemorySessionIssuer, ScriptedActionHook, generateKeyPair, kitHooks } from '@spinajs/authn-testing';

import { AuthnMiddleware } from '../../src/middleware/authn.js';
import { AuthnLogoutExtension } from '../../src/v3/logout-extension.js';
import { AuthnActiveRoleController } from '../../src/v3/controllers/AuthnActiveRoleController.js';
import { AuthnCodeLoginController } from '../../src/v3/controllers/AuthnCodeLoginController.js';
import { AuthnCredentialAdminController } from '../../src/v3/controllers/AuthnCredentialAdminController.js';
import { AuthnKeysController } from '../../src/v3/controllers/AuthnKeysController.js';
import { AuthnLoginController } from '../../src/v3/controllers/AuthnLoginController.js';
import { AuthnMfaEnrolmentController } from '../../src/v3/controllers/AuthnMfaEnrolmentController.js';
import { AuthnPasskeyController } from '../../src/v3/controllers/AuthnPasskeyController.js';
import { AuthnPasswordController } from '../../src/v3/controllers/AuthnPasswordController.js';
import { AuthnRegistrationController } from '../../src/v3/controllers/AuthnRegistrationController.js';
import { AuthnSessionsController } from '../../src/v3/controllers/AuthnSessionsController.js';
import { AuthnTokensController } from '../../src/v3/controllers/AuthnTokensController.js';
import { DEFAULT_LOGOUT_CLEAR_SITE_DATA } from '../../src/schema.js';
import { fakeContainer, readingFrom } from '../support/config-boot.js';

const CODE = 'not-today';
const TARGET_UUID = '0a1b2c3d-0000-4000-8000-000000000001';
const PASSWORD = 'Newcomer-Pass-6789';

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly cookies: readonly unknown[];
}

function answerOf(res: unknown): Answer {
  const r = res as { _errorCode: number; responseData: Record<string, unknown>; options?: { Headers?: { Name: string; Value: string }[]; Coockies?: unknown[] } };
  return { status: r._errorCode, body: r.responseData, headers: Object.fromEntries((r.options?.Headers ?? []).map((h) => [h.Name, h.Value])), cookies: r.options?.Coockies ?? [] };
}

function expectRefused(res: unknown, status: number, code = CODE): Answer {
  const a = answerOf(res);
  expect(a.status, JSON.stringify(a.body)).to.equal(status);
  expect(a.body.code).to.equal(code);
  return a;
}

const facts = (): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });

interface World {
  readonly hook: ScriptedActionHook;
  readonly hooks: Hooks;
  readonly sessions: MemorySessionIssuer;
  readonly events: AuthnEvent[];
  readonly services: Map<unknown, unknown>;
  readonly container: IContainer;
  readonly alice: IdentityRef;
  readonly session: Session;
  /** Gives `controller` the world's container, hooks and a config of `values`. */
  wire<T extends object>(controller: T, values?: Record<string, unknown>): T;
  request(body?: unknown, over?: Partial<{ session: Session | null; principal: Principal | null }>): Request;
}

async function world(): Promise<World> {
  const hook = new ScriptedActionHook();
  const hooks = await kitHooks([hook]);
  const sessions = new MemorySessionIssuer();
  const events: AuthnEvent[] = [];
  const audit = { publish: async (e: AuthnEvent) => void events.push(e), publishIn: async (_ctx: AuthnContext, e: AuthnEvent) => void events.push(e) };
  const services = new Map<unknown, unknown>([
    [AuthnAudit, audit],
    [FreshAuthCheck, { maxAgeSeconds: 300 }],
  ]);
  const container = {
    resolve: async (type: unknown) => {
      if (type instanceof TypedArray) return type.Type === AuthnLogoutExtension ? [] : [];
      if (!services.has(type)) throw new Error(`unexpected resolve of ${String((type as { name?: string })?.name ?? type)}`);
      return services.get(type);
    },
  } as unknown as IContainer;
  const alice: IdentityRef = { type: 'user', id: 'alice-1' };
  const handle = await sessions.issue(alice, facts());
  const session = (await sessions.restore(handle.id))!;
  const principal = { authenticated: true, type: 'user', id: alice.id, authn: { ...session.facts } } as unknown as Principal;

  const wire = <T extends object>(controller: T, values: Record<string, unknown> = {}): T => {
    readingFrom(controller, fakeContainer(values));
    Object.assign(controller, { Container: container, Hooks: hooks, Sessions: sessions });
    Object.defineProperty(controller, '_log', { value: { warn: () => undefined } });
    return controller;
  };
  const request = (body: unknown = {}, over: Partial<{ session: Session | null; principal: Principal | null }> = {}): Request =>
    ({
      body,
      method: 'POST',
      headers: { 'user-agent': 'mocha' },
      get: () => undefined,
      storage: { ClientIp: '192.0.2.7', AuthnSession: over.session === undefined ? session : over.session, AuthnPrincipal: over.principal === undefined ? principal : over.principal },
    }) as unknown as Request;
  return { hook, hooks, sessions, events, services, container, alice, session, wire, request };
}

describe('action hooks on the 3.0 routes', function () {
  this.timeout(20000);

  describe('POST /auth/logout', () => {
    function logout(w: World): AuthnLoginController {
      const controller = w.wire(new AuthnLoginController());
      Object.assign(controller, { _cfg: { Env: 'test', get: (_path: string, fallback?: unknown) => fallback } });
      Object.defineProperty(controller, 'Log', { value: { warn: () => undefined } });
      Object.defineProperty(controller, 'ClearSiteData', { value: DEFAULT_LOGOUT_CLEAR_SITE_DATA });
      return controller;
    }

    it('refused answers 403 { code }, the session still restores and no Clear-Site-Data or cleared cookie is sent', async () => {
      const w = await world();
      w.hook.refuse('authn.logout', CODE);
      const a = expectRefused(await logout(w).logout(w.request()), 403);
      expect(a.headers).to.not.have.property('Clear-Site-Data');
      expect(a.cookies).to.deep.equal([]);
      expect(await w.sessions.restore(w.session.handle.id)).to.not.equal(null);
      expect(w.events.map((e) => [e.type, e.outcome, e.reason])).to.deep.equal([['logout', 'failure', `hook:${CODE}`]]);
    });

    it('a hook writing the session handle in place still ends the session of the cookie', async () => {
      const w = await world();
      w.hook.tamper('authn.logout', (i) => {
        i.session.handle.id = 'forged';
      });
      expect(answerOf(await logout(w).logout(w.request())).status).to.equal(200);
      expect(await w.sessions.restore(w.session.handle.id)).to.equal(null);
      expect(w.hook.landed()).to.deep.equal([]);
    });

    it('without a refusal the session ends and the hook sees it once before and once after', async () => {
      const w = await world();
      expect(answerOf(await logout(w).logout(w.request())).status).to.equal(200);
      expect(await w.sessions.restore(w.session.handle.id)).to.equal(null);
      expect(w.hook.calls('authn.logout').map((c) => c.phase)).to.deep.equal(['before', 'after']);
    });
  });

  describe('session management', () => {
    it('DELETE /user/sessions/:handle refused answers 403 and the session is kept', async () => {
      const w = await world();
      const other = await w.sessions.issue(w.alice, facts());
      const [row] = (await w.sessions.list(w.alice, { current: w.session.handle })).filter((r) => r.current !== true);
      w.hook.refuse('authn.sessions.revoke', CODE);
      expectRefused(await w.wire(new AuthnSessionsController()).revoke(w.request(), row.handle), 403);
      expect(await w.sessions.restore(other.id)).to.not.equal(null);
      expect(w.hook.calls('authn.sessions.revoke')[0].input.handle).to.equal(row.handle);
    });

    it('DELETE /user/sessions refused answers 403 and every session is kept', async () => {
      const w = await world();
      const other = await w.sessions.issue(w.alice, facts());
      w.hook.refuse('authn.sessions.revoke', CODE);
      expectRefused(await w.wire(new AuthnSessionsController()).revokeOthers(w.request()), 403);
      expect(await w.sessions.restore(other.id)).to.not.equal(null);
      expect(w.hook.calls('authn.sessions.revoke')[0].input.handle).to.equal('others');
    });
  });

  describe('POST /auth/active-role', () => {
    it('refused answers 403 and the role and the session id are unchanged', async () => {
      const w = await world();
      const controller = w.wire(new AuthnActiveRoleController());
      Object.assign(controller, {
        Principals: { principalOf: async (id: IdentityRef) => ({ authenticated: true, type: id.type, id: id.id }) },
        Roles: { rolesOf: async () => [{ role: 'viewer', requirePassword: false }] },
      });
      w.hook.refuse('authn.role.switch', CODE);
      expectRefused(await controller.switch(w.request({ role: 'viewer' })), 403);
      const now = await w.sessions.restore(w.session.handle.id);
      expect(now, 'the id did not rotate').to.not.equal(null);
      expect(now!.activeRole).to.equal(undefined);
    });
  });

  describe('credential admin', () => {
    function admin(w: World, verdict: { ok: true } | { ok: false; code: 'forbidden' }) {
      const revoked: IdentityRef[] = [];
      const controller = w.wire(new AuthnCredentialAdminController());
      Object.assign(controller, {
        Guard: { allowed: async () => verdict },
        Sessions: {
          revokeAll: async (id: IdentityRef) => {
            revoked.push(id);
            return 1;
          },
        },
      });
      return { controller, revoked };
    }

    it('refused answers 403 after the guard allowed, and nothing is revoked', async () => {
      const w = await world();
      const { controller, revoked } = admin(w, { ok: true });
      w.hook.refuse('authn.admin.credentials', CODE);
      expectRefused(await controller.sessions(w.request(), TARGET_UUID), 403);
      expect(revoked).to.deep.equal([]);
      expect(w.hook.calls('authn.admin.credentials')[0].input).to.deep.include({ action: 'sessions', target: { type: 'user', id: TARGET_UUID } });
    });

    it('a hook writing the target or the actor in place does not move the effect', async () => {
      const w = await world();
      const { controller, revoked } = admin(w, { ok: true });
      w.hook.tamper('authn.admin.credentials', (i) => {
        i.target.id = 'someone-else';
        i.actor.id = 'someone-else';
      });
      expect(answerOf(await controller.sessions(w.request(), TARGET_UUID)).status).to.equal(200);
      expect(revoked).to.deep.equal([{ type: 'user', id: TARGET_UUID }]);
      expect(w.hook.landed()).to.deep.equal([]);
    });

    it('with the guard denying, the hook is not called', async () => {
      const w = await world();
      const { controller, revoked } = admin(w, { ok: false, code: 'forbidden' });
      const a = answerOf(await controller.sessions(w.request(), TARGET_UUID));
      expect(a.status).to.equal(403);
      expect(a.body.error).to.equal('forbidden');
      expect(revoked).to.deep.equal([]);
      expect(w.hook.calls()).to.deep.equal([]);
    });
  });

  describe('PATCH /user/password', () => {
    it("a { status: 'refused', code } of the PasswordService answers 400 { code }", async () => {
      const w = await world();
      const controller = w.wire(new AuthnPasswordController());
      Object.assign(controller, { Passwords: { change: async () => ({ status: 'refused', code: CODE }) } });
      expectRefused(await controller.change(w.request({ oldPassword: 'Old-Password-1', password: 'New-Password-2' })), 400);
    });
  });

  describe('POST /auth/register', () => {
    class Registrar extends IdentityRegistrar {
      public readonly calls: { login: string; email: string }[] = [];
      public refuse?: Error;
      public async register(data: { login: string; email: string; password: string }) {
        if (this.refuse) throw this.refuse;
        if (!/^[^\s@]+@[^\s@]+$/.test(data.email)) throw new InvalidArgument('email is not an address', 'email');
        this.calls.push({ login: data.login, email: data.email });
        return { status: 'created', id: { type: 'user', id: 'new-1' } } as const;
      }
    }

    async function registration() {
      const w = await world();
      const registrar = new Registrar();
      const verifications: IdentityRef[] = [];
      w.services.set(IdentityRegistrar, registrar);
      w.services.set(AuthnThrottle, { attempt: async () => ({ allowed: true }) });
      w.services.set(PasswordService, { check: async () => [], requestVerification: async (id: IdentityRef) => void verifications.push(id) });
      const controller = w.wire(new AuthnRegistrationController(), { 'authn.http.registration.notifyExisting': true });
      const register = (body: Record<string, unknown>) => controller.register(w.request({ login: 'newcomer', email: 'newcomer@example.test', password: PASSWORD, ...body }, { session: null, principal: null }));
      return { w, registrar, verifications, register };
    }

    it('refused answers 400 { code } and registers nothing', async () => {
      const { w, registrar, verifications, register } = await registration();
      w.hook.refuse('authn.registration', CODE);
      expectRefused(await register({}), 400);
      expect(registrar.calls).to.deep.equal([]);
      expect(verifications).to.deep.equal([]);
    });

    // The route refuses an address with spaces before any hook runs, so the hook normalises the case instead.
    it('a hook that normalises the email makes the registrar see the normalised value', async () => {
      const { w, registrar, register } = await registration();
      w.hook.mutate('authn.registration', (input) => ({ email: String(input.email).trim().toLowerCase() }));
      expect(answerOf(await register({ email: 'Newcomer@Example.TEST' })).status).to.equal(202);
      expect(registrar.calls).to.deep.equal([{ login: 'newcomer', email: 'newcomer@example.test' }]);
    });

    for (const [label, refusal] of [
      ['a refused authn.password.set inside the registrar', () => new ActionRefused('authn.password.set', CODE)],
      ['the InvalidArgument users makes of a refused set', () => new InvalidArgument('Password does not meet requirements', 'password')],
    ] as const) {
      it(`${label} answers the accepted 202 of a taken address, and the audit tells`, async () => {
        const { w, registrar, verifications, register } = await registration();
        registrar.refuse = refusal();
        const a = answerOf(await register({}));
        expect(a.status).to.equal(202);
        expect(a.body).to.deep.equal({ status: 'accepted' });
        expect(verifications).to.deep.equal([]);
        expect(w.events.some((e) => e.type === 'identity.register' && e.outcome === 'failure')).to.equal(true);
      });
    }

    it("an invalid email set by a hook is refused by the registrar's own validation", async () => {
      const { w, registrar, register } = await registration();
      w.hook.mutate('authn.registration', { email: 'not-an-address' });
      const a = answerOf(await register({}));
      expect(a.status).to.equal(400);
      expect(a.body.error).to.equal('invalid_registration');
      expect(registrar.calls).to.deep.equal([]);
    });
  });

  describe('POST /auth/code/request', () => {
    it('refused answers the accepted body and sends nothing', async () => {
      const w = await world();
      const requested: string[] = [];
      const controller = w.wire(new AuthnCodeLoginController());
      Object.assign(controller, { Passwords: { requestCode: async (login: string) => (requested.push(login), { status: 'accepted' }) } });
      w.hook.refuse('authn.code.request', CODE);
      const a = answerOf(await controller.request(w.request({ login: 'alice@example.test' }, { session: null, principal: null })));
      expect(a.status).to.equal(202);
      expect(a.body).to.deep.equal({ Ok: true });
      expect(requested).to.deep.equal([]);
    });
  });

  describe('services that refuse through their hooks', () => {
    it('POST /user/passkeys answers 403 { code } when the PasskeyService throws ActionRefused', async () => {
      const w = await world();
      w.services.set(PasskeyService, {
        register: async () => {
          throw new ActionRefused('authn.passkey.register', CODE);
        },
      });
      expectRefused(await w.wire(new AuthnPasskeyController()).register(w.request({ challengeId: 'c-1', response: { id: 'x' } })), 403);
    });

    it('DELETE /user/passkeys/:id answers 403 { code } when the PasskeyService throws ActionRefused', async () => {
      const w = await world();
      w.services.set(PasskeyService, {
        remove: async () => {
          throw new ActionRefused('authn.passkey.revoke', CODE);
        },
      });
      expectRefused(await w.wire(new AuthnPasskeyController()).remove(w.request(), 'cred-1'), 403);
    });

    it('POST /user/tokens answers 403 { code } when the TokenService throws ActionRefused', async () => {
      const w = await world();
      w.services.set(TokenService, {
        create: async () => {
          throw new ActionRefused('authn.token.create', CODE);
        },
      });
      expectRefused(await w.wire(new AuthnTokensController()).create(w.request({ name: 'ci', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })), 403);
    });

    it('a refusal of another action than the route runs is not answered as the route refusal', async () => {
      const w = await world();
      w.services.set(TokenService, {
        create: async () => {
          throw new ActionRefused('users.create', CODE);
        },
      });
      const err = await w
        .wire(new AuthnTokensController())
        .create(w.request({ name: 'ci', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).to.be.instanceOf(ActionRefused);
    });

    it('DELETE /user/tokens/:uuid answers 403 { code } when the TokenService throws ActionRefused', async () => {
      const w = await world();
      w.services.set(TokenService, {
        revoke: async () => {
          throw new ActionRefused('authn.token.revoke', CODE);
        },
      });
      expectRefused(await w.wire(new AuthnTokensController()).revoke(w.request(), 'token-1'), 403);
    });

    it("POST /user/keys answers 403 { code } for a { code: 'refused' } of the KeyRegistry", async () => {
      const w = await world();
      w.services.set(KeyRegistry, { register: async () => ({ ok: false, code: 'refused', refusal: CODE }) });
      const jwk = generateKeyPair('EdDSA').publicJwk;
      expectRefused(await w.wire(new AuthnKeysController()).register(w.request({ jwk, proof: { challengeId: 'c-1', signature: 's-1' } })), 403);
    });

    it('POST /user/mfa answers 403 { code } when the MfaEnrolmentService throws ActionRefused', async () => {
      const w = await world();
      const controller = w.wire(new AuthnMfaEnrolmentController());
      Object.assign(controller, {
        MfaEnrolment: {
          begin: async () => {
            throw new ActionRefused('authn.mfa.enrol.begin', CODE);
          },
        },
      });
      expectRefused(await controller.begin(w.request()), 403);
    });

    it('POST /authn/admin/users/:uuid/mfa-reset answers { reset: false } when the TotpService refused it', async () => {
      const w = await world();
      const controller = w.wire(new AuthnCredentialAdminController());
      Object.assign(controller, { Guard: { allowed: async () => ({ ok: true }) }, MfaEnrolment: { adminReset: async () => ({ reset: false }) } });
      const a = answerOf(await controller.mfaReset(w.request(), TARGET_UUID));
      expect(a.status).to.equal(200);
      expect(a.body).to.deep.equal({ reset: false });
    });
  });

  describe('authn.request', () => {
    async function authenticate(w: World, values: Record<string, unknown>, seen: { req?: Request } = {}): Promise<unknown> {
      const principal = { authenticated: true, type: 'user', id: 'alice-1', ceiling: { roles: ['viewer'] } };
      const middleware = readingFrom(new AuthnMiddleware(), fakeContainer(values));
      Object.assign(middleware, { Container: w.container, Hooks: w.hooks, Sessions: w.sessions, Extractors: [], Resolvers: [{ order: 0, resolve: async () => principal }] });
      Object.defineProperty(middleware, 'Log', { value: { warn: () => undefined } });
      const req = { method: 'GET', originalUrl: '/api/things', headers: {}, rawHeaders: [], storage: { ClientIp: '192.0.2.7' } } as unknown as Request;
      seen.req = req;
      return (middleware as unknown as { authenticate(req: Request, res: unknown): Promise<void> }).authenticate(req, { setHeader: () => undefined }).then(
        () => null,
        (e: unknown) => e,
      );
    }

    it('is off by default: the hook is not called', async () => {
      const w = await world();
      w.hook.refuse('authn.request', CODE);
      expect(await authenticate(w, {})).to.equal(null);
      expect(w.hook.calls('authn.request')).to.deep.equal([]);
    });

    it('on, a refusal answers 403 { code }', async () => {
      const w = await world();
      w.hook.refuse('authn.request', CODE);
      const err = await authenticate(w, { 'authn.http.hooks.request': true });
      expect(err).to.be.instanceOf(Forbidden);
      expect((err as { code?: unknown }).code).to.equal(CODE);
      expect(w.hook.calls('authn.request')[0].input).to.deep.include({ method: 'GET', path: '/api/things', ip: '192.0.2.7' });
    });

    it('on, a hook cannot drop the ceiling or change the id of the principal the request gets', async () => {
      const w = await world();
      w.hook.tamper('authn.request', (i) => {
        delete i.principal.ceiling;
        i.principal.id = 'someone-else';
      });
      const seen: { req?: Request } = {};
      expect(await authenticate(w, { 'authn.http.hooks.request': true }, seen)).to.equal(null);
      expect(seen.req!.storage.AuthnPrincipal).to.deep.include({ id: 'alice-1', ceiling: { roles: ['viewer'] } });
      expect(w.hook.landed()).to.deep.equal([]);
    });

    it('on, a request the hooks allow gets its principal', async () => {
      const w = await world();
      expect(await authenticate(w, { 'authn.http.hooks.request': true })).to.equal(null);
      expect(w.hook.calls('authn.request').map((c) => c.phase)).to.deep.equal(['before', 'after']);
    });
  });
});
