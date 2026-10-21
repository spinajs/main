import assert from 'node:assert/strict';
import 'mocha';
import { ActionHookFailed, ActionRefused, Hooks } from '@spinajs/hooks';
import type { ActionName, InputOf, OutputOf, RunOptions } from '@spinajs/hooks';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, FakeStrategy, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, fakeHash, throttleParams } from '../../src/index.js';

const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };

/** A runner whose run throws `error` for every action, or hands `impl` its input as a hook would see it. */
class ScriptedHooks extends Hooks {
  readonly inputs: unknown[] = [];

  constructor(private readonly error?: (action: string) => unknown) {
    super();
  }

  has(): boolean {
    return true;
  }

  async run<A extends ActionName>(action: A, input: InputOf<A>, impl: (input: InputOf<A>) => Promise<OutputOf<A>>, _opts: RunOptions<A>): Promise<OutputOf<A>> {
    this.inputs.push(input);
    if (this.error) throw this.error(action);
    return impl(input);
  }
}

function build(hooks: Hooks) {
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const events = new RecordingEventSink();
  const sessions = new MemorySessionIssuer();
  const service = new FakeAuthnService({
    strategies: [FakeStrategy.password({ identities, passwords })],
    throttle: new FakeBackoffThrottle(throttleParams({})),
    identities,
    links: new MemoryLinkStore(),
    linking: { jit: false, byVerifiedEmail: false },
    policy: new EnrolledMfaPolicy([]),
    steps: [],
    sessions,
    sinks: [events],
    principals: new RecordingPrincipalFactory(),
    hooks,
  });
  return { identities, passwords, events, sessions, service };
}

async function login(w: ReturnType<typeof build>) {
  const a = w.identities.add({ login: ALICE.login });
  await w.passwords.set(a, fakeHash(ALICE.password));
  const r = await w.service.authenticate({ kind: 'password', login: ALICE.login, password: ALICE.password }, { now: new Date(), purpose: 'login', ip: '192.0.2.10' });
  return { a, r };
}

describe('FakeAuthnService: authn.login.identified as the core maps it', () => {
  it('a refusal answers invalid_credentials and audits hook:<code>', async () => {
    const w = build(new ScriptedHooks((action) => new ActionRefused(action, 'kit-no')));
    const { a, r } = await login(w);
    assert.deepStrictEqual(r, { status: 'failure', reason: 'invalid_credentials' });
    assert.deepStrictEqual(
      w.events.ofType('login').map((e) => [e.reason, e.identity, e.data]),
      [['hook:kit-no', a, undefined]],
    );
  });

  it('a failed hook audits hook_error with the hook class and why, as the core does', async () => {
    const w = build(new ScriptedHooks((action) => new ActionHookFailed(action, 'GroupSync', 'timeout')));
    const { r } = await login(w);
    assert.deepStrictEqual(r, { status: 'failure', reason: 'invalid_credentials' });
    assert.deepStrictEqual(
      w.events.ofType('login').map((e) => [e.reason, e.data]),
      [['hook_error', { hook: 'GroupSync', failure: 'timeout' }]],
    );
  });

  it("another action's refusal is not this one's: it reaches the caller", async () => {
    const w = build(new ScriptedHooks(() => new ActionRefused('users.update', 'kit-no')));
    await assert.rejects(login(w), ActionRefused);
  });

  it('the hooks get a frozen copy of the identity', async () => {
    const hooks = new ScriptedHooks();
    const w = build(hooks);
    const { a, r } = await login(w);
    assert.strictEqual(r.status, 'success');
    const input = hooks.inputs[0] as { identity: object };
    assert.deepStrictEqual(input.identity, a);
    assert.notStrictEqual(input.identity, a);
    assert.ok(Object.isFrozen(input.identity));
  });
});
