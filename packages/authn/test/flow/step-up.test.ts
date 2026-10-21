import assert from 'node:assert/strict';
import 'mocha';
import { fakeHash } from '@spinajs/authn-testing';
import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { MemoryAuthnThrottle } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, IdentityRef, SessionHandle, ThrottleFlow, ThrottleKey } from '../../src/index.js';
import { buildCore, pinConfiguration, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const IP = '192.0.2.10';
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const NOW = new Date('2026-10-21T10:00:00Z');

type Failure = Extract<AuthenticationResult, { status: 'failure' }>;
type Success = Extract<AuthenticationResult, { status: 'success' }>;

class RecordingThrottle extends MemoryAuthnThrottle {
  readonly attempts: { keys: string[]; flow: ThrottleFlow }[] = [];
  readonly succeeds: { keys: string[]; flow: ThrottleFlow }[] = [];

  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    this.attempts.push({ keys: keys.map((k) => `${k.kind}=${k.value}`), flow });
    return super.attempt(keys, flow, ctx);
  }

  async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow) {
    this.succeeds.push({ keys: keys.map((k) => `${k.kind}=${k.value}`), flow });
    return super.succeed(keys, flow);
  }
}

const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: IP, purpose: 'login', ...over });
const identityKeys = (id: IdentityRef): string[] => [`account=${id.id}`, `account-ip=${id.id}|${IP}`, `ip=${IP}`];

function failure(r: AuthenticationResult, reason: string): Failure {
  assert.strictEqual(r.status, 'failure', JSON.stringify(r));
  assert.strictEqual(r.reason, reason, JSON.stringify(r));
  return r;
}

function success(r: AuthenticationResult): Success {
  assert.strictEqual(r.status, 'success', JSON.stringify(r));
  return r;
}

