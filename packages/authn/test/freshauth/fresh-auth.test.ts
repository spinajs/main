import assert from 'node:assert/strict';
import 'mocha';
import { fakeHash } from '@spinajs/authn-testing';

import { FreshAuthCheck, isFresh } from '../../src/index.js';
import type { AuthnContext, Credentials, IdentityRef, SessionHandle } from '../../src/index.js';
import { buildCore, useHarnessLog, violationPaths } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const SECOND = 1000;
const T0 = new Date('2026-10-03T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const pw = (password: string): Credentials => ({ kind: 'password', login: ALICE.login, password });

describe('fresh auth', function () {
  this.timeout(30000);

  useHarnessLog();

  describe('isFresh', () => {
    const facts = { authenticatedAt: T0 };

    it('is fresh up to and including maxAgeSeconds', () => {
      assert.strictEqual(isFresh(facts, T0, 300), true);
      assert.strictEqual(isFresh(facts, at(300 * SECOND), 300), true);
      assert.strictEqual(isFresh(facts, at(300 * SECOND + 1), 300), false);
    });

    it('is not fresh for an authentication time in the future or not a valid date', () => {
      assert.strictEqual(isFresh(facts, at(-1), 300), false);
      assert.strictEqual(isFresh({ authenticatedAt: new Date(NaN) }, T0, 300), false);
      assert.strictEqual(isFresh({ authenticatedAt: '2026-10-03T10:00:00Z' as unknown as Date }, T0, 300), false);
      assert.strictEqual(isFresh(facts, new Date(NaN), 300), false);
    });

    it('rejects a maxAgeSeconds that is not a positive number', () => {
      for (const bad of [0, -1, Number.NaN, Infinity, '300' as unknown as number]) assert.throws(() => isFresh(facts, T0, bad), String(bad));
    });
  });

  describe('FreshAuthCheck', () => {
    let parts: CoreParts | undefined;

    afterEach(async () => {
      await parts?.dispose();
      parts = undefined;
    });

    async function boot(freshAuth?: unknown): Promise<{ p: CoreParts; fresh: FreshAuthCheck; a: IdentityRef }> {
      parts = await buildCore({}, freshAuth === undefined ? {} : { raw: { authn: { freshAuth } } });
      const a = parts.identities.add({ login: ALICE.login });
      await parts.passwords.set(a, fakeHash(ALICE.password));
      return { p: parts, fresh: await parts.child.resolve(FreshAuthCheck), a };
    }

    const issue = (p: CoreParts, a: IdentityRef, opts?: { pending?: { steps: readonly string[] } }): Promise<SessionHandle> => p.sessions.issue(a, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: T0 }, opts);
    const ctx = (now: Date, session: SessionHandle): AuthnContext => ({ now, session, ip: '192.0.2.10', purpose: 'reauth' });

    it("does not collide in DI with authn-http's FreshAuth policy (I3)", async () => {
      // DI keys registrations and instances by class name; authn-http's route policy is a class named FreshAuth.
      const Policy = { FreshAuth: class {} }.FreshAuth;
      parts = await buildCore({}, { register: (c) => c.register(Policy).asSelf() });
      const policy = await parts.child.resolve(Policy);
      const fresh = await parts.child.resolve(FreshAuthCheck);
      assert.ok(fresh instanceof FreshAuthCheck);
      assert.ok(policy instanceof Policy);
    });

    it('gets 300 from the schema default when authn.freshAuth is unset', async () => {
      const { p, fresh } = await boot();
      assert.strictEqual(p.configuration.get('authn.freshAuth.maxAgeSeconds'), 300);
      assert.strictEqual(fresh.maxAgeSeconds, 300);
    });

    it('reads the configured authn.freshAuth.maxAgeSeconds', async () => {
      assert.strictEqual((await boot({ maxAgeSeconds: 60 })).fresh.maxAgeSeconds, 60);
    });

    it('follows the Configuration after boot rather than a snapshot', async () => {
      const { p, fresh, a } = await boot({ maxAgeSeconds: 60 });
      p.configuration.set('authn.freshAuth.maxAgeSeconds', 90);
      assert.strictEqual(fresh.maxAgeSeconds, 90);
      const s = await issue(p, a);
      assert.strictEqual(await fresh.check(s, ctx(at(90 * SECOND), s)), true);
      assert.strictEqual(await fresh.check(s, ctx(at(90 * SECOND + 1), s)), false);
    });

    it('refuses a maxAgeSeconds that is not a positive integer, naming its path', async () => {
      for (const bad of [0, -5, 1.5, 'abc']) {
        const paths = await violationPaths(boot({ maxAgeSeconds: bad }));
        assert.ok(paths.includes('authn.freshAuth.maxAgeSeconds'), `${String(bad)}: ${paths.join(', ')}`);
      }
    });

    it('passes a session authenticated within maxAgeSeconds, up to the boundary, without verifying', async () => {
      const { p, fresh, a } = await boot();
      const s = await issue(p, a);
      const local = p.strategies[0].instance as unknown as { verifyCalls: unknown[] };
      assert.strictEqual(await fresh.check(s, ctx(at(300 * SECOND), s)), true);
      assert.strictEqual(await fresh.check(s, ctx(at(300 * SECOND), s), pw('wrong')), true, 'a fresh session needs no re-authentication');
      assert.strictEqual(local.verifyCalls.length, 0);
      assert.strictEqual(await fresh.check(s, ctx(at(300 * SECOND + 1), s)), false);
    });

    it('passes a stale session only with an inline re-authentication of its identity', async () => {
      const { p, fresh, a } = await boot();
      const s = await issue(p, a);
      const late = ctx(at(301 * SECOND), s);
      assert.strictEqual(await fresh.check(s, late), false);
      assert.strictEqual(await fresh.check(s, late, pw('Wrong-Pass-9876')), false);
      assert.strictEqual(await fresh.check(s, late, pw(ALICE.password)), true);
      assert.strictEqual((await p.sessions.restore(s.id))?.facts.authenticatedAt.getTime(), T0.getTime(), 're-authentication changes no session');
      assert.strictEqual(await fresh.check(s, late), false, 'and counts for that request only');
    });

    it('refuses a pending or unknown session', async () => {
      const { p, fresh, a } = await boot();
      const pending = await issue(p, a, { pending: { steps: ['fake'] } });
      assert.strictEqual(await fresh.check(pending, ctx(T0, pending)), false);
      assert.strictEqual(await fresh.check(pending, ctx(T0, pending), pw(ALICE.password)), false);
      const gone: SessionHandle = { id: 'no-such-session', state: 'active' };
      assert.strictEqual(await fresh.check(gone, ctx(T0, gone)), false);
    });

    it('answers false, not a rejection, without a session handle', async () => {
      const { fresh } = await boot();
      for (const missing of [undefined, null, {}, { id: 42 }, { id: '' }]) {
        const h = missing as unknown as SessionHandle;
        assert.strictEqual(await fresh.check(h, { now: T0, purpose: 'reauth' }, pw(ALICE.password)), false, JSON.stringify(missing));
      }
    });
  });
});
