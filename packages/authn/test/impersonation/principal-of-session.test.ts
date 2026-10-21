import assert from 'node:assert/strict';
import 'mocha';
import { fakeHash } from '@spinajs/authn-testing';

import { AuthnImpersonationService } from '../../src/index.js';
import type { AuthnContext, AuthnEventType, AuthnFacts, IdentityRef, SessionHandle } from '../../src/index.js';
import type { Session } from '../../src/contracts/session-state.js';
import { buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = new Date('2026-10-03T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const ctx = (now: Date = T0): AuthnContext => ({ now, ip: '192.0.2.10', purpose: 'login' });

const ADMIN: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['fake'], authenticatedAt: T0 };

describe('AuthnImpersonationService.principalOf with a restored Session (PERF-1)', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  interface Booted {
    p: CoreParts;
    svc: AuthnImpersonationService;
    a: IdentityRef;
    b: IdentityRef;
  }

  async function boot(impersonation: Record<string, unknown> = {}, authn: Record<string, unknown> = {}): Promise<Booted> {
    parts = await buildCore({}, { raw: { authn: { ...authn, impersonation, freshAuth: { maxAgeSeconds: 300 } } } });
    const a = parts.identities.add({ login: 'alice@example.test' });
    await parts.passwords.set(a, fakeHash('Alice-Pass-1234'));
    const b = parts.identities.add({ login: 'bob@example.test' });
    await parts.passwords.set(b, fakeHash('Bob-Pass-1234'));
    return { p: parts, svc: await parts.child.resolve(AuthnImpersonationService), a, b };
  }

  const issue = (p: CoreParts, id: IdentityRef, over: Partial<AuthnFacts> = {}, pending = false): Promise<SessionHandle> => p.sessions.issue(id, { ...ADMIN, ...over }, pending ? { pending: { steps: ['fake'] } } : undefined);

  async function restored(p: CoreParts, h: SessionHandle): Promise<Session> {
    const session = await p.sessions.restore(h.id);
    assert.ok(session, 'the session restores');
    return session;
  }

  /** Counts the SessionIssuer.restore calls from now on; the service holds this very issuer. */
  function countRestores(p: CoreParts): { count: number } {
    const counter = { count: 0 };
    const original = p.sessions.restore.bind(p.sessions);
    p.sessions.restore = async (rawId: string) => {
      counter.count++;
      return original(rawId);
    };
    return counter;
  }

  async function impersonating(b: Booted): Promise<SessionHandle> {
    const admin = await issue(b.p, b.a);
    const r = await b.svc.start(admin, b.b, ctx());
    assert.ok(r.ok, 'impersonation starts');
    return r.session;
  }

  const reasons = (p: CoreParts, type: AuthnEventType): (string | undefined)[] => p.events.ofType(type).map((e) => e.reason);

  it('uses a passed Session as is: no restore', async () => {
    const { p, svc, a } = await boot();
    const session = await restored(p, await issue(p, a));
    const restores = countRestores(p);
    const pr = await svc.principalOf(session, ctx());
    assert.strictEqual(pr?.id, a.id);
    assert.strictEqual(pr?.authn?.sessionHandle, session.facts.sessionHandle);
    assert.strictEqual(restores.count, 0);
  });

  it('restores a bare handle once', async () => {
    const { p, svc, a } = await boot();
    const h = await issue(p, a);
    const restores = countRestores(p);
    assert.strictEqual((await svc.principalOf(h, ctx()))?.id, a.id);
    assert.strictEqual(restores.count, 1);
  });

  it('answers null for a passed pending Session', async () => {
    const { p, svc, a } = await boot();
    const session = await restored(p, await issue(p, a, {}, true));
    const restores = countRestores(p);
    assert.strictEqual(await svc.principalOf(session, ctx()), null);
    assert.strictEqual(restores.count, 0);
  });

  it('checks the subject status of a passed Session', async () => {
    const { p, svc, a } = await boot();
    const session = await restored(p, await issue(p, a));
    p.identities.setStatus(a, { banned: true });
    assert.strictEqual(await svc.principalOf(session, ctx()), null);
  });

  it('ends a passed Session whose login is maxLifetime old', async () => {
    const { p, svc, a } = await boot({}, { session: { expiration: { maxLifetime: 120 } } });
    const h = await issue(p, a);
    const session = await restored(p, h);
    assert.strictEqual(await svc.principalOf(session, ctx(at(120 * MINUTE))), null);
    assert.strictEqual(await p.sessions.restore(h.id), null, 'the session is revoked');
    assert.deepStrictEqual(reasons(p, 'session.expire'), ['session_lifetime']);
  });

  describe('impersonation checks still run for a passed Session', () => {
    it('resolves the target and asks the guard again, with no restore', async () => {
      const booted = await boot();
      const { p, svc, a, b } = booted;
      const session = await restored(p, await impersonating(booted));
      p.guard.calls.length = 0;
      const restores = countRestores(p);
      const pr = await svc.principalOf(session, ctx(at(MINUTE)));
      assert.strictEqual(pr?.id, b.id);
      assert.deepStrictEqual(pr?.authn?.impersonator, { type: 'user', id: a.id });
      assert.strictEqual(p.guard.calls.length, 1);
      assert.strictEqual(restores.count, 0);
    });

    it('ends it when the impersonator may no longer log in', async () => {
      const booted = await boot();
      const { p, svc, a } = booted;
      const imp = await impersonating(booted);
      const session = await restored(p, imp);
      p.identities.setStatus(a, { banned: true });
      assert.strictEqual(await svc.principalOf(session, ctx()), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['impersonator_banned']);
    });

    it('ends it when the target may no longer log in', async () => {
      const booted = await boot();
      const { p, svc, b } = booted;
      const imp = await impersonating(booted);
      const session = await restored(p, imp);
      p.identities.setStatus(b, { deleted: true });
      assert.strictEqual(await svc.principalOf(session, ctx()), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['target_deleted']);
    });

    it('ends it once maxMinutes have passed', async () => {
      const booted = await boot({ maxMinutes: 60 });
      const { p, svc, b } = booted;
      const imp = await impersonating(booted);
      const session = await restored(p, imp);
      assert.strictEqual((await svc.principalOf(session, ctx(at(60 * MINUTE - 1))))?.id, b.id);
      assert.strictEqual(await svc.principalOf(session, ctx(at(60 * MINUTE))), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.deepStrictEqual(reasons(p, 'impersonation.expire'), ['max_minutes']);
    });

    it('ends it once the original login is maxLifetime old', async () => {
      const booted = await boot({ maxMinutes: 1000 }, { session: { expiration: { maxLifetime: 120 } } });
      const { p, svc } = booted;
      const imp = await impersonating(booted);
      const session = await restored(p, imp);
      assert.strictEqual(await svc.principalOf(session, ctx(at(120 * MINUTE))), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['session_lifetime']);
    });
  });
});
