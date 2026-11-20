import assert from 'node:assert/strict';
import 'mocha';
import { DI } from '@spinajs/di';
import { AuthnEventListener, AuthnListenerFailed } from '@spinajs/authn/contracts';
import type { AuthnEvent, AuthnEventType } from '@spinajs/authn/contracts';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, FakeMfaStep, FakeStrategy, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventListener, RecordingPrincipalFactory, fakeHash, throttleParams } from '../../src/index.js';

const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const IP = '192.0.2.10';

class FailingListener extends AuthnEventListener {
  constructor(
    private readonly blocks: boolean,
    private readonly only?: AuthnEventType,
  ) {
    super();
  }

  public override get blocking(): boolean {
    return this.blocks;
  }

  async on(e: AuthnEvent): Promise<void> {
    if (e.outcome === 'success' && (this.only === undefined || e.type === this.only)) throw new Error('store down');
  }
}

/** Writes `<name> <type> <outcome>` to a journal shared with other listeners. */
class JournalListener extends AuthnEventListener {
  constructor(
    private readonly blocks: boolean,
    private readonly name: string,
    private readonly journal: string[],
  ) {
    super();
  }

  public override get blocking(): boolean {
    return this.blocks;
  }

  async on(e: AuthnEvent): Promise<void> {
    this.journal.push(`${this.name} ${e.type} ${e.outcome}`);
  }
}

class WarnLog {
  readonly lines: string[] = [];

  warn(...args: unknown[]): void {
    this.lines.push(JSON.stringify(args));
  }
}

class BufferingListener extends AuthnEventListener {
  seen = 0;
  flushes = 0;

  async on(): Promise<void> {
    this.seen++;
  }

  async flush(): Promise<void> {
    this.flushes++;
  }
}

const BOB_TOKEN = 'bob-api-token';
const BOB_JWS = 'bob.signed.assertion';

function build(listeners: readonly AuthnEventListener[], mfa = false, log?: WarnLog) {
  const identities = new FakeIdentityStore();
  const bob = identities.add({ login: 'bob@example.test' });
  const passwords = new MemoryPasswordCredentialStore();
  const sessions = new MemorySessionIssuer();
  const step = new FakeMfaStep();
  const service = new FakeAuthnService({
    strategies: [
      FakeStrategy.password({ identities, passwords }),
      FakeStrategy.bearer({ tokens: new Map([[BOB_TOKEN, bob]]) }),
      new FakeStrategy({ name: 'keys', kinds: ['jws-assertion'], interactive: false, keys: () => [], verify: (c) => (c.kind === 'jws-assertion' && c.jws === BOB_JWS ? { ok: true, identity: bob, method: 'key' } : { ok: false, reason: 'invalid_credentials' }) }),
    ],
    throttle: new FakeBackoffThrottle(throttleParams({})),
    identities,
    links: new MemoryLinkStore(),
    linking: { jit: false, byVerifiedEmail: false },
    policy: new EnrolledMfaPolicy(mfa ? [step] : []),
    steps: mfa ? [step] : [],
    sessions,
    listeners,
    principals: new RecordingPrincipalFactory(),
    ...(log ? { log } : {}),
  });
  return { identities, passwords, sessions, step, service };
}

const ctx = () => ({ now: new Date(), purpose: 'login' as const, ip: IP });

async function login(w: ReturnType<typeof build>) {
  const a = w.identities.add({ login: ALICE.login });
  await w.passwords.set(a, fakeHash(ALICE.password));
  return w.service.authenticate({ kind: 'password', login: ALICE.login, password: ALICE.password }, { now: new Date(), purpose: 'login', ip: IP });
}

const summary = (events: RecordingEventListener) => events.all().map((e) => [e.type, e.outcome, e.reason]);

