import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { Container } from '@spinajs/di';
import type { IController, IRoute, Request } from '@spinajs/http';
import { CredentialAdminGuard, SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { FakeClock, parseOtpauth, totpFromProvisioning } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HttpRequest, HttpResponse } from '@spinajs/authn-testing';

import { AdminMfaResetOn, CredentialAdminGuardRegistered, SessionIssuerRegistered, adminTotpServiceOf } from '../../../src/admin/gate.js';
import { PASSWORD_HARD_CAP } from '../../../src/v3/index.js';
import { readingFrom } from '../../support/config-boot.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { Client, clearLog, events, loggedIn, logLines, seedUser, throttle } from '../app.js';
import { ROUTES } from '../behaviour/harness.js';
import { ADMIN_ROUTES, MFA_ROUTES, PASSWORD_ROUTES, laneAdminGuardCalls, laneEvents, laneMfaConfig, n8bHarness } from '../behaviour/n8b-harness.js';
import { LaneClient, expectFailureBody, expectRefused, later } from './mfa-enrolment.js';
import { mountedRoutes } from './route-table.js';

export const ADMIN_ROUTES_V3 = ['POST /authn/admin/users/:uuid/password-reset', 'POST /authn/admin/users/:uuid/mfa-reset', 'DELETE /authn/admin/users/:uuid/sessions', 'DELETE /authn/admin/users/:uuid/tokens'];

type AdminRoute = 'adminPasswordReset' | 'adminMfaReset' | 'adminSessionsRevoke' | 'adminTokensRevoke';
const ROUTE_NAMES: readonly AdminRoute[] = ['adminPasswordReset', 'adminMfaReset', 'adminSessionsRevoke', 'adminTokensRevoke'];

/** The guard's action of each route. */
const ACTION: Record<AdminRoute, string> = { adminPasswordReset: 'password-reset', adminMfaReset: 'mfa-reset', adminSessionsRevoke: 'sessions', adminTokensRevoke: 'tokens' };

/** Events that only an effect of an admin route publishes. */
const EFFECTS = ['password.change', 'password.reset.request', 'mfa.disable', 'session.revoke', 'token.revoke'];

const DAY = 86_400_000;

const body = <T = Record<string, unknown>>(res: HttpResponse): T => res.body as T;

const request = (route: AdminRoute, target: IdentityRef, payload?: unknown): HttpRequest => ({ ...ADMIN_ROUTES[route]!(target), ...(payload !== undefined ? { body: payload } : {}) });

const pathOf = (route: AdminRoute, id: string): string => ADMIN_ROUTES[route]!({ type: 'user', id }).path;

