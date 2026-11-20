import assert from 'node:assert/strict';
import 'mocha';
import sinon from 'sinon';
import { FakeStrategy, fakeHash } from '@spinajs/authn-testing';

import type { IContainer } from '@spinajs/di';

import { AuthnAudit, AuthnEventListener, AuthnImpersonationService, AuthnListenerFailed } from '../../src/index.js';
import type { AuthnContext, AuthnEvent, Credentials, IdentityRef, SessionHandle, StrategyOutcome } from '../../src/index.js';
import { TestLog } from './test-log.js';
import { bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const AT = new Date('2026-11-16T10:00:00Z');
const OWNER: IdentityRef = { type: 'user', id: 'owner-blocking' };
const RIGHT: Credentials = { kind: 'password', login: 'owner-blocking@example.test', password: 'right' };
const WRONG: Credentials = { kind: 'password', login: 'owner-blocking@example.test', password: 'wrong' };

const event = (outcome: AuthnEvent['outcome']): AuthnEvent => ({ type: 'login', at: AT, outcome, identity: OWNER });
const ctx = (): AuthnContext => ({ now: AT, ip: '192.0.2.46', purpose: 'login' });
const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (err: unknown) => err,
  );

/** A listener that can be made to fail, blocking or not. */
class Gate extends AuthnEventListener {
  readonly seen: AuthnEvent[] = [];
  down = false;
  /** Fails only on a success event of this type. */
  failOn: string | undefined;

  constructor(
    private readonly blocks: boolean,
    private readonly answer: () => Promise<void> = () => Promise.resolve(),
  ) {
    super();
  }

  public override get blocking(): boolean {
    return this.blocks;
  }

  async on(e: AuthnEvent): Promise<void> {
    this.seen.push(e);
    if (this.down || (e.type === this.failOn && e.outcome === 'success')) throw new TypeError('store down');
    await this.answer();
  }
}

/** A Gate that also writes `<name> <type> <outcome>` to a journal shared with other listeners. */
class Journal extends Gate {
  constructor(
    blocks: boolean,
    private readonly name: string,
    private readonly journal: string[],
  ) {
    super(blocks);
  }

  override async on(e: AuthnEvent): Promise<void> {
    this.journal.push(`${this.name} ${e.type} ${e.outcome}`);
    await super.on(e);
  }
}