describe('FakeAuthnService: delivery to listeners as AuthnAudit does it', () => {
  afterEach(() => {
    DI.unregister(RecordingEventListener);
    DI.uncache(AuthnEventListener);
  });

  it('delivers to the listeners DI resolves under AuthnEventListener', async () => {
    DI.register(RecordingEventListener).as(AuthnEventListener);
    const listeners = await DI.resolve(Array.ofType(AuthnEventListener));
    const events = listeners.find((l): l is RecordingEventListener => l instanceof RecordingEventListener)!;

    const r = await login(build(listeners));

    assert.strictEqual(r.status, 'success');
    assert.deepStrictEqual(summary(events), [
      ['login', 'success', undefined],
      ['session.issue', 'success', undefined],
    ]);
  });

  it('a failing listener that does not block stops nothing, and the others still get the events', async () => {
    const events = new RecordingEventListener();
    const r = await login(build([new FailingListener(false), events]));

    assert.strictEqual(r.status, 'success');
    assert.deepStrictEqual(summary(events), [
      ['login', 'success', undefined],
      ['session.issue', 'success', undefined],
    ]);
  });

  it('a failing blocking listener stops the login, revokes its session and re-publishes the told events as listener_failed', async () => {
    const events = new RecordingEventListener();
    const w = build([new FailingListener(true), events]);

    await assert.rejects(login(w), AuthnListenerFailed);

    assert.deepStrictEqual(summary(events), [['login', 'failure', 'listener_failed']]);
    assert.strictEqual(events.all()[0].ip, IP);
    assert.deepStrictEqual(await w.sessions.storage.storedKeys(), [], 'the issued session is revoked');
  });

  it('a login stopped on session.issue reaches a listener that does not block only as listener_failed failures', async () => {
    const events = new RecordingEventListener();
    const w = build([new FailingListener(true, 'session.issue'), events]);

    await assert.rejects(login(w), AuthnListenerFailed);

    assert.deepStrictEqual(summary(events), [
      ['login', 'failure', 'listener_failed'],
      ['session.issue', 'failure', 'listener_failed'],
    ]);
    assert.deepStrictEqual(await w.sessions.storage.storedKeys(), [], 'the issued session is revoked');
  });

  it('a login reaches the listeners that do not block only after the blocking ones took every event of it', async () => {
    const journal: string[] = [];
    const r = await login(build([new JournalListener(false, 'observer', journal), new JournalListener(true, 'gate', journal)]));

    assert.strictEqual(r.status, 'success');
    assert.deepStrictEqual(journal, ['gate login success', 'gate session.issue success', 'observer login success', 'observer session.issue success']);
  });

  it('a stopped MFA challenge revokes its pending session', async () => {
    const events = new RecordingEventListener();
    const w = build([new FailingListener(true), events], true);
    const a = w.identities.add({ login: ALICE.login });
    await w.passwords.set(a, fakeHash(ALICE.password));
    w.step.enrol(a);

    await assert.rejects(w.service.authenticate({ kind: 'password', login: ALICE.login, password: ALICE.password }, { now: new Date(), purpose: 'login' }), AuthnListenerFailed);

    assert.deepStrictEqual(summary(events), [['mfa.challenge', 'failure', 'listener_failed']]);
    assert.deepStrictEqual(await w.sessions.storage.storedKeys(), [], 'the pending session is revoked');
  });

  it('a stopped MFA completion revokes the elevated session', async () => {
    const events = new RecordingEventListener();
    const w = build([new FailingListener(true, 'mfa.verify'), events], true);
    const a = w.identities.add({ login: ALICE.login });
    await w.passwords.set(a, fakeHash(ALICE.password));
    w.step.enrol(a);
    const r = await w.service.authenticate({ kind: 'password', login: ALICE.login, password: ALICE.password }, ctx());
    assert.ok(r.status === 'mfa_required');

    await assert.rejects(w.service.completeMfa(r.pending, w.step.name, w.step.nextCode(a), ctx()), AuthnListenerFailed);

    assert.deepStrictEqual(summary(events), [
      ['mfa.challenge', 'success', undefined],
      ['mfa.verify', 'failure', 'listener_failed'],
    ]);
    assert.deepStrictEqual(await w.sessions.storage.storedKeys(), [], 'the elevated session is revoked');
  });

  it('a stopped step-up revokes the reissued session', async () => {
    const events = new RecordingEventListener();
    const w = build([new FailingListener(true, 'mfa.verify'), events], true);
    const r = await login(w);
    assert.ok(r.status === 'success' && r.session);
    const a = r.identity;
    w.step.enrol(a);

    await assert.rejects(w.service.stepUp(r.session, w.step.name, w.step.nextCode(a), ctx()), AuthnListenerFailed);

    assert.deepStrictEqual(summary(events), [
      ['login', 'success', undefined],
      ['session.issue', 'success', undefined],
      ['mfa.verify', 'failure', 'listener_failed'],
    ]);
    assert.deepStrictEqual(await w.sessions.storage.storedKeys(), [], 'the reissued session is revoked');
  });

  it('a revocation that fails is logged, the told events still go out as listener_failed, and the operation still answers AuthnListenerFailed', async () => {
    const log = new WarnLog();
    const events = new RecordingEventListener();
    const w = build([new FailingListener(true), events], false, log);
    w.sessions.revoke = () => Promise.reject(new Error('issuer down'));

    await assert.rejects(login(w), AuthnListenerFailed);

    assert.ok(log.lines.some((l) => l.includes('could not be revoked')), log.lines.join('\n'));
    assert.deepStrictEqual(summary(events), [['login', 'failure', 'listener_failed']]);
  });

  it('logs a failing listener that does not block', async () => {
    const log = new WarnLog();
    const r = await login(build([new FailingListener(false)], false, log));

    assert.strictEqual(r.status, 'success');
    assert.ok(log.lines.some((l) => l.includes('FailingListener')), log.lines.join('\n'));
  });

  it('publishes token.use detached: a failing blocking listener neither stops nor holds the request, and every listener gets it', async () => {
    const events = new RecordingEventListener();
    const log = new WarnLog();
    const w = build([new FailingListener(true), events], false, log);

    const r = await w.service.authenticate({ kind: 'bearer', token: BOB_TOKEN }, { now: new Date(), purpose: 'request', ip: IP });
    assert.strictEqual(r.status, 'success');
    await w.service.settled();

    assert.deepStrictEqual(summary(events), [['token.use', 'success', undefined]]);
    assert.ok(log.lines.some((l) => l.includes('FailingListener')), log.lines.join('\n'));
  });

  it('a blocking listener that never answers does not hold a token request; settled() waits for it', async () => {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const hung = new (class HungListener extends AuthnEventListener {
      public override get blocking(): boolean {
        return true;
      }

      on(): Promise<void> {
        return answered;
      }
    })();
    const w = build([hung]);

    const r = await w.service.authenticate({ kind: 'bearer', token: BOB_TOKEN }, { now: new Date(), purpose: 'request', ip: IP });
    assert.strictEqual(r.status, 'success');

    let settled = false;
    const waiting = w.service.settled().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(settled, false, 'settled() waits for the listener');
    release();
    await waiting;
  });

  it('names the event of a key strategy key.use, as the core does', async () => {
    const events = new RecordingEventListener();
    const w = build([events]);

    const r = await w.service.authenticate({ kind: 'jws-assertion', jws: BOB_JWS }, { now: new Date(), purpose: 'request', ip: IP });
    assert.strictEqual(r.status, 'success');
    await w.service.settled();

    assert.deepStrictEqual(summary(events), [['key.use', 'success', undefined]]);
  });

  it('gives the session.rotate of a step-up the reason step_up, as the core does', async () => {
    const events = new RecordingEventListener();
    const w = build([events], true);
    const r = await login(w);
    assert.ok(r.status === 'success' && r.session);
    w.step.enrol(r.identity);

    assert.strictEqual((await w.service.stepUp(r.session, w.step.name, w.step.nextCode(r.identity), ctx())).status, 'success');

    assert.deepStrictEqual(summary(events).slice(2), [
      ['mfa.verify', 'success', undefined],
      ['session.rotate', 'success', 'step_up'],
    ]);
  });

  it('flushes the listeners only when settled() is called, as AuthnAudit does', async () => {
    const buffering = new BufferingListener();
    const w = build([buffering]);

    await w.service.authenticate({ kind: 'bearer', token: BOB_TOKEN }, { now: new Date(), purpose: 'request', ip: IP });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual([buffering.seen, buffering.flushes], [1, 0], 'a token.use is delivered but flushes nothing');

    await w.service.settled();
    assert.strictEqual(buffering.flushes, 1);
    await w.service.settled();
    assert.strictEqual(buffering.flushes, 2, 'settled() flushes with no detached event pending, too');
  });
});
