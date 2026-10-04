import 'mocha';
import assert from 'node:assert/strict';
import type { AuthnContext, AuthnEvent, AuthnFacts, Credentials, IdentityRef, PrincipalRef, SessionHandle } from '@spinajs/authn/contracts';
import { base32Decode, EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeClock, FakeIdentityStore, FakeStrategy, fakeSeedPort, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, parseOtpauth, RecordingEventSink, RecordingPrincipalFactory, throttleParams, totpFromProvisioning } from '@spinajs/authn-testing';
import { mfaKeyRingFrom } from '../../src/cipher/index.js';
import { MemoryMfaSecretStore } from '../../src/store/index.js';
import { TotpMfaStep, totpOptions } from '../../src/step/index.js';
import { TotpService } from '../../src/service/index.js';

const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SECOND = 1000;
const PASSWORD = 'correct horse battery staple';
const ADMIN: PrincipalRef = { type: 'user', id: 'admin-1' };

class CountingAuthn extends FakeAuthnService {
  reauthCalls = 0;
  async reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean> {
    this.reauthCalls++;
    return super.reauthenticate(session, c, ctx);
  }
}

/** Runs `hook` once inside the next `confirm`, before the store confirms; can fail storing recovery codes. */
class HookStore extends MemoryMfaSecretStore {
  private hook: (() => Promise<unknown>) | null = null;
  failCodes = false;

  beforeConfirm(hook: () => Promise<unknown>): void {
    this.hook = hook;
  }

  async confirm(id: IdentityRef, step: string, at?: Date, expectedSecretEnc?: string): Promise<boolean> {
    const hook = this.hook;
    this.hook = null;
    await hook?.();
    return super.confirm(id, step, at, expectedSecretEnc);
  }

  async replaceRecoveryCodes(id: IdentityRef, rawCodes: readonly string[]): Promise<void> {
    if (this.failCodes) {
      throw new Error('storage down');
    }
    return super.replaceRecoveryCodes(id, rawCodes);
  }
}

class CountingThrottle extends FakeBackoffThrottle {
  attempts(flow: string, kind: string, value: string): number {
    return this.rows.get(`${flow}|${kind}|${value}`)?.attempts ?? 0;
  }
}

