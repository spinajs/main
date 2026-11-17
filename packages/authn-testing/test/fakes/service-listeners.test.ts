import assert from 'node:assert/strict';
import 'mocha';
import { DI } from '@spinajs/di';
import { AuthnEventListener, AuthnEventSink, AuthnListenerFailed } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, FakeMfaStep, FakeStrategy, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, fakeHash, throttleParams } from '../../src/index.js';

const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const IP = '192.0.2.10';

class FailingListener extends AuthnEventListener {
  constructor(private readonly blocks: boolean) {
    super();
  }

  public override get blocking(): boolean {
    return this.blocks;
  }

  async on(e: AuthnEvent): Promise<void> {
    if (e.outcome === 'success') throw new Error('store down');
  }
}

function build(listeners: readonly AuthnEventListener[], mfa = false) {
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const sessions = new MemorySessionIssuer();
  const step = new FakeMfaStep();
  const service = new FakeAuthnService({
    strategies: [FakeStrategy.password({ identities, passwords })],
    throttle: new FakeBackoffThrottle(throttleParams({})),
    identities,
    links: new MemoryLinkStore(),
    linking: { jit: false, byVerifiedEmail: false },
    policy: new EnrolledMfaPolicy(mfa ? [step] : []),
    steps: mfa ? [step] : [],
    sessions,
    listeners,
    principals: new RecordingPrincipalFactory(),
  });
  return { identities, passwords, sessions, step, service };
}

async function login(w: ReturnType<typeof build>) {
  const a = w.identities.add({ login: ALICE.login });
  await w.passwords.set(a, fakeHash(ALICE.password));
  return w.service.authenticate({ kind: 'password', login: ALICE.login, password: ALICE.password }, { now: new Date(), purpose: 'login', ip: IP });
}

const summary = (events: RecordingEventSink) => events.all().map((e) => [e.type, e.outcome, e.reason]);

describe('FakeAuthnService: delivery to listeners as AuthnAudit does it', () => {
  afterEach(() => {
    DI.unregister(RecordingEventSink);
    DI.uncache(AuthnEventListener);
    DI.uncache(AuthnEventSink);
  });

  it('delivers once to a listener registered under both AuthnEventListener and AuthnEventSink', async () => {
    DI.register(RecordingEventSink).as(AuthnEventListener);
    DI.register(RecordingEventSink).as(AuthnEventSink);
    const both = [...(await DI.resolve(Array.ofType(AuthnEventListener))), ...(await DI.resolve(Array.ofType(AuthnEventSink)))];
    const events = both.find((l): l is RecordingEventSink => l instanceof RecordingEventSink)!;
    assert.strictEqual(both.filter((l) => l === events).length, 2, 'both lookups answer the one instance');

    const r = await login(build(both));

    assert.strictEqual(r.status, 'success');
    assert.deepStrictEqual(summary(events), [
      ['login', 'success', undefined],
      ['session.issue', 'success', undefined],
    ]);
  });

  it('a failing listener that does not block stops nothing, and the others still get the events', async () => {
    const events = new RecordingEventSink();
    const r = await login(build([new FailingListener(false), events]));

    assert.strictEqual(r.status, 'success');
    assert.deepStrictEqual(summary(events), [
      ['login', 'success', undefined],
      ['session.issue', 'success', undefined],
    ]);
  });

  it('a failing blocking listener stops the login, revokes its session and re-publishes the told events as listener_failed', async () => {
    const events = new RecordingEventSink();
    const w = build([new FailingListener(true), events]);

    await assert.rejects(login(w), AuthnListenerFailed);

    assert.deepStrictEqual(summary(events), [['login', 'failure', 'listener_failed']]);
    assert.strictEqual(events.all()[0].ip, IP);
    assert.deepStrictEqual(await w.sessions.storage.storedKeys(), [], 'the issued session is revoked');
  });

  it('a stopped MFA challenge revokes its pending session', async () => {
    const events = new RecordingEventSink();
    const w = build([new FailingListener(true), events], true);
    const a = w.identities.add({ login: ALICE.login });
    await w.passwords.set(a, fakeHash(ALICE.password));
    w.step.enrol(a);

    await assert.rejects(w.service.authenticate({ kind: 'password', login: ALICE.login, password: ALICE.password }, { now: new Date(), purpose: 'login' }), AuthnListenerFailed);

    assert.deepStrictEqual(summary(events), [['mfa.challenge', 'failure', 'listener_failed']]);
    assert.deepStrictEqual(await w.sessions.storage.storedKeys(), [], 'the pending session is revoked');
  });
});
