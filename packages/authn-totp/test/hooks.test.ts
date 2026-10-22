/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the tamper tests write into hook inputs untyped, as a careless hook would */
import 'mocha';
import assert from 'node:assert/strict';
import { ActionRefused } from '@spinajs/hooks';
import type { AuthnContext, AuthnFacts, IdentityRef, PrincipalRef, SessionHandle } from '@spinajs/authn/contracts';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeClock, FakeIdentityStore, FakeStrategy, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, ScriptedActionHook, fakeSeedPort, kitHooks, throttleParams, totpFromProvisioning } from '@spinajs/authn-testing';

import { mfaKeyRingFrom } from '../src/cipher/index.js';
import { TotpService } from '../src/service/index.js';
import { TotpMfaStep } from '../src/step/index.js';
import { MemoryMfaSecretStore } from '../src/store/index.js';
import { totpOpts } from './v3/support/totp-defaults.js';

const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const ADMIN: PrincipalRef = { type: 'user', id: 'admin-1' };
const CODE = 'not-today';

/** Records the keys of every attempt. */
class KeyThrottle extends FakeBackoffThrottle {
  readonly keys: string[] = [];

  async attempt(...args: Parameters<FakeBackoffThrottle['attempt']>) {
    this.keys.push(...args[0].map((k) => `${k.kind}=${k.value}`));
    return super.attempt(...args);
  }
}

/** Counts the recovery code sets written. */
class CountingStore extends MemoryMfaSecretStore {
  replaced = 0;