/** The four routes in the shared app, which registers no CredentialAdminGuard. */
export function credentialAdminGateSuite(): void {
  const target = { type: 'user', id: randomUUID() };

  it('without a CredentialAdminGuard every admin route answers 404 not_found, also to a session', async () => {
    const anonymous = new Client();
    const session = await loggedIn(await seedUser());
    for (const c of [anonymous, session]) {
      for (const route of ROUTE_NAMES) {
        const { method, path } = ADMIN_ROUTES[route]!(target);
        const res = await c.send(method as 'POST' | 'DELETE', path, {});
        expect(res.status, `${method} ${path}`).to.eq(404);
        expect(res.body.error, `${method} ${path}`).to.eq('not_found');
      }
    }
  });

  it('a session sending reauthPassword to a closed group re-authenticates nothing and touches no throttle', async () => {
    const u = await seedUser();
    const session = await loggedIn(u);
    const mark = { attempts: throttle.attempts.length, events: events.all().length };
    for (const route of ROUTE_NAMES) {
      const { method, path } = ADMIN_ROUTES[route]!(target);
      expect((await session.send(method as 'POST' | 'DELETE', path, { reauthPassword: u.password })).status).to.eq(404);
    }
    expect(throttle.attempts.slice(mark.attempts)).to.deep.eq([]);
    expect(events.all().slice(mark.events)).to.deep.eq([]);
  });

  it('the gates ask the container they resolve from', async () => {
    const route = {} as IRoute;
    const ctrl = {} as IController;
    const req = { storage: {} } as unknown as Request;
    for (const [Gate, Hook] of [
      [CredentialAdminGuardRegistered, CredentialAdminGuard],
      [SessionIssuerRegistered, SessionIssuer],
    ] as const) {
      const empty = new Container();
      const gate = new Gate();
      (gate as unknown as { Container: unknown }).Container = empty;
      expect(gate.isEnabled(route, ctrl)).to.eq(true);
      await gate.execute(req, route, ctrl).then(
        () => expect.fail(`${Gate.name} passed without a ${Hook.name}`),
        (e: { constructor: { name: string }; error?: unknown }) => {
          expect(e.constructor.name).to.eq('ResourceNotFound');
          expect(e.error).to.eq('not_found');
        },
      );
      const child = empty.child();
      child.register({ [`Stub${Hook.name}`]: () => ({}) }[`Stub${Hook.name}`]).as(Hook as never);
      (gate as unknown as { Container: unknown }).Container = child;
      await gate.execute(req, route, ctrl);
    }
  });

  it('the MFA reset gate is closed without the TOTP service or the key, and names its own route', async () => {
    const route = {} as IRoute;
    const ctrl = {} as IController;
    const req = { storage: {} } as unknown as Request;
    for (const key of [undefined, 'ab'.repeat(32)]) {
      const empty = new Container();
      const gate = readingFrom(new AdminMfaResetOn(), empty);
      (gate as unknown as { Container: unknown; MfaEncryptionKey: unknown }).Container = empty;
      Object.defineProperty(gate, 'MfaEncryptionKey', { value: key });
      await gate.execute(req, route, ctrl).then(
        () => expect.fail('the MFA reset gate passed'),
        (e: { constructor: { name: string }; error?: unknown; message?: string }) => {
          expect(e.constructor.name).to.eq('ResourceNotFound');
          expect(e.error).to.eq('not_found');
          expect(e.message).to.eq('the admin MFA reset route is off');
        },
      );
      await adminTotpServiceOf(empty, key).then(
        () => expect.fail('adminTotpServiceOf found a service'),
        (e: { error?: unknown }) => expect(e.error).to.eq('not_found'),
      );
    }
  });
}

let users = 0;