describe('v3 service: TotpService', () => {
  let clock: FakeClock;
  let identities: FakeIdentityStore;
  let sessions: MemorySessionIssuer;
  let throttle: CountingThrottle;
  let events: RecordingEventSink;
  let store: HookStore;
  let step: TotpMfaStep;
  let service: TotpService;
  let authn: CountingAuthn;
  let alice: IdentityRef;

  const ctx = (): AuthnContext => clock.ctx({ purpose: 'request' });
  const pw = (password = PASSWORD): Credentials => ({ kind: 'password', login: 'alice', password });

  async function session(over: { pending?: boolean; impersonator?: PrincipalRef } = {}): Promise<SessionHandle> {
    const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: clock.now(), ...(over.impersonator ? { impersonator: over.impersonator } : {}) };
    return sessions.issue(alice, facts, over.pending ? { pending: { steps: ['totp'] } } : undefined);
  }

  /** Enrols alice through the service; returns the provisioning URI and the recovery codes. */
  async function enrol(s?: SessionHandle): Promise<{ provisioning: string; recoveryCodes: readonly string[] }> {
    const h = s ?? (await session());
    const begun = await service.begin(h, ctx());
    assert.ok(begun.ok, JSON.stringify(begun));
    const confirmed = await service.confirm(h, totpFromProvisioning(begun.provisioning, clock.now()), ctx());
    assert.ok(confirmed.ok, JSON.stringify(confirmed));
    return { provisioning: begun.provisioning, recoveryCodes: confirmed.recoveryCodes };
  }

  const codeAt = (provisioning: string, offsetMs = 0) => totpFromProvisioning(provisioning, new Date(clock.now().getTime() + offsetMs));
  const wrong = (right: string) => (right === '000000' ? '111111' : '000000');

  beforeEach(async () => {
    clock = new FakeClock(new Date('2026-10-04T10:00:00Z'));
    clock.install();
    identities = new FakeIdentityStore();
    const passwords = new MemoryPasswordCredentialStore();
    alice = await fakeSeedPort(identities, passwords).user({ login: 'alice', email: 'alice@example.com', password: PASSWORD });
    sessions = new MemorySessionIssuer({ pendingTtlSeconds: 900 });
    throttle = new CountingThrottle(throttleParams());
    events = new RecordingEventSink();
    store = new HookStore();
    step = new TotpMfaStep({ store, keys: mfaKeyRingFrom({ secret: KEY }), options: totpOptions(), identities: null });
    authn = new CountingAuthn({
      strategies: [FakeStrategy.password({ identities, passwords })],
      throttle,
      identities,
      links: new MemoryLinkStore(),
      linking: { jit: false, byVerifiedEmail: false },
      policy: new EnrolledMfaPolicy([step]),
      steps: [step],
      sessions,
      sinks: [events],
      principals: new RecordingPrincipalFactory(),
    });
    service = new TotpService({ step, sessions, authn, throttle, sinks: [events], maxAgeSeconds: 300 });
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('begin', () => {
    it('a fresh active session gets the provisioning URI', async () => {
      const r = await service.begin(await session(), ctx());
      assert.ok(r.ok);
      assert.match(r.provisioning, /^otpauth:\/\/totp\//);
      assert.ok(await store.get(alice, 'totp'));
    });

    it('freshness is inclusive at maxAgeSeconds', async () => {
      const h = await session();
      clock.tick(300 * SECOND);
      assert.ok((await service.begin(h, ctx())).ok);
    });

    it('a stale session without reauth is not fresh and writes no secret', async () => {
      const h = await session();
      clock.tick(301 * SECOND);
      assert.deepStrictEqual(await service.begin(h, ctx()), { ok: false, code: 'not_fresh' });
      assert.strictEqual(await store.get(alice, 'totp'), null);
    });

    it('a stale session with the right password is fresh for this request', async () => {
      const h = await session();
      clock.tick(301 * SECOND);
      assert.ok((await service.begin(h, ctx(), pw())).ok);
    });

    it('a stale session with a wrong password is not fresh and counts into the reauth throttle', async () => {
      const h = await session();
      clock.tick(301 * SECOND);
      assert.deepStrictEqual(await service.begin(h, ctx(), pw('wrong')), { ok: false, code: 'not_fresh' });
      assert.strictEqual(throttle.attempts('reauth', 'account', alice.id), 1);
      assert.strictEqual(await store.get(alice, 'totp'), null);
    });

    it('an impersonated session has no session', async () => {
      const h = await session({ impersonator: ADMIN });
      assert.deepStrictEqual(await service.begin(h, ctx()), { ok: false, code: 'no_session' });
      assert.strictEqual(await store.get(alice, 'totp'), null);
    });

    it('an unknown session has no session', async () => {
      assert.deepStrictEqual(await service.begin({ id: 'nope', state: 'active' }, ctx()), { ok: false, code: 'no_session' });
    });

    it('a pending session may begin while the identity is not enrolled', async () => {
      const h = await session({ pending: true });
      const r = await service.begin(h, ctx());
      assert.ok(r.ok);
      const c = await service.confirm(h, codeAt(r.provisioning), ctx());
      assert.ok(c.ok);
    });

    it('a stale pending session is never re-authenticated inline', async () => {
      const h = await session({ pending: true });
      clock.tick(301 * SECOND);
      assert.deepStrictEqual(await service.begin(h, ctx(), pw()), { ok: false, code: 'not_fresh' });
      assert.strictEqual(authn.reauthCalls, 0);
    });

    it('a fresh session never verifies the reauth credentials', async () => {
      assert.ok((await service.begin(await session(), ctx(), pw('wrong'))).ok);
      assert.strictEqual(authn.reauthCalls, 0);
    });

    it('a pending session of an enrolled identity has no session', async () => {
      await enrol();
      const h = await session({ pending: true });
      assert.deepStrictEqual(await service.begin(h, ctx()), { ok: false, code: 'no_session' });
    });

    it('confirm on a pending session of an enrolled identity is enrolled and writes nothing', async () => {
      const { provisioning, recoveryCodes } = await enrol();
      const before = await store.get(alice, 'totp');
      const h = await session({ pending: true });
      clock.tick(30 * SECOND);
      assert.deepStrictEqual(await service.confirm(h, codeAt(provisioning), ctx()), { ok: false, code: 'enrolled' });
      assert.deepStrictEqual(await store.get(alice, 'totp'), before);
      assert.strictEqual(await store.countRecoveryCodes(alice), recoveryCodes.length);
      assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), 0);
      assert.strictEqual(await step.verify(alice, codeAt(provisioning)), true, 'the code was not spent');
    });

    it('an enrolled identity gets enrolled', async () => {
      const { provisioning } = await enrol();
      assert.deepStrictEqual(await service.begin(await session(), ctx()), { ok: false, code: 'enrolled' });
      assert.strictEqual(parseOtpauth(provisioning).secret.length > 0, true);
    });
  });

  describe('confirm', () => {
    it('the right code returns the recovery codes and enrols', async () => {
      const { recoveryCodes } = await enrol();
      assert.strictEqual(recoveryCodes.length, 10);
      assert.strictEqual(await step.enrolled(alice), true);
    });

    it('a wrong code is invalid_code and leaves the enrolment pending', async () => {
      const h = await session();
      const r = await service.begin(h, ctx());
      assert.ok(r.ok);
      assert.deepStrictEqual(await service.confirm(h, wrong(codeAt(r.provisioning)), ctx()), { ok: false, code: 'invalid_code' });
      assert.strictEqual(await step.enrolled(alice), false);
      assert.ok(await store.get(alice, 'totp'));
    });

    it('without begin it is not_begun', async () => {
      assert.deepStrictEqual(await service.confirm(await session(), '123456', ctx()), { ok: false, code: 'not_begun' });
    });

    it('a second confirmation is enrolled', async () => {
      const h = await session();
      const r = await service.begin(h, ctx());
      assert.ok(r.ok);
      assert.ok((await service.confirm(h, codeAt(r.provisioning), ctx())).ok);
      clock.tick(30 * SECOND);
      assert.deepStrictEqual(await service.confirm(h, codeAt(r.provisioning), ctx()), { ok: false, code: 'enrolled' });
    });

    it('a double submit gives one set of codes and maps the loser to enrolled', async () => {
      const h = await session();
      const r = await service.begin(h, ctx());
      assert.ok(r.ok);
      clock.tick(30 * SECOND);
      let winner: Awaited<ReturnType<TotpService['confirm']>> | null = null;
      store.beforeConfirm(async () => {
        winner = await service.confirm(h, codeAt(r.provisioning), ctx());
      });
      assert.deepStrictEqual(await service.confirm(h, codeAt(r.provisioning, -30 * SECOND), ctx()), { ok: false, code: 'enrolled' });
      const won = winner as Awaited<ReturnType<TotpService['confirm']>> | null;
      assert.ok(won?.ok);
      assert.strictEqual(won.recoveryCodes.length, 10);
      assert.strictEqual(await step.verifyRecovery(alice, won.recoveryCodes[0]), true, "the winner's codes are live");
    });

    it('after the free wrong codes the next one is throttled; after the wait the right one confirms', async () => {
      const h = await session();
      const r = await service.begin(h, ctx());
      assert.ok(r.ok);
      const free = throttleParams().mfa.account!.free;
      for (let i = 0; i < free; i++) {
        assert.deepStrictEqual(await service.confirm(h, wrong(codeAt(r.provisioning)), ctx()), { ok: false, code: 'invalid_code' });
      }
      const blocked = await service.confirm(h, codeAt(r.provisioning), ctx());
      assert.ok(!blocked.ok && blocked.code === 'throttled' && (blocked.retryAfterSeconds ?? 0) >= 1, JSON.stringify(blocked));
      assert.strictEqual(await step.enrolled(alice), false);
      assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), free);
      assert.deepStrictEqual(
        events
          .all()
          .slice(-2)
          .map((e) => `${e.type}:${e.outcome}:${e.reason}`),
        ['throttle.block:failure:throttled', 'mfa.enrol:failure:throttled'],
      );
      clock.tick(blocked.retryAfterSeconds! * SECOND);
      assert.ok((await service.confirm(h, codeAt(r.provisioning), ctx())).ok);
      assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), 0);
    });

    it('without a pending row nothing is counted', async () => {
      assert.deepStrictEqual(await service.confirm(await session(), '123456', ctx()), { ok: false, code: 'not_begun' });
      assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), 0);
    });

    it('an enrolment whose codes could not be stored is enrolled, audited as a success', async () => {
      const h = await session();
      const r = await service.begin(h, ctx());
      assert.ok(r.ok);
      store.failCodes = true;
      events.clear();
      assert.deepStrictEqual(await service.confirm(h, codeAt(r.provisioning), ctx()), { ok: false, code: 'enrolled' });
      assert.strictEqual(await step.enrolled(alice), true);
      const [e] = events.ofType('mfa.enrol');
      assert.strictEqual(e.outcome, 'success');
      assert.strictEqual(e.reason, 'recovery_codes_not_issued');
      store.failCodes = false;
      const again = await service.regenerateRecoveryCodes(h, ctx());
      assert.ok(again.ok && again.recoveryCodes.length === 10);
    });

    it('needs no freshness', async () => {
      const h = await session();
      const r = await service.begin(h, ctx());
      assert.ok(r.ok);
      clock.tick(301 * SECOND);
      assert.ok((await service.confirm(h, codeAt(r.provisioning), ctx())).ok);
    });
  });

  describe('disable', () => {
    it('a fresh session and a valid code disable', async () => {
      const { provisioning } = await enrol();
      clock.tick(30 * SECOND);
      assert.deepStrictEqual(await service.disable(await session(), codeAt(provisioning), ctx()), { ok: true });
      assert.strictEqual(await step.enrolled(alice), false);
      assert.strictEqual(await store.countRecoveryCodes(alice), 0);
    });

    it('a recovery code disables', async () => {
      const { recoveryCodes } = await enrol();
      assert.deepStrictEqual(await service.disable(await session(), recoveryCodes[0], ctx()), { ok: true });
      assert.strictEqual(await step.enrolled(alice), false);
    });

    it('a wrong code is invalid_code and counted', async () => {
      const { provisioning } = await enrol();
      clock.tick(30 * SECOND);
      assert.deepStrictEqual(await service.disable(await session(), wrong(codeAt(provisioning)), ctx()), { ok: false, code: 'invalid_code' });
      assert.strictEqual(await step.enrolled(alice), true);
      assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), 1);
    });

    it('a stale session is not_fresh and counts nothing in the mfa throttle', async () => {
      const h = await session();
      const { provisioning } = await enrol(h);
      clock.tick(301 * SECOND);
      assert.deepStrictEqual(await service.disable(h, codeAt(provisioning), ctx()), { ok: false, code: 'not_fresh' });
      assert.strictEqual(await step.enrolled(alice), true);
      assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), 0);
    });

    it('a stale session re-authenticated inline disables', async () => {
      const h = await session();
      const { provisioning } = await enrol(h);
      clock.tick(301 * SECOND);
      assert.deepStrictEqual(await service.disable(h, codeAt(provisioning), ctx(), pw()), { ok: true });
    });

    it('a pending session has no session', async () => {
      const { provisioning } = await enrol();
      clock.tick(30 * SECOND);
      assert.deepStrictEqual(await service.disable(await session({ pending: true }), codeAt(provisioning), ctx()), { ok: false, code: 'no_session' });
      assert.strictEqual(await step.enrolled(alice), true);
    });

    it('after the free wrong codes the next one is throttled; after the wait a valid one disables and resets the account key', async () => {
      const { provisioning } = await enrol();
      clock.tick(30 * SECOND);
      const h = await session();
      const free = throttleParams().mfa.account!.free;
      for (let i = 0; i < free; i++) {
        assert.deepStrictEqual(await service.disable(h, wrong(codeAt(provisioning)), ctx()), { ok: false, code: 'invalid_code' });
      }
      const blocked = await service.disable(h, codeAt(provisioning), ctx());
      assert.ok(!blocked.ok && blocked.code === 'throttled' && (blocked.retryAfterSeconds ?? 0) >= 1, JSON.stringify(blocked));
      assert.strictEqual(await step.enrolled(alice), true);
      assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), free, 'a refused attempt is not counted');
      clock.tick(blocked.retryAfterSeconds! * SECOND);
      assert.deepStrictEqual(await service.disable(h, codeAt(provisioning), ctx()), { ok: true });
      assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), 0);
    });

    it('without an enrolment it is not_enrolled', async () => {
      assert.deepStrictEqual(await service.disable(await session(), '123456', ctx()), { ok: false, code: 'not_enrolled' });
      assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), 0);
    });
  });

  describe('regenerateRecoveryCodes', () => {
    it('a fresh session gets new codes and the old ones are void', async () => {
      const { recoveryCodes } = await enrol();
      const r = await service.regenerateRecoveryCodes(await session(), ctx());
      assert.ok(r.ok);
      assert.strictEqual(r.recoveryCodes.length, 10);
      assert.strictEqual(await step.verifyRecovery(alice, recoveryCodes[0]), false);
      assert.strictEqual(await step.verifyRecovery(alice, r.recoveryCodes[0]), true);
    });

    it('a stale session is not_fresh', async () => {
      const h = await session();
      const { recoveryCodes } = await enrol(h);
      clock.tick(301 * SECOND);
      assert.deepStrictEqual(await service.regenerateRecoveryCodes(h, ctx()), { ok: false, code: 'not_fresh' });
      assert.strictEqual(await step.verifyRecovery(alice, recoveryCodes[0]), true);
    });

    it('without an enrolment it is not_enrolled', async () => {
      assert.deepStrictEqual(await service.regenerateRecoveryCodes(await session(), ctx()), { ok: false, code: 'not_enrolled' });
    });

    it('is audited as mfa.enrol with data and without codes', async () => {
      const h = await session();
      await enrol(h);
      events.clear();
      const r = await service.regenerateRecoveryCodes(h, ctx());
      assert.ok(r.ok);
      clock.tick(301 * SECOND);
      await service.regenerateRecoveryCodes(h, ctx());
      await service.adminReset(ADMIN, alice, ctx());
      clock.tick(1 * SECOND);
      await service.regenerateRecoveryCodes(await session(), ctx());
      const seen = events.ofType('mfa.enrol').map((e) => ({ outcome: e.outcome, reason: e.reason, data: e.data }));
      assert.deepStrictEqual(seen, [
        { outcome: 'success', reason: undefined, data: { recoveryCodes: 'regenerated', count: 10 } },
        { outcome: 'failure', reason: 'not_fresh', data: { recoveryCodes: 'regenerated' } },
        { outcome: 'failure', reason: 'not_enrolled', data: { recoveryCodes: 'regenerated' } },
      ]);
      const needles = [...r.recoveryCodes, ...r.recoveryCodes.map((c) => c.replace(/-/g, ''))];
      assert.strictEqual(holds(events.all(), needles), undefined);
    });
  });

  describe('adminReset', () => {
    it('resets an enrolment, a pending row, or nothing', async () => {
      await enrol();
      assert.deepStrictEqual(await service.adminReset(ADMIN, alice, ctx()), { reset: true });
      assert.strictEqual(await step.enrolled(alice), false);
      await service.begin(await session(), ctx());
      assert.deepStrictEqual(await service.adminReset(ADMIN, alice, ctx()), { reset: true });
      assert.strictEqual(await store.get(alice, 'totp'), null);
      assert.deepStrictEqual(await service.adminReset(ADMIN, alice, ctx()), { reset: false });
      assert.deepStrictEqual(
        events.ofType('mfa.disable').map((e) => e.data),
        [
          { reset: true, existed: 'confirmed' },
          { reset: true, existed: 'pending' },
          { reset: true, existed: 'none' },
        ],
      );
    });
  });

  /** base32, hex, base64 and base64url of the TOTP seed. */
  const forms = (provisioning: string): string[] => {
    const secret = parseOtpauth(provisioning).secret;
    const raw = base32Decode(secret);
    return [secret, raw.toString('hex'), raw.toString('base64'), raw.toString('base64url')];
  };
  const holds = (value: unknown, needles: readonly string[]): string | undefined => {
    const text = JSON.stringify(value).toUpperCase();
    return needles.find((n) => text.includes(n.toUpperCase()));
  };

  it('SR-10 admin MFA reset returns no secret', async () => {
    const { provisioning, recoveryCodes } = await enrol();
    events.clear();
    const result = await service.adminReset(ADMIN, alice, ctx());
    const needles = [...forms(provisioning), ...recoveryCodes, ...recoveryCodes.map((c) => c.replace(/-/g, ''))];
    assert.strictEqual(holds(result, needles), undefined);
    assert.strictEqual(holds(events.all(), needles), undefined);
    assert.strictEqual(await store.get(alice, 'totp'), null);
    assert.strictEqual(await store.countRecoveryCodes(alice), 0);
    const [e] = events.ofType('mfa.disable');
    assert.deepStrictEqual(e.actor, ADMIN);
    assert.deepStrictEqual(e.data, { reset: true, existed: 'confirmed' });
  });

  it('SR-01 no service result or event carries the TOTP secret', async () => {
    const h = await session();
    const results: unknown[] = [];
    const begun = await service.begin(h, ctx());
    assert.ok(begun.ok);
    const { provisioning, ...restOfBegin } = begun;
    results.push(restOfBegin);
    results.push(await service.confirm(h, wrong(codeAt(provisioning)), ctx()));
    const confirmed = await service.confirm(h, codeAt(provisioning), ctx());
    results.push(confirmed);
    clock.tick(30 * SECOND);
    results.push(await service.begin(h, ctx()));
    results.push(await service.regenerateRecoveryCodes(h, ctx()));
    results.push(await service.disable(h, wrong(codeAt(provisioning)), ctx()));
    results.push(await service.disable(h, codeAt(provisioning), ctx()));
    results.push(await service.adminReset(ADMIN, alice, ctx()));
    const needles = forms(provisioning);
    assert.strictEqual(holds(results, needles), undefined);
    assert.strictEqual(holds(events.all(), needles), undefined);
  });

  it('audits enrol, disable, throttle blocks and admin resets without codes', async () => {
    const used: number[] = [];
    const ctx = (): AuthnContext => {
      const c = clock.ctx({ purpose: 'request' });
      used.push(c.now.getTime());
      return c;
    };
    const h = await session();
    const begun = await service.begin(h, ctx());
    assert.ok(begun.ok);
    const bad = wrong(codeAt(begun.provisioning));
    await service.confirm(h, bad, ctx());
    const confirmed = await service.confirm(h, codeAt(begun.provisioning), ctx());
    assert.ok(confirmed.ok);
    clock.tick(30 * SECOND);
    for (let i = 0; i < 3; i++) {
      await service.disable(h, wrong(codeAt(begun.provisioning)), ctx());
    }
    await service.disable(h, codeAt(begun.provisioning), ctx());
    clock.tick(301 * SECOND);
    await service.disable(h, codeAt(begun.provisioning), ctx());
    await service.adminReset(ADMIN, alice, ctx());

    const seen = events
      .all()
      .filter((e) => e.type !== 'reauth')
      .map((e: AuthnEvent) => `${e.type}:${e.outcome}:${e.reason ?? ''}${e.actor ? ':actor' : ''}`);
    assert.deepStrictEqual(seen, ['mfa.enrol:failure:invalid_code', 'mfa.enrol:success:', 'mfa.disable:failure:invalid_code', 'mfa.disable:failure:invalid_code', 'mfa.disable:failure:invalid_code', 'throttle.block:failure:throttled', 'mfa.disable:failure:throttled', 'mfa.disable:failure:not_fresh', 'mfa.disable:success::actor']);
    for (const e of events.all()) {
      assert.deepStrictEqual(e.identity, alice);
      assert.strictEqual(e.strategy, undefined);
      assert.ok(used.includes(e.at.getTime()), 'at is the ctx.now of its call');
      assert.strictEqual(e.ip, ctx().ip);
      assert.strictEqual(e.userAgent, ctx().userAgent);
    }
    const needles = [...forms(begun.provisioning), ...confirmed.recoveryCodes, bad];
    assert.strictEqual(holds(events.all(), needles), undefined);
  });

  it('events carry ctx.now and the hashed session handle', async () => {
    const h = await session();
    const handle = (await sessions.restore(h.id))!.facts.sessionHandle;
    assert.ok(handle);
    const r = await service.begin(h, ctx());
    assert.ok(r.ok);
    clock.tick(5 * SECOND);
    const c = ctx();
    clock.tick(5 * SECOND);
    await service.confirm(h, codeAt(r.provisioning, -5 * SECOND), c);
    const [e] = events.ofType('mfa.enrol');
    assert.strictEqual(e.at.getTime(), c.now.getTime());
    assert.strictEqual(e.session, handle);
    assert.notStrictEqual(e.session, h.id);
    await service.adminReset(ADMIN, alice, c);
    assert.strictEqual(events.ofType('mfa.disable')[0].session, undefined);
  });

  it('an impersonated session can neither confirm, disable nor regenerate', async () => {
    const own = await session();
    const { provisioning } = await enrol(own);
    clock.tick(30 * SECOND);
    const imp = await session({ impersonator: ADMIN });
    assert.deepStrictEqual(await service.confirm(imp, codeAt(provisioning), ctx()), { ok: false, code: 'no_session' });
    assert.deepStrictEqual(await service.disable(imp, codeAt(provisioning), ctx()), { ok: false, code: 'no_session' });
    assert.deepStrictEqual(await service.regenerateRecoveryCodes(imp, ctx()), { ok: false, code: 'no_session' });
    assert.strictEqual(await step.enrolled(alice), true);
    assert.strictEqual(throttle.attempts('mfa', 'account', alice.id), 0);
  });
});
