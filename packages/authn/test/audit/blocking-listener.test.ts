import assert from 'node:assert/strict';
import 'mocha';
import sinon from 'sinon';
import { FakeStrategy, fakeHash } from '@spinajs/authn-testing';

import { AuthnAudit, AuthnEventListener, AuthnListenerFailed } from '../../src/index.js';
import type { AuthnContext, AuthnEvent, Credentials, IdentityRef, SessionHandle, StrategyOutcome } from '../../src/index.js';
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
    if (this.down) throw new TypeError('store down');
    await this.answer();
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
  async function boot(gate: Gate): Promise<CoreParts> {
    const verify = (c: Credentials): StrategyOutcome => ((c as { password?: unknown }).password === 'right' ? { ok: true, identity: OWNER, method: 'password' } : { ok: false, reason: 'invalid_credentials' });
    const strategy = new FakeStrategy({ name: 'kit-form', kinds: ['password'], interactive: true, keys: () => [{ kind: 'account', value: 'acct-blocking' }], verify });
    parts = await buildCore({}, { strategies: [{ name: 'kit-form', service: 'Svc_form', instance: strategy, listed: true }], register: (c) => bind(c, AuthnEventListener, 'Gate', gate) });
    parts.identities.add({ id: OWNER.id, login: 'owner-blocking@example.test' });
    return parts;
  }

  /** The kit's password login and MFA step, with an identity enrolled in the step and `gate` registered. */
  async function bootMfa(gate: Gate): Promise<{ p: CoreParts; id: IdentityRef }> {
    parts = await buildCore({}, { register: (c) => bind(c, AuthnEventListener, 'Gate', gate) });
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
    const { child } = await boot(gate);
    const audit = await child.resolve(AuthnAudit);
    gate.down = true;

    audit.publishDetached(ctx(), { type: 'token.use', outcome: 'success', identity: OWNER });
    await audit.settled();

    assert.deepStrictEqual(
      gate.seen.map((e) => e.type),
      ['token.use'],
    );
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

  it('a step-up that cannot be announced revokes the session it reissued', async () => {
    const gate = new Gate(true);
    const { p, id } = await bootMfa(gate);
    const session = await p.sessions.issue(id, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: AT });
    gate.down = true;

    const failure = await failureOf(p.service.stepUp(session, p.step.name, p.step.nextCode(id), ctx()));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.deepStrictEqual(await p.sessions.list(id), []);
  });
});
