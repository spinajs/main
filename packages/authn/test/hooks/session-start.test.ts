import assert from 'node:assert/strict';
import 'mocha';
import * as sinon from 'sinon';
import { fakeHash } from '@spinajs/authn-testing';
import { ActionHook, DefaultHooks } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import { RecordingActionHook, mutatingHook, refusingHook } from '@spinajs/hooks/testing';

import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { ACTIVE_ROLE_KEY, MemoryAuthnThrottle } from '../../src/index.js';
import type { AuthnContext, AuthnEvent, AuthnSessionStartInput, Credentials, IdentityRef, SessionHandle } from '../../src/index.js';
import { buildCore, pinConfiguration, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const IP = '192.0.2.10';
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const INVALID = { status: 'failure', reason: 'invalid_credentials' };

const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: IP, purpose: 'login', ...over });
const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password });
const failuresOf = (events: readonly AuthnEvent[], type: AuthnEvent['type']) => events.filter((e) => e.type === type && e.outcome === 'failure');

class Throwing extends ActionHook<'authn.session.start'> {
  readonly actions: readonly ActionPattern[] = ['authn.session.start'];

  before(): void {
    throw new RangeError('role service down');
  }
}

/** Sets `ceiling` unless an earlier hook set one, as OrderedActiveRoleHook does. */
class FirstCeiling extends ActionHook<'authn.session.start'> {
  readonly actions: readonly ActionPattern[] = ['authn.session.start'];

  constructor(private readonly ceiling: unknown) {
    super();
  }

  before(ctx: BeforeContext<'authn.session.start'>): void {
    if (ctx.input.ceiling === undefined) (ctx.input as { ceiling?: unknown }).ceiling = this.ceiling;
  }
}