  async replaceRecoveryCodes(id: IdentityRef, rawCodes: readonly string[]): Promise<void> {
    this.replaced++;
    return super.replaceRecoveryCodes(id, rawCodes);
  }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('TotpService action hooks', () => {
  let clock: FakeClock;
  let store: CountingStore;
  let events: RecordingEventSink;
  let hook: ScriptedActionHook;
  let service: TotpService;
  let sessions: MemorySessionIssuer;
  let alice: IdentityRef;
  let step: TotpMfaStep;
  let throttle: KeyThrottle;

  const ctx = (): AuthnContext => clock.ctx({ purpose: 'request' });

  async function session(): Promise<SessionHandle> {
    const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: clock.now() };
    return sessions.issue(alice, facts);
  }

  async function enrolled(s: SessionHandle): Promise<{ provisioning: string; recoveryCodes: readonly string[] }> {
    const begun = await service.begin(s, ctx());
    assert.ok(begun.ok);
    const confirmed = await service.confirm(s, totpFromProvisioning(begun.provisioning, clock.now()), ctx());
    assert.ok(confirmed.ok);
    return { provisioning: begun.provisioning, recoveryCodes: confirmed.recoveryCodes };
  }

  /** The stored enrolment row, to compare before and after a refusal. */
  const row = async () => JSON.stringify(await store.get(alice, 'totp'));

  const audited = (type: string, reason: string) => events.all().some((e) => e.type === type && e.outcome === 'failure' && e.reason === reason);

  beforeEach(async () => {
    clock = new FakeClock(new Date('2026-10-04T10:00:00Z'));
    clock.install();
    const identities = new FakeIdentityStore();
    const passwords = new MemoryPasswordCredentialStore();
    alice = await fakeSeedPort(identities, passwords).user({ login: 'alice', email: 'alice@example.com', password: 'correct horse battery staple' });
    sessions = new MemorySessionIssuer();
    throttle = new KeyThrottle(throttleParams());
    events = new RecordingEventSink();
    store = new CountingStore();
    step = new TotpMfaStep({ store, keys: mfaKeyRingFrom({ secret: KEY }), options: totpOpts(), identities: null });
    const authn = new FakeAuthnService({
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
    hook = new ScriptedActionHook();
    service = new TotpService({ step, sessions, authn, throttle, sinks: [events], maxAgeSeconds: 300, ipv6Prefix: 64, hooks: await kitHooks([hook]) });
  });

  afterEach(() => {
    clock.uninstall();
  });

  it('begin refused throws ActionRefused and writes no secret', async () => {
    hook.refuse('authn.mfa.enrol.begin', CODE);
    const err = await rejection(service.begin(await session(), ctx()));
    assert.ok(err instanceof ActionRefused && err.code === CODE, String(err));
    assert.strictEqual(await store.get(alice, 'totp'), null);
    assert.ok(audited('mfa.enrol', `hook:${CODE}`));
  });

  it('confirm refused throws ActionRefused and leaves the enrolment begun', async () => {
    const s = await session();
    const begun = await service.begin(s, ctx());
    assert.ok(begun.ok);
    const before = await row();
    hook.refuse('authn.mfa.enrol.confirm', CODE);
    assert.ok((await rejection(service.confirm(s, totpFromProvisioning(begun.provisioning, clock.now()), ctx()))) instanceof ActionRefused);
    assert.strictEqual(await row(), before);
  });

  it('disable refused throws ActionRefused and keeps the enrolment', async () => {
    const s = await session();
    const { provisioning } = await enrolled(s);
    const before = await row();
    hook.refuse('authn.mfa.disable', CODE);
    clock.tick(30_000);
    assert.ok((await rejection(service.disable(s, totpFromProvisioning(provisioning, clock.now()), ctx()))) instanceof ActionRefused);
    assert.strictEqual(await row(), before);
    assert.ok(audited('mfa.disable', `hook:${CODE}`));
  });

  it('regenerateRecoveryCodes refused throws ActionRefused and keeps the codes', async () => {
    const s = await session();
    const { recoveryCodes } = await enrolled(s);
    const replaced = store.replaced;
    hook.refuse('authn.mfa.recovery.regenerate', CODE);
    assert.ok((await rejection(service.regenerateRecoveryCodes(s, ctx()))) instanceof ActionRefused);
    assert.strictEqual(store.replaced, replaced, 'no new codes are written');
    assert.strictEqual(await step.verifyRecovery(alice, recoveryCodes[0]), true, 'an old code still redeems');
    hook.reset();
    assert.ok((await service.regenerateRecoveryCodes(s, ctx())).ok);
    assert.strictEqual(await step.verifyRecovery(alice, recoveryCodes[1]), false, 'after a regeneration that ran, the old codes no longer redeem');
  });

  it('a hook writing ctx.ip, the target or the actor in place reaches neither the mfa throttle nor the admin reset', async () => {
    const s = await session();
    await enrolled(s);
    hook.tamper('authn.mfa.*', (i) => {
      if (i.ctx) i.ctx.ip = '203.0.113.9';
      if (i.target) i.target.id = 'someone-else';
      if (i.actor) i.actor.id = 'someone-else';
    });
    clock.tick(30_000);
    await service.disable(s, '000000', clock.ctx({ purpose: 'request', ip: '192.0.2.10' }));
    assert.ok(!throttle.keys.some((k) => k.includes('203.0.113.9')), JSON.stringify(throttle.keys));
    assert.deepStrictEqual(await service.adminReset(ADMIN, alice, ctx()), { reset: true });
    assert.strictEqual(await store.get(alice, 'totp'), null, "alice's enrolment is the one reset");
    assert.ok(events.all().some((e) => e.type === 'mfa.disable' && e.outcome === 'success' && e.actor?.id === ADMIN.id && e.identity?.id === alice.id));
    assert.deepStrictEqual(hook.landed(), []);
  });

  it('adminReset refused answers { reset: false } and keeps the enrolment', async () => {
    await enrolled(await session());
    const before = await row();
    hook.refuse('authn.mfa.adminReset', CODE);
    assert.deepStrictEqual(await service.adminReset(ADMIN, alice, ctx()), { reset: false });
    assert.strictEqual(await row(), before);
    assert.ok(audited('mfa.disable', `hook:${CODE}`));
  });

  it('no hook sees the provisioning URI or a recovery code', async () => {
    const s = await session();
    const begun = await service.begin(s, ctx());
    assert.ok(begun.ok);
    const confirmed = await service.confirm(s, totpFromProvisioning(begun.provisioning, clock.now()), ctx());
    assert.ok(confirmed.ok);
    const text = JSON.stringify(hook.calls());
    assert.ok(!text.includes(begun.provisioning));
    for (const code of confirmed.recoveryCodes) assert.ok(!text.includes(code));
    assert.deepStrictEqual(
      hook.calls().map((c) => `${c.action}:${c.phase}`),
      ['authn.mfa.enrol.begin:before', 'authn.mfa.enrol.begin:after', 'authn.mfa.enrol.confirm:before', 'authn.mfa.enrol.confirm:after'],
    );
  });
});