/** The routes over authn-local, authn-totp, authn-token, authn-session and N1, behind the lane's CredentialAdminGuard. */
export function credentialAdminRoutesSuite(): void {
  let h: Harness;

  const open = async (config: ConfigOverrides = {}) => {
    h = await n8bHarness({ rule: 'A25', facet: 'A25/http', caseName: 'lane', clock: new FakeClock(), config });
    clearLog();
  };

  afterEach(async () => {
    await h?.dispose?.();
  });

  const user = async () => {
    users++;
    const login = `admin-lane-${users}@example.test`;
    const password = `Admin-Lane-Pass-${users}`;
    return { ref: await h.seed!.user({ login, password }), login, password };
  };

  const login = async (u: { login: string; password: string }) => {
    const c = new LaneClient(h);
    const res = await c.send(ROUTES.login!(u.login, u.password));
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    return c;
  };

  /** An admin with or without users:credentials, signed in now. */
  const admin = async (credentialsRight = true) => {
    const a = await h.actors!.admin({ credentialsRight });
    return { ...a, c: await login(a) };
  };

  const principalId = async (c: LaneClient): Promise<string | null> => {
    const res = await c.send({ method: 'GET', path: `/${AUTHN_PROBE_PATH}` });
    return res.status === 200 ? body<{ principal: { id: string } | null }>(res).principal?.id ?? null : null;
  };

  const mint = async (owner: IdentityRef) => {
    const t = await h.tokens!.create(owner, { name: 'admin lane', kind: 'pat', expiresAt: new Date(Date.now() + DAY) }, { now: new Date(), purpose: 'request' });
    if (!t.ok) throw new Error(`token create: ${t.code}`);
    return t.plaintext;
  };

  const tokenOk = async (raw: string) => (await h.tokens!.validate(raw, { now: new Date(), purpose: 'request' })).ok;

  const effects = () => laneEvents.filter((e) => EFFECTS.includes(e.type));

  /**
   * A target with two sessions, a token and a TOTP enrolment; `untouched()` checks that none of it changed and that no
   * effect was audited or mailed.
   */
  const armed = async () => {
    const t = await user();
    const sessions = [await login(t), await login(t)];
    const token = await mint(t.ref);
    await h.mfa!.enrol(t.ref);
    return {
      ...t,
      sessions,
      async untouched() {
        for (const s of sessions) expect(await principalId(s), "the target's session is alive").to.eq(t.ref.id);
        expect(await tokenOk(token), "the target's token is valid").to.eq(true);
        expect(await h.mfa!.step.enrolled(t.ref), 'the target is still enrolled').to.eq(true);
        expect(effects(), 'no effect was audited').to.deep.eq([]);
        expect(await h.outbox!.secretFor(t.ref, 'reset'), 'no reset mail').to.eq(null);
        // Last: a login with an enrolled factor opens a pending session, which ends nothing.
        expect((await new LaneClient(h).send(ROUTES.login!(t.login, t.password))).status, "the target's password works").to.eq(200);
      },
    };
  };

  describe('allowed calls', () => {
    beforeEach(async () => {
      await open();
      await h.targetGuard!.allowAll();
    });

    it('a password reset leaves the old password unusable, ends every session of the target (its impersonations included) and every token, and mails the owner a reset', async () => {
      await h.guard!.allowAll();
      const bob = await user();
      const carol = await user();
      const bobs = [await login(bob), await login(bob)];
      const token = await mint(bob.ref);
      // Bob impersonates Carol from an aal2 session.
      await h.mfa!.enrol(bob.ref);
      const impersonating = await login(bob);
      await later(30, async () => expect((await impersonating.send(ROUTES.mfaVerify!(await h.mfa!.code(bob.ref)))).status).to.eq(200));
      expect((await impersonating.send(ROUTES.impersonateStart!(carol.ref, bob.password))).status).to.eq(200);
      expect(await principalId(impersonating)).to.eq(carol.ref.id);
      const a = await admin();

      const res = await a.c.send(request('adminPasswordReset', bob.ref));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body).to.deep.eq({ expired: true, resetMailRequested: true });
      expect(res.headers['cache-control']).to.eq('no-store');
      for (const s of [...bobs, impersonating]) expect(await principalId(s)).to.eq(null);
      expect(await tokenOk(token)).to.eq(false);
      expect((await new LaneClient(h).send(ROUTES.login!(bob.login, bob.password))).status, 'the old password').to.eq(401);
      expect(await principalId(a.c), "the admin's own session").to.eq(a.ref.id);

      const changed = laneEvents.find((e) => e.type === 'password.change');
      expect(changed).to.deep.include({ outcome: 'success', identity: bob.ref, actor: { type: 'user', id: a.ref.id } });
      expect(changed?.data).to.deep.eq({ cause: 'admin', expired: true });
      expect(laneEvents.filter((e) => e.type === 'token.revoke').map((e) => e.actor?.id)).to.deep.eq([a.ref.id]);
      expect(laneAdminGuardCalls().map((x) => ({ actor: x.actor.id, target: x.target, action: x.action }))).to.deep.eq([{ actor: a.ref.id, target: bob.ref, action: 'password-reset' }]);

      const secret = await h.outbox!.secretFor(bob.ref, 'reset');
      expect(secret, 'the owner got a reset mail').to.be.a('string');
      const seen = [JSON.stringify(a.c.answers.map((r) => [r.body, r.headers, r.setCookie])), logLines().join('\n'), JSON.stringify(laneEvents), JSON.stringify(h.events!.all())].join('\n');
      expect(seen).to.not.include(secret!);
      // The owner's way back in.
      const next = 'Admin-Lane-Next-1';
      expect((await new LaneClient(h).send(PASSWORD_ROUTES.passwordReset!(bob.login, secret!, next))).status).to.eq(200);
      expect((await new LaneClient(h).send(ROUTES.login!(bob.login, next))).status).to.eq(200);
    });

    it('sendReset false mails nothing; the old password is unusable all the same', async () => {
      const bob = await user();
      const a = await admin();
      const res = await a.c.send(request('adminPasswordReset', bob.ref, { sendReset: false }));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body).to.deep.eq({ expired: true, resetMailRequested: false });
      expect(await h.outbox!.secretFor(bob.ref, 'reset')).to.eq(null);
      expect((await h.secretStorage!.rows()).filter((r) => r.identity.id === bob.ref.id)).to.deep.eq([]);
      expect((await new LaneClient(h).send(ROUTES.login!(bob.login, bob.password))).status).to.eq(401);
    });

    it('a sendReset that is not a boolean answers 400 invalid_send_reset before the guard and changes nothing', async () => {
      const bob = await armed();
      const a = await admin();
      for (const sendReset of ['yes', 1, null, {}]) {
        const res = await a.c.send(request('adminPasswordReset', bob.ref, { sendReset }));
        expectRefused(res, 400, 'invalid_send_reset');
        expect(res.headers['cache-control']).to.eq('no-store');
      }
      expect(laneAdminGuardCalls()).to.deep.eq([]);
      await bob.untouched();
    });

    it('SR-10 admin MFA reset returns no secret', async () => {
      const bob = await user();
      const own = await login(bob);
      const begun = await own.send(MFA_ROUTES.mfaEnrol!());
      const provisioning = body<{ provisioning: string }>(begun).provisioning;
      const confirmed = await own.send(MFA_ROUTES.mfaConfirm!(totpFromProvisioning(provisioning, new Date())));
      const recoveryCodes = body<{ recoveryCodes: string[] }>(confirmed).recoveryCodes;
      expect(recoveryCodes).to.have.length(10);
      clearLog();
      const a = await admin();

      const res = await a.c.send(request('adminMfaReset', bob.ref));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body).to.deep.eq({ reset: true });
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(await h.mfa!.step.enrolled(bob.ref)).to.eq(false);
      const disabled = laneEvents.filter((e) => e.type === 'mfa.disable');
      expect(disabled.map((e) => ({ identity: e.identity, actor: e.actor }))).to.deep.eq([{ identity: bob.ref, actor: { type: 'user', id: a.ref.id } }]);

      const answer = `${JSON.stringify(res.body)} ${JSON.stringify(res.headers)} ${res.setCookie.join(' ')}`;
      expect(answer.toLowerCase()).to.not.include('otpauth').and.to.not.include('secret').and.to.not.include('provisioning');
      const seen = [answer, logLines().join('\n'), JSON.stringify(disabled)].join('\n');
      for (const value of [provisioning, parseOtpauth(provisioning).secret, ...recoveryCodes]) expect(seen).to.not.include(value);
      // The owner enrols again; a second reset finds nothing to reset.
      expect((await own.send(MFA_ROUTES.mfaEnrol!())).status).to.eq(200);
      expect(body(await a.c.send(request('adminMfaReset', bob.ref)))).to.deep.eq({ reset: true });
      expect(body(await a.c.send(request('adminMfaReset', bob.ref)))).to.deep.eq({ reset: false });
    });

    it("a sessions revoke ends the target's sessions only, counts them and audits the admin as actor", async () => {
      const bob = await user();
      const bobs = [await login(bob), await login(bob)];
      const token = await mint(bob.ref);
      const a = await admin();
      const res = await a.c.send(request('adminSessionsRevoke', bob.ref));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body).to.deep.eq({ revoked: 2 });
      expect(res.headers['cache-control']).to.eq('no-store');
      for (const s of bobs) expect(await principalId(s)).to.eq(null);
      expect(await principalId(a.c)).to.eq(a.ref.id);
      expect(await tokenOk(token), 'tokens stay').to.eq(true);
      const revoked = laneEvents.filter((e) => e.type === 'session.revoke');
      expect(revoked.map((e) => ({ outcome: e.outcome, identity: e.identity, actor: e.actor, reason: e.reason, data: e.data }))).to.deep.eq([{ outcome: 'success', identity: bob.ref, actor: { type: 'user', id: a.ref.id }, reason: 'admin', data: { count: 2 } }]);
      expect(body(await a.c.send(request('adminSessionsRevoke', bob.ref)))).to.deep.eq({ revoked: 0 });
    });

    it("a tokens revoke ends every token of the target and no other's, and keeps its sessions", async () => {
      const bob = await user();
      const carol = await user();
      const bobs = await login(bob);
      const tokens = [await mint(bob.ref), await mint(bob.ref)];
      const carols = await mint(carol.ref);
      const a = await admin();
      const res = await a.c.send(request('adminTokensRevoke', bob.ref));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body).to.deep.eq({ revoked: 2 });
      expect(res.headers['cache-control']).to.eq('no-store');
      for (const t of tokens) expect(await tokenOk(t)).to.eq(false);
      expect(await tokenOk(carols)).to.eq(true);
      expect(await principalId(bobs)).to.eq(bob.ref.id);
      expect(laneEvents.filter((e) => e.type === 'token.revoke').map((e) => ({ identity: e.identity, actor: e.actor }))).to.deep.eq([{ identity: bob.ref, actor: { type: 'user', id: a.ref.id } }]);
    });

    it('the MFA reset answers 404 not_found while TOTP is off; the other admin routes still run', async () => {
      const bob = await user();
      const a = await admin();
      await laneMfaConfig({ encryptionKey: undefined });
      expectRefused(await a.c.send(request('adminMfaReset', bob.ref)), 404, 'not_found');
      expect((await a.c.send(request('adminSessionsRevoke', bob.ref))).status).to.eq(200);
      expect(laneAdminGuardCalls().map((x) => x.action)).to.deep.eq(['sessions']);
    });

    it('a malformed, over-long or upper-case uuid answers 404 not_found and never reaches the guard', async () => {
      const a = await admin();
      for (const id of ['not-a-uuid', `${randomUUID()}x`, 'x'.repeat(65), ' ', randomUUID().toUpperCase()]) {
        for (const route of ROUTE_NAMES) {
          const res = await a.c.send({ ...ADMIN_ROUTES[route]!({ type: 'user', id }), path: pathOf(route, id) });
          expectRefused(res, 404, 'not_found');
          expect(res.headers['cache-control'], `${route} ${id}`).to.eq('no-store');
        }
      }
      expect(laneAdminGuardCalls()).to.deep.eq([]);
    });

    it('the four routes are mounted once', async () => {
      const routes = await mountedRoutes();
      for (const route of ADMIN_ROUTES_V3)
        expect(
          routes.filter((r) => r === route),
          route,
        ).to.have.length(1);
    });
  });

  describe('under authn.local.reset.revokeTokens false', () => {
    beforeEach(() => open({ authn: { local: { reset: { revokeTokens: false } } } }));

    it('a password reset keeps the tokens and still ends the sessions', async () => {
      await h.targetGuard!.allowAll();
      const bob = await user();
      const bobs = await login(bob);
      const token = await mint(bob.ref);
      const a = await admin();
      expect((await a.c.send(request('adminPasswordReset', bob.ref))).status).to.eq(200);
      expect(await tokenOk(token)).to.eq(true);
      expect(await principalId(bobs)).to.eq(null);
    });
  });

  describe('refused calls (A25: a refused call changes nothing)', () => {
    beforeEach(() => open());

    it("SR-10 lower admin cannot reset a higher admin's password", async () => {
      const higher = await armed();
      await h.targetGuard!.deny('escalation', higher.ref);
      const lower = await admin();
      const res = await lower.c.send(request('adminPasswordReset', higher.ref));
      expectRefused(res, 403, 'escalation');
      expect(res.headers['cache-control']).to.eq('no-store');
      await higher.untouched();
    });

    for (const code of ['forbidden', 'protected_role', 'escalation', 'not_found'] as const) {
      it(`a guard answer of ${code} refuses every route with ${code === 'not_found' ? '404' : '403'} ${code} and no-store`, async () => {
        const bob = await armed();
        const a = await admin(code !== 'forbidden');
        if (code === 'protected_role' || code === 'escalation') await h.targetGuard!.deny(code, bob.ref);
        // The kit's target guard has no not_found: an id the guard does not know stands in for it.
        const target = code === 'not_found' ? { type: 'user', id: randomUUID() } : bob.ref;
        if (code === 'not_found') {
          const guard = h.targetGuard! as unknown as { allowed: (...args: unknown[]) => Promise<unknown> };
          const allowed = guard.allowed.bind(guard);
          guard.allowed = async (actor, t) => ((t as IdentityRef).id === target.id ? { ok: false, code: 'not_found' } : allowed(actor, t));
        }
        for (const route of ROUTE_NAMES) {
          const res = await a.c.send(request(route, target));
          expectRefused(res, code === 'not_found' ? 404 : 403, code);
          expect(res.headers['cache-control'], route).to.eq('no-store');
        }
        expect(laneAdminGuardCalls().map((x) => [x.action, x.target.id])).to.deep.eq(ROUTE_NAMES.map((r) => [ACTION[r], target.id]));
        await bob.untouched();
      });
    }

    it('a caller without the right gets 403 forbidden, not 404, for an id the guard does not know', async () => {
      const a = await admin(false);
      const unknown = { type: 'user', id: randomUUID() };
      const guard = h.targetGuard! as unknown as { allowed: (...args: unknown[]) => Promise<unknown> };
      guard.allowed = async () => ({ ok: false, code: 'not_found' });
      for (const route of ROUTE_NAMES) {
        const res = await a.c.send(request(route, unknown));
        expectRefused(res, 403, 'forbidden');
        expect(res.headers['cache-control'], route).to.eq('no-store');
      }
      expect(effects()).to.deep.eq([]);
    });

    it('a malformed guard answer refuses every route with 403 forbidden and changes nothing', async () => {
      const bob = await armed();
      const a = await admin();
      const guard = h.targetGuard! as unknown as { allowed: (...args: unknown[]) => Promise<unknown> };
      for (const verdict of [undefined, null, { ok: 1 }, { ok: 'false' }, { ok: false }, { ok: false, code: 'toString' }]) {
        guard.allowed = async () => verdict;
        for (const route of ROUTE_NAMES) {
          const res = await a.c.send(request(route, bob.ref));
          expectRefused(res, 403, 'forbidden');
          expect(res.headers['cache-control'], `${route} ${JSON.stringify(verdict)}`).to.eq('no-store');
        }
      }
      await bob.untouched();
    });
  });

  describe('fresh authentication (A13)', () => {
    beforeEach(async () => {
      await open();
      await h.targetGuard!.allowAll();
    });

    it('a stale admin session without reauthPassword gets 403 fresh_auth_required on every route; the guard is not asked', async () => {
      const bob = await armed();
      const a = await admin();
      await later(301, async () => {
        for (const route of ROUTE_NAMES) expectRefused(await a.c.send(request(route, bob.ref)), 403, 'fresh_auth_required');
      });
      expect(laneAdminGuardCalls()).to.deep.eq([]);
      await bob.untouched();
    });

    it('a wrong or over-long reauthPassword answers the login failure body without Retry-After on every route and changes nothing', async () => {
      const bob = await armed();
      const a = await admin();
      await later(301, async () => {
        for (const route of ROUTE_NAMES) expectFailureBody(await a.c.send(request(route, bob.ref, { reauthPassword: 'Not-The-Pass-1' })));
        expectFailureBody(await a.c.send(request('adminSessionsRevoke', bob.ref, { reauthPassword: 'x'.repeat(PASSWORD_HARD_CAP + 1) })));
      });
      expect(laneAdminGuardCalls()).to.deep.eq([]);
      const reauth = h.events!.all().filter((e) => e.type === 'reauth');
      expect(reauth.filter((e) => e.outcome === 'success')).to.deep.eq([]);
      expect(reauth.map((e) => e.reason)).to.include('password_too_long');
      await bob.untouched();
    });

    it('a throttled re-authentication answers the login failure body without Retry-After, also to the right password, and changes nothing', async () => {
      const bob = await armed();
      const a = await admin();
      const blocks = () => h.events!.all().filter((e) => e.type === 'throttle.block').length;
      await later(331, async () => {
        for (let i = 0; i < 10 && blocks() === 0; i++) expectFailureBody(await a.c.send(request('adminSessionsRevoke', bob.ref, { reauthPassword: 'Not-The-Pass-1' })));
        expect(blocks(), 'the reauth throttle blocked').to.eq(1);
        for (const route of ROUTE_NAMES) expectFailureBody(await a.c.send(request(route, bob.ref, { reauthPassword: a.password })));
      });
      expect(h.events!.all().filter((e) => e.type === 'reauth' && e.outcome === 'success')).to.deep.eq([]);
      expect(laneAdminGuardCalls()).to.deep.eq([]);
      await bob.untouched();
    });

    it('the right reauthPassword lets a stale admin session act for that request only; the password reaches no log line', async () => {
      const bob = await user();
      const bobs = await login(bob);
      const a = await admin();
      await later(301, async () => {
        const res = await a.c.send(request('adminSessionsRevoke', bob.ref, { reauthPassword: a.password }));
        expect(res.status, JSON.stringify(res.body)).to.eq(200);
        expectRefused(await a.c.send(request('adminSessionsRevoke', bob.ref)), 403, 'fresh_auth_required');
      });
      expect(await principalId(bobs)).to.eq(null);
      expect(
        h
          .events!.all()
          .filter((e) => e.type === 'reauth')
          .map((e) => e.outcome),
      ).to.deep.eq(['success']);
      expect(logLines().join('\n')).to.not.include(a.password);
    });
  });

  describe('callers that may not administer credentials', () => {
    beforeEach(async () => {
      await open();
      await h.targetGuard!.allowAll();
    });

    it('anonymous callers and pending sessions answer 401 on every route; the guard is not asked', async () => {
      const bob = await armed();
      const anonymous = new LaneClient(h);
      for (const route of ROUTE_NAMES) expectRefused(await anonymous.send(request(route, bob.ref)), 401, 'unauthenticated');
      const a = await h.actors!.admin({ credentialsRight: true });
      await h.mfa!.enrol(a.ref);
      const pending = await login(a);
      for (const route of ROUTE_NAMES) expectRefused(await pending.send(request(route, bob.ref)), 401, 'unauthenticated');
      expect(laneAdminGuardCalls()).to.deep.eq([]);
      await bob.untouched();
    });

    it("a token principal is refused 403 session_required on every route, even the admin's own token", async () => {
      const bob = await armed();
      const a = await h.actors!.admin({ credentialsRight: true });
      const viaToken = new LaneClient(h, { authorization: `Bearer ${await mint(a.ref)}` });
      for (const route of ROUTE_NAMES) expectRefused(await viaToken.send(request(route, bob.ref)), 403, 'session_required');
      expect(laneAdminGuardCalls()).to.deep.eq([]);
      await bob.untouched();
    });

    it('an impersonating admin is refused 403 impersonating on every route', async () => {
      await h.guard!.allowAll();
      const bob = await armed();
      const carol = await user();
      const a = await h.actors!.admin({ credentialsRight: true });
      await h.mfa!.enrol(a.ref);
      const c = await login(a);
      await later(30, async () => expect((await c.send(ROUTES.mfaVerify!(await h.mfa!.code(a.ref)))).status).to.eq(200));
      expect((await c.send(ROUTES.impersonateStart!(carol.ref, a.password))).status).to.eq(200);
      for (const route of ROUTE_NAMES) expectRefused(await c.send(request(route, bob.ref)), 403, 'impersonating');
      expect(laneAdminGuardCalls()).to.deep.eq([]);
      await bob.untouched();
    });

    it('a cookie request from a foreign origin is refused before the route (A22)', async () => {
      const bob = await armed();
      const a = await admin();
      for (const route of ROUTE_NAMES) expect((await a.c.send({ ...request(route, bob.ref), headers: { origin: 'https://evil.example' } })).status).to.eq(403);
      expect(laneAdminGuardCalls()).to.deep.eq([]);
      await bob.untouched();
    });
  });
}