describe('blocking listeners', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    sinon.restore();
    await parts?.dispose();
    parts = undefined;
  });

  /** The real service over one interactive strategy that accepts the password `right`, with `gate` registered. */
  async function boot(gate: Gate, observer?: Gate): Promise<CoreParts> {
    const verify = (c: Credentials): StrategyOutcome => ((c as { password?: unknown }).password === 'right' ? { ok: true, identity: OWNER, method: 'password' } : { ok: false, reason: 'invalid_credentials' });
    const strategy = new FakeStrategy({ name: 'kit-form', kinds: ['password'], interactive: true, keys: () => [{ kind: 'account', value: 'acct-blocking' }], verify });
    const register = (c: IContainer): void => {
      bind(c, AuthnEventListener, 'Gate', gate);
      if (observer) bind(c, AuthnEventListener, 'Observer', observer);
    };
    parts = await buildCore({}, { strategies: [{ name: 'kit-form', service: 'Svc_form', instance: strategy, listed: true }], register });
    parts.identities.add({ id: OWNER.id, login: 'owner-blocking@example.test' });
    return parts;
  }

  /** The kit's password login and MFA step, with an identity enrolled in the step and `gate` registered. */
  async function bootMfa(gate: Gate, observer?: Gate): Promise<{ p: CoreParts; id: IdentityRef }> {
    const register = (c: IContainer): void => {
      bind(c, AuthnEventListener, 'Gate', gate);
      if (observer) bind(c, AuthnEventListener, 'Observer', observer);
    };
    parts = await buildCore({}, { register });
    const id = parts.identities.add({ login: 'mfa-blocking@example.test' });
    await parts.passwords.set(id, fakeHash('Mfa-Pass-1234'));
    parts.step.enrol(id);
    return { p: parts, id };
  }

  const kitLogin = (p: CoreParts) => p.service.authenticate({ kind: 'password', login: 'mfa-blocking@example.test', password: 'Mfa-Pass-1234' }, ctx());

  it('is not blocking unless it says so', () => {
    assert.strictEqual(new Gate(false).blocking, false);
    assert.strictEqual(new Gate(true).blocking, true);
  });

  it('a blocking listener that fails stops a success event, and no other listener is told', async () => {
    const gate = new Gate(true);
    gate.down = true;
    const other = new Gate(false);

    const failure = await failureOf(AuthnAudit.over([other, gate]).publish(event('success')));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.deepStrictEqual([failure.status, failure.code, failure.listener, failure.eventType], [503, 'authn_listener_failed', 'Gate', 'login']);
    assert.ok(failure.inner instanceof TypeError);
    assert.strictEqual(other.seen.length, 0);
  });

  it('a blocking listener that runs out of time stops the event too', async () => {
    const gate = new Gate(true, () => new Promise(() => undefined));

    const failure = await failureOf(AuthnAudit.over([gate], { listenerTimeoutMs: 20 }).publish(event('success')));

    assert.ok(failure instanceof AuthnListenerFailed);
  });

  it('a listener that is not blocking never stops anything, and the others still get the event', async () => {
    const gate = new Gate(false);
    gate.down = true;
    const blocking = new Gate(true);
    const other = new Gate(false);

    await AuthnAudit.over([gate, other, blocking]).publish(event('success'));

    assert.deepStrictEqual([blocking.seen.length, other.seen.length], [1, 1]);
  });

  it('a failure event is delivered to a blocking listener and never stopped by it', async () => {
    const gate = new Gate(true);
    gate.down = true;
    const warnings: unknown[][] = [];

    await AuthnAudit.over([gate], { log: { warn: (...args: unknown[]) => void warnings.push(args) } }).publish(event('failure'));

    assert.strictEqual(gate.seen.length, 1);
    assert.strictEqual(warnings.length, 1);
  });

  it('a detached event is never stopped: the operation has already returned', async () => {
    const gate = new Gate(true);
    const observer = new Gate(false);
    const { child } = await boot(gate, observer);
    const audit = await child.resolve(AuthnAudit);
    gate.down = true;

    audit.publishDetached(ctx(), { type: 'token.use', outcome: 'success', identity: OWNER });
    await audit.settled();

    assert.deepStrictEqual(
      [gate.seen.map((e) => e.type), observer.seen.map((e) => e.type)],
      [['token.use'], ['token.use']],
    );
  });

  it('a blocking getter that throws counts as a blocking listener that failed', async () => {
    const broken = new (class Broken extends Gate {
      public override get blocking(): boolean {
        throw new TypeError('no configuration');
      }
    })(true);
    const other = new Gate(false);

    const failure = await failureOf(AuthnAudit.over([other, broken]).publish(event('success')));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.deepStrictEqual([failure.listener, failure.inner instanceof TypeError], ['Broken', true]);
    assert.deepStrictEqual([broken.seen.length, other.seen.length], [0, 0]);
  });

  it('answers 503 without naming the listener or the event to the client: both are fields for the log', () => {
    const failure = new AuthnListenerFailed('LedgerListener', 'login', new TypeError('store down'));

    assert.strictEqual(failure.message, 'an authentication event could not be recorded; try again later');
    assert.deepStrictEqual([failure.status, failure.code, failure.listener, failure.eventType, failure.details], [503, 'authn_listener_failed', 'LedgerListener', 'login', undefined]);
  });

  it('a login stopped on its second event reaches the other listeners only as refused, and leaves no session', async () => {
    const gate = new Gate(true);
    gate.failOn = 'session.issue';
    const observer = new Gate(false);
    const p = await boot(gate, observer);

    const failure = await failureOf(p.service.authenticate(RIGHT, ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.strictEqual(failure.eventType, 'session.issue');
    assert.deepStrictEqual(
      observer.seen.map((e) => [e.type, e.outcome, e.reason]),
      [
        ['login', 'failure', 'listener_failed'],
        ['session.issue', 'failure', 'listener_failed'],
      ],
    );
    assert.deepStrictEqual(
      gate.seen.map((e) => [e.type, e.outcome, e.reason]),
      [
        ['login', 'success', undefined],
        ['session.issue', 'success', undefined],
        ['login', 'failure', 'listener_failed'],
        ['session.issue', 'failure', 'listener_failed'],
      ],
    );
    assert.strictEqual((await p.sessions.list(OWNER)).length, 0);
  });

  it('a login reaches the other listeners only after the blocking one took every event of it', async () => {
    const journal: string[] = [];
    const p = await boot(new Journal(true, 'gate', journal), new Journal(false, 'observer', journal));

    const result = await p.service.authenticate(RIGHT, ctx());

    assert.strictEqual(result.status, 'success');
    assert.deepStrictEqual(journal, ['gate login success', 'gate session.issue success', 'observer login success', 'observer session.issue success']);
  });

  it('holdIn hands a success to the blocking listeners only; the others hear the same event when told', async () => {
    const gate = new Gate(true);
    const other = new Gate(false);

    const tell = await AuthnAudit.over([other, gate]).holdIn(ctx(), { type: 'login', outcome: 'success', identity: OWNER });

    assert.deepStrictEqual([gate.seen.length, other.seen.length], [1, 0]);
    await tell();
    assert.strictEqual(other.seen.length, 1);
    assert.strictEqual(other.seen[0], gate.seen[0]);
    assert.ok(Object.isFrozen(other.seen[0]));
  });

  it('a hold a blocking listener stops rejects and tells nobody else', async () => {
    const gate = new Gate(true);
    gate.down = true;
    const other = new Gate(false);

    const failure = await failureOf(AuthnAudit.over([other, gate]).holdIn(ctx(), { type: 'login', outcome: 'success', identity: OWNER }));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.strictEqual(other.seen.length, 0);
  });

  it('a held failure event is never stopped, and its tell reaches the others', async () => {
    const gate = new Gate(true);
    gate.down = true;
    const other = new Gate(false);

    const tell = await AuthnAudit.over([other, gate]).holdIn(ctx(), { type: 'login', outcome: 'failure', reason: 'invalid_credentials' });
    await tell();

    assert.deepStrictEqual([gate.seen.length, other.seen.length], [1, 1]);
  });

  it('a revocation that fails after a stopped announcement is logged, and the 503 stands', async () => {
    const gate = new Gate(true);
    const p = await boot(gate);
    sinon.stub(p.sessions, 'revoke').rejects(new RangeError('store gone'));
    gate.down = true;

    const failure = await failureOf(p.service.authenticate(RIGHT, ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.ok(TestLog.of('authn-audit').some((e) => e.message.includes('could not be revoked (RangeError)')));
  });

  it('a login the blocking listener takes succeeds and keeps its session', async () => {
    const p = await boot(new Gate(true));

    const result = await p.service.authenticate(RIGHT, ctx());

    assert.strictEqual(result.status, 'success');
    assert.strictEqual((await p.sessions.list(OWNER)).length, 1);
  });

  it('a login whose record the blocking listener cannot take is refused, and its session is revoked', async () => {
    const gate = new Gate(true);
    const p = await boot(gate);
    gate.down = true;

    const failure = await failureOf(p.service.authenticate(RIGHT, ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.strictEqual(failure.status, 503);
    assert.strictEqual((await p.sessions.list(OWNER)).length, 0);
  });

  it('a wrong password answers its failure while the blocking listener is down', async () => {
    const gate = new Gate(true);
    const p = await boot(gate);
    gate.down = true;

    const result = await p.service.authenticate(WRONG, ctx());

    assert.strictEqual(result.status, 'failure');
    assert.ok(gate.seen.some((e) => e.type === 'login' && e.outcome === 'failure'));
  });

  it('an MFA challenge that cannot be announced revokes its pending session', async () => {
    const gate = new Gate(true);
    const { p } = await bootMfa(gate);
    const issue = sinon.spy(p.sessions, 'issue');
    gate.down = true;

    const failure = await failureOf(kitLogin(p));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.strictEqual(failure.eventType, 'mfa.challenge');
    const pending = await (issue.returnValues[0] as Promise<SessionHandle>);
    assert.strictEqual(await p.sessions.restore(pending.id), null);
  });

  it('an MFA completion that cannot be announced revokes the session it elevated', async () => {
    const gate = new Gate(true);
    const { p, id } = await bootMfa(gate);
    const challenged = await kitLogin(p);
    assert.strictEqual(challenged.status, 'mfa_required', JSON.stringify(challenged));
    gate.down = true;

    const failure = await failureOf(p.service.completeMfa(challenged.pending, p.step.name, p.step.nextCode(id), ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.strictEqual(failure.eventType, 'mfa.verify');
    assert.deepStrictEqual(await p.sessions.list(id), []);
  });

  it('an MFA completion stopped on its login event reaches the other listeners only as refused', async () => {
    const gate = new Gate(true);
    const observer = new Gate(false);
    const { p, id } = await bootMfa(gate, observer);
    const challenged = await kitLogin(p);
    assert.strictEqual(challenged.status, 'mfa_required', JSON.stringify(challenged));
    observer.seen.length = 0;
    gate.failOn = 'login';

    const failure = await failureOf(p.service.completeMfa(challenged.pending, p.step.name, p.step.nextCode(id), ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.strictEqual(failure.eventType, 'login');
    assert.deepStrictEqual(
      observer.seen.map((e) => [e.type, e.outcome, e.reason]),
      [
        ['mfa.verify', 'failure', 'listener_failed'],
        ['login', 'failure', 'listener_failed'],
      ],
    );
    assert.deepStrictEqual(await p.sessions.list(id), []);
  });

  it('a step-up stopped on its session.rotate event reaches the other listeners only as refused', async () => {
    const gate = new Gate(true);
    gate.failOn = 'session.rotate';
    const observer = new Gate(false);
    const { p, id } = await bootMfa(gate, observer);
    const session = await p.sessions.issue(id, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: AT });

    const failure = await failureOf(p.service.stepUp(session, p.step.name, p.step.nextCode(id), ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.strictEqual(failure.eventType, 'session.rotate');
    assert.deepStrictEqual(
      observer.seen.map((e) => [e.type, e.outcome, e.reason]),
      [
        ['mfa.verify', 'failure', 'listener_failed'],
        ['session.rotate', 'failure', 'listener_failed'],
      ],
    );
    assert.deepStrictEqual(await p.sessions.list(id), []);
  });

  it('a step-up that cannot be announced revokes the session it reissued', async () => {
    const gate = new Gate(true);
    const { p, id } = await bootMfa(gate);
    const session = await p.sessions.issue(id, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: AT });
    gate.down = true;

    const failure = await failureOf(p.service.stepUp(session, p.step.name, p.step.nextCode(id), ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.deepStrictEqual(await p.sessions.list(id), []);
  });

  /** An admin and a target user, with `gate` registered next to the kit's impersonation guard and start hook. */
  async function bootImpersonation(gate: Gate): Promise<{ p: CoreParts; svc: AuthnImpersonationService; admin: SessionHandle; target: IdentityRef }> {
    parts = await buildCore({}, { register: (c) => bind(c, AuthnEventListener, 'Gate', gate) });
    const adminId = parts.identities.add({ login: 'admin-blocking@example.test' });
    const target = parts.identities.add({ login: 'target-blocking@example.test' });
    const admin = await parts.sessions.issue(adminId, { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['fake'], authenticatedAt: AT });
    return { p: parts, svc: await parts.child.resolve(AuthnImpersonationService), admin, target };
  }

  it('an impersonation start that cannot be announced answers 503, records the refusal and leaves no impersonation', async () => {
    const gate = new Gate(true);
    gate.failOn = 'impersonation.start';
    const { p, svc, admin, target } = await bootImpersonation(gate);

    const failure = await failureOf(svc.start(admin, target, ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.deepStrictEqual(await p.sessions.list(target), []);
    assert.deepStrictEqual(
      gate.seen.map((e) => [e.type, e.outcome, e.reason]),
      [
        ['impersonation.start', 'success', undefined],
        ['impersonation.start', 'failure', 'listener_failed'],
      ],
    );
  });

  it('an impersonation end that cannot be announced answers 503 and issues the impersonator no session', async () => {
    const gate = new Gate(true);
    const { p, svc, admin, target } = await bootImpersonation(gate);
    const started = await svc.start(admin, target, ctx());
    assert.ok(started.ok, 'impersonation starts');
    gate.failOn = 'impersonation.end';

    const failure = await failureOf(svc.stop(started.session, ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.deepStrictEqual(
      gate.seen.filter((e) => e.type === 'impersonation.end').map((e) => [e.outcome, e.reason]),
      [
        ['success', undefined],
        ['failure', 'listener_failed'],
      ],
    );
    assert.strictEqual(await p.sessions.restore(started.session.id), null);
  });

  it('an impersonation session that cannot be revoked after a stopped start is logged, and the 503 stands', async () => {
    const gate = new Gate(true);
    gate.failOn = 'impersonation.start';
    const { p, svc, admin, target } = await bootImpersonation(gate);
    // The first revoke ends the admin's own session; the second is the one of the stopped start.
    sinon.stub(p.sessions, 'revoke').callThrough().onSecondCall().rejects(new RangeError('store gone'));

    const failure = await failureOf(svc.start(admin, target, ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.ok(TestLog.of('authn-audit').some((e) => e.message.includes('impersonation') && e.message.includes('could not be revoked (RangeError)')));
  });

  it('an impersonator session that cannot be revoked after a stopped end is logged, and the 503 stands', async () => {
    const gate = new Gate(true);
    const { p, svc, admin, target } = await bootImpersonation(gate);
    const started = await svc.start(admin, target, ctx());
    assert.ok(started.ok, 'impersonation starts');
    gate.failOn = 'impersonation.end';
    sinon.stub(p.sessions, 'revoke').callThrough().onSecondCall().rejects(new RangeError('store gone'));

    const failure = await failureOf(svc.stop(started.session, ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.ok(TestLog.of('authn-audit').some((e) => e.message.includes('impersonation') && e.message.includes('could not be revoked (RangeError)')));
  });
});