describe('AuthnService.stepUp (FLOW-1)', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;
  let throttle: RecordingThrottle | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
    throttle = undefined;
  });

  async function boot(): Promise<CoreParts> {
    parts = await buildCore({}, { throttle: (_c: Configuration, k: IContainer) => (throttle = pinConfiguration(new RecordingThrottle(), k)) });
    return parts;
  }

  /** An aal1 password session of alice, who enrols in the kit step after the login. */
  async function aal1Alice(p: CoreParts, enrol = true): Promise<{ a: IdentityRef; session: SessionHandle }> {
    const a = p.identities.add({ login: ALICE.login, email: ALICE.login });
    await p.passwords.set(a, fakeHash(ALICE.password));
    const r = success(await p.service.authenticate({ kind: 'password', login: ALICE.login, password: ALICE.password }, ctx()));
    assert.strictEqual(r.facts.assurance, 'aal1');
    if (enrol) p.step.enrol(a);
    return { a, session: r.session! };
  }

  it('the right code reissues the session at aal2 under a new id and audits mfa.verify and session.rotate', async () => {
    const p = await boot();
    const { a, session } = await aal1Alice(p);
    await p.sessions.set(session, 'ActiveRole', 'editor');
    p.events.clear();

    const r = success(await p.service.stepUp(session, p.step.name, p.step.nextCode(a), ctx()));

    assert.deepStrictEqual(r.identity, a);
    assert.ok(r.session && r.session.state === 'active' && r.session.id !== session.id, 'a new active id');
    assert.strictEqual(r.facts.assurance, 'aal2');
    assert.deepStrictEqual([...r.facts.mfa], [p.step.name]);
    assert.strictEqual(r.facts.method, 'password');
    assert.strictEqual(r.facts.strategy, 'local');
    assert.strictEqual(await p.sessions.restore(session.id), null, 'the aal1 id is dead');
    const stored = await p.sessions.restore(r.session.id);
    assert.strictEqual(stored?.facts.assurance, 'aal2');
    assert.strictEqual(stored?.data.get('ActiveRole'), 'editor', 'the session data is kept');
    assert.ok(r.facts.sessionHandle && r.facts.sessionHandle === stored.facts.sessionHandle);
    assert.deepStrictEqual(
      p.events.all().map((e) => `${e.type}:${e.outcome}`),
      ['mfa.verify:success', 'session.rotate:success'],
    );
    assert.ok(p.events.all().every((e) => e.session === r.facts.sessionHandle && e.identity?.id === a.id));
  });

  it('counts the mfa flow with the identity keys and gives them back on success', async () => {
    const p = await boot();
    const { a, session } = await aal1Alice(p);
    success(await p.service.stepUp(session, p.step.name, p.step.nextCode(a), ctx()));
    assert.deepStrictEqual(throttle!.attempts.filter((x) => x.flow === 'mfa').map((x) => x.keys), [identityKeys(a)]);
    assert.deepStrictEqual(throttle!.succeeds.filter((x) => x.flow === 'mfa').map((x) => x.keys), [identityKeys(a)]);
  });

  it('a wrong code fails, keeps the session at aal1 and counts in the mfa throttle until it blocks', async () => {
    const p = await boot();
    const { a, session } = await aal1Alice(p);

    failure(await p.service.stepUp(session, p.step.name, 'wrong-code-123', ctx({ now: NOW })), 'invalid_credentials');
    assert.strictEqual((await p.sessions.restore(session.id))?.facts.assurance, 'aal1', 'the session is unchanged');
    assert.deepStrictEqual(
      p.events.ofType('mfa.verify').map((e) => `${e.outcome}:${e.reason}`),
      ['failure:invalid_code'],
    );
    assert.deepStrictEqual(throttle!.attempts.filter((x) => x.flow === 'mfa').map((x) => x.keys), [identityKeys(a)]);
    assert.deepStrictEqual(throttle!.succeeds.filter((x) => x.flow === 'mfa'), [], 'a failure gives nothing back');

    let blocked: AuthenticationResult | undefined;
    for (let i = 0; i < 20 && blocked === undefined; i++) {
      const r = await p.service.stepUp(session, p.step.name, 'wrong-code-123', ctx({ now: NOW }));
      if (r.status === 'failure' && r.reason === 'throttled') blocked = r;
    }
    assert.ok(blocked, 'repeated wrong codes are throttled');
    const calls = p.step.verifyCalls.length;
    failure(await p.service.stepUp(session, p.step.name, p.step.nextCode(a), ctx({ now: NOW })), 'throttled');
    assert.strictEqual(p.step.verifyCalls.length, calls, 'a throttled step-up verifies nothing');
    assert.ok(p.events.ofType('throttle.block').length > 0);
  });

  it('a step the identity is not enrolled in fails with invalid_credentials', async () => {
    const p = await boot();
    const { a, session } = await aal1Alice(p, false);
    failure(await p.service.stepUp(session, p.step.name, p.step.nextCode(a), ctx()), 'invalid_credentials');
    assert.strictEqual(p.step.verifyCalls.length, 0, 'nothing verified');
    failure(await p.service.stepUp(session, 'kit-no-step', '123456', ctx()), 'invalid_credentials');
    assert.strictEqual((await p.sessions.restore(session.id))?.facts.assurance, 'aal1');
  });

  it('an aal2 session succeeds as it is, without a reissue', async () => {
    const p = await boot();
    const { a, session } = await aal1Alice(p);
    const up = success(await p.service.stepUp(session, p.step.name, p.step.nextCode(a), ctx()));
    p.events.clear();
    const calls = p.step.verifyCalls.length;

    const again = success(await p.service.stepUp(up.session!, p.step.name, 'any-code', ctx()));

    assert.strictEqual(again.session?.id, up.session!.id, 'the same id');
    assert.strictEqual(again.facts.assurance, 'aal2');
    assert.strictEqual(p.step.verifyCalls.length, calls, 'nothing verified');
    assert.ok((await p.sessions.restore(up.session!.id)) !== null, 'the session lives on');
    assert.deepStrictEqual(p.events.ofType('session.rotate'), []);
  });

  it("a recovery code via step 'recovery' works once", async () => {
    const p = await boot();
    const { a, session } = await aal1Alice(p);
    const other = await p.sessions.issue(a, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
    const [code] = await p.step.regenerateRecoveryCodes!(a);

    const r = success(await p.service.stepUp(session, 'recovery', code, ctx()));
    assert.strictEqual(r.facts.assurance, 'aal2');
    assert.deepStrictEqual([...r.facts.mfa], ['recovery']);

    failure(await p.service.stepUp(other, 'recovery', code, ctx()), 'invalid_credentials');
    assert.strictEqual((await p.sessions.restore(other.id))?.facts.assurance, 'aal1', 'a used code raises no other session');
  });

  it('refuses a pending session', async () => {
    const p = await boot();
    const a = p.identities.add({ login: ALICE.login, email: ALICE.login });
    await p.passwords.set(a, fakeHash(ALICE.password));
    p.step.enrol(a);
    const r = await p.service.authenticate({ kind: 'password', login: ALICE.login, password: ALICE.password }, ctx());
    assert.strictEqual(r.status, 'mfa_required');
    const pending = r.pending;

    failure(await p.service.stepUp(pending, p.step.name, p.step.nextCode(a), ctx()), 'invalid_credentials');
    assert.strictEqual((await p.sessions.restore(pending.id))?.handle.state, 'pending');
  });

  it('refuses an impersonated session: the target factor must not raise the impersonator', async () => {
    const p = await boot();
    const a = p.identities.add({ login: ALICE.login, email: ALICE.login });
    p.step.enrol(a);
    const session = await p.sessions.issue(a, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), impersonator: { type: 'user', id: 'admin' } });

    failure(await p.service.stepUp(session, p.step.name, p.step.nextCode(a), ctx()), 'invalid_credentials');
    assert.strictEqual(p.step.verifyCalls.length, 0, 'nothing verified');
    assert.strictEqual((await p.sessions.restore(session.id))?.facts.assurance, 'aal1');
  });
});