describe('authn.session.start: the active session a login or an MFA completion issues', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    sinon.restore();
    await parts?.dispose();
    parts = undefined;
  });

  async function boot(hooks: readonly ActionHook[]): Promise<CoreParts> {
    parts = await buildCore({}, { throttle: (_c: Configuration, k: IContainer) => pinConfiguration(new MemoryAuthnThrottle(), k), hooks });
    return parts;
  }

  const seed = async (p: CoreParts): Promise<IdentityRef> => {
    const id = p.identities.add({ login: ALICE.login, email: ALICE.login });
    await p.passwords.set(id, fakeHash(ALICE.password));
    return id;
  };

  const login = (p: CoreParts) => p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());

  async function pendingAlice(p: CoreParts): Promise<{ a: IdentityRef; pending: SessionHandle }> {
    const a = await seed(p);
    p.step.enrol(a);
    const r = await login(p);
    assert.strictEqual(r.status, 'mfa_required', JSON.stringify(r));
    return { a, pending: r.pending };
  }

  const activeRoleOf = async (p: CoreParts, handle: SessionHandle) => (await p.sessions.restore(handle.id))?.data.get(ACTIVE_ROLE_KEY);

  it('runs once a login has issued the active session, with the kind, the session and the principal', async () => {
    const recorder = new RecordingActionHook(['authn.session.start']);
    const p = await boot([recorder]);
    const a = await seed(p);
    const r = await login(p);
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    assert.deepStrictEqual(
      recorder.calls.map((c) => c.phase),
      ['before', 'after'],
    );
    const input = recorder.calls[0].input as AuthnSessionStartInput;
    assert.deepStrictEqual(Object.keys(input).sort(), ['ctx', 'kind', 'principal', 'session']);
    assert.strictEqual(input.kind, 'login');
    assert.deepStrictEqual(input.session, r.session);
    assert.strictEqual(input.principal.id, a.id);
    assert.strictEqual(input.principal.authn?.sessionHandle, r.facts.sessionHandle);
    assert.strictEqual(await activeRoleOf(p, r.session!), undefined, 'no hook set a ceiling: every held role');
  });

  it('stores a ceiling a hook sets as the session ActiveRole: one role, or none', async () => {
    const p = await boot([mutatingHook('authn.session.start', { ceiling: { roles: ['editor'] } })]);
    await seed(p);
    const r = await login(p);
    assert.strictEqual(r.status, 'success');
    assert.strictEqual(await activeRoleOf(p, r.session!), 'editor');

    const none = await boot([mutatingHook('authn.session.start', { ceiling: { roles: [] } })]);
    await seed(none);
    const n = await login(none);
    assert.strictEqual(n.status, 'success');
    assert.strictEqual(await activeRoleOf(none, n.session!), '');
  });

  it('keeps the first ceiling when an earlier hook already chose one', async () => {
    const p = await boot([new FirstCeiling({ roles: ['viewer'] }), new FirstCeiling({ roles: ['editor'] })]);
    await seed(p);
    const r = await login(p);
    assert.strictEqual(r.status, 'success');
    assert.strictEqual(await activeRoleOf(p, r.session!), 'viewer');
  });

  it('asks nothing for a pending login; the MFA completion runs it with kind mfa', async () => {
    const recorder = new RecordingActionHook(['authn.session.start']);
    const p = await boot([recorder, mutatingHook('authn.session.start', { ceiling: { roles: ['editor'] } })]);
    const { a, pending } = await pendingAlice(p);
    assert.strictEqual(recorder.calls.length, 0, 'no hook sees a pending session');
    const done = await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx());
    assert.strictEqual(done.status, 'success', JSON.stringify(done));
    assert.deepStrictEqual(
      recorder.calls.map((c) => [c.phase, (c.input as AuthnSessionStartInput).kind]),
      [
        ['before', 'mfa'],
        ['after', 'mfa'],
      ],
    );
    assert.strictEqual(await activeRoleOf(p, done.session!), 'editor');
  });

  it('a refusal at login fails it as a wrong password does, ends the session and audits login with hook:<code>', async () => {
    const p = await boot([refusingHook('authn.session.start', 'kit-no-session')]);
    const a = await seed(p);
    assert.deepStrictEqual(await login(p), INVALID);
    assert.deepStrictEqual(await p.sessions.list(a), [], 'the session it was asked about is gone');
    assert.deepStrictEqual(
      failuresOf(p.events.all(), 'login').map((e) => e.reason),
      ['hook:kit-no-session'],
    );
    assert.ok(!p.events.all().some((e) => e.outcome === 'success' && (e.type === 'login' || e.type === 'session.issue')), 'no login success');
  });

  it('a refusal of an MFA completion answers the failure of a wrong code and ends the elevated session', async () => {
    const p = await boot([refusingHook('authn.session.start', 'kit-no-session')]);
    const { a, pending } = await pendingAlice(p);
    assert.deepStrictEqual(await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx()), INVALID);
    assert.deepStrictEqual(await p.sessions.list(a), []);
    assert.deepStrictEqual(
      failuresOf(p.events.all(), 'login').map((e) => e.reason),
      ['hook:kit-no-session'],
    );
  });

  it('a hook that throws fails the login, ends the session and audits hook_error', async () => {
    const p = await boot([new Throwing()]);
    const a = await seed(p);
    assert.deepStrictEqual(await login(p), INVALID);
    assert.deepStrictEqual(await p.sessions.list(a), []);
    const [failure] = failuresOf(p.events.all(), 'login');
    assert.strictEqual(failure.reason, 'hook_error');
    assert.deepStrictEqual(failure.data, { hook: 'Throwing', failure: 'error' });
  });

  for (const [label, ceiling] of [
    ['two roles', { roles: ['a', 'b'] }],
    ['a permission narrowing', { roles: ['a'], permissions: ['doc:read'] }],
    ['an empty role name', { roles: [''] }],
    ['no roles list', {}],
    ['a role name', 'a'],
  ] as const) {
    it(`a ceiling with ${label}, which an ActiveRole cannot hold, fails the login and ends the session`, async () => {
      const p = await boot([mutatingHook('authn.session.start', { ceiling })]);
      const a = await seed(p);
      assert.deepStrictEqual(await login(p), INVALID);
      assert.deepStrictEqual(await p.sessions.list(a), []);
      const [failure] = failuresOf(p.events.all(), 'login');
      assert.strictEqual(failure.reason, 'hook_error');
      assert.deepStrictEqual(failure.data, { failure: 'ceiling' });
    });
  }

  it('runs for no step-up and no per-request credential', async () => {
    const recorder = new RecordingActionHook(['authn.session.start']);
    const p = await boot([recorder]);
    const a = await seed(p);
    const session = await p.sessions.issue(a, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
    p.step.enrol(a);
    const stepped = await p.service.stepUp(session, p.step.name, p.step.nextCode(a), ctx({ session }));
    assert.strictEqual(stepped.status, 'success', JSON.stringify(stepped));
    p.tokens.set('kit-token', a);
    const token = await p.service.authenticate({ kind: 'bearer', token: 'kit-token' }, ctx({ purpose: 'request' }));
    assert.strictEqual(token.status, 'success', JSON.stringify(token));
    assert.deepStrictEqual(recorder.calls, []);
  });

  it('with no hook on it, a login never calls the runner for it', async () => {
    const p = await boot([]);
    await seed(p);
    const run = sinon.spy(DefaultHooks.prototype, 'run');
    assert.strictEqual((await login(p)).status, 'success');
    assert.deepStrictEqual(
      run.getCalls().map((c) => c.args[0]),
      [],
    );
  });
});
