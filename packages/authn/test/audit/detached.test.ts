import assert from 'node:assert/strict';
import 'mocha';
import sinon from 'sinon';
import { FakeStrategy } from '@spinajs/authn-testing';

import { AuthnAudit, AuthnEventSink } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, AuthnEvent, Credentials, IdentityRef, StrategyOutcome } from '../../src/index.js';
import { bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const IP = '192.0.2.45';
const OWNER: IdentityRef = { type: 'user', id: 'owner-detached' };

class NeverSettlingSink extends AuthnEventSink {
  readonly events: AuthnEvent[] = [];
  publish(e: AuthnEvent): Promise<void> {
    this.events.push(e);
    return new Promise(() => undefined);
  }
}

const ctx = (): AuthnContext => ({ now: new Date('2026-10-21T10:00:00Z'), ip: IP, purpose: 'request' });

/** Settles `p` into a flag the test can read after ticking the fake clock. */
function track<T>(p: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let done = false;
  const value = p.finally(() => (done = true));
  return { done: () => done, value };
}

describe('AuthnAudit detached delivery', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;
  let clock: sinon.SinonFakeTimers | undefined;
  let sink: NeverSettlingSink;

  afterEach(async () => {
    clock?.restore();
    clock = undefined;
    await parts?.dispose();
    parts = undefined;
  });

  async function boot(): Promise<{ p: CoreParts; audit: AuthnAudit }> {
    sink = new NeverSettlingSink();
    const verify = (c: Credentials): StrategyOutcome => (String((c as { token?: unknown }).token).endsWith('good') ? { ok: true, identity: OWNER, method: 'token' } : { ok: false, reason: 'invalid_credentials' });
    const s = new FakeStrategy({ name: 'token', kinds: ['bearer'], interactive: false, keys: () => [{ kind: 'account', value: 'acct-d' }], verify });
    parts = await buildCore({}, { strategies: [{ name: 'token', service: 'Svc_token', instance: s, listed: true }], register: (c) => bind(c, AuthnEventSink, 'NeverSettling', sink) });
    parts.identities.add({ id: OWNER.id, login: 'owner-detached@example.test' });
    const audit = await parts.child.resolve(AuthnAudit);
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    return { p: parts, audit };
  }

  it('publishDetached returns at once, without a promise, while a sink never settles', async () => {
    const { p, audit } = await boot();
    const returned: unknown = audit.publishDetached(ctx(), { type: 'token.use', outcome: 'success', strategy: 'token', identity: OWNER });
    assert.strictEqual(returned, undefined);
    await clock!.tickAsync(1);
    assert.strictEqual(p.events.ofType('token.use').length, 1, 'the other sinks still get the event');
    assert.strictEqual(sink.events.length, 1);
    await clock!.tickAsync(2000);
    await audit.settled();
  });

  it('a token success resolves in under 50 ms of fake time; settled() waits for the sink timeout', async () => {
    const { p, audit } = await boot();
    const auth = track<AuthenticationResult>(p.service.authenticate({ kind: 'bearer', token: 'spt_good' }, ctx()));
    await clock!.tickAsync(50);
    assert.ok(auth.done(), 'authenticate does not wait for a success event');
    assert.strictEqual((await auth.value).status, 'success');
    assert.ok(sink.events.some((e) => e.type === 'token.use' && e.outcome === 'success'));

    const settled = track(audit.settled());
    await clock!.tickAsync(1900);
    assert.ok(!settled.done(), 'the delivery is still running before authn.audit.sinkTimeoutMs');
    await clock!.tickAsync(200);
    assert.ok(settled.done(), 'settled() resolves once the sink timed out');
  });

  it('settled() resolves at once when nothing is in flight', async () => {
    const { audit } = await boot();
    const settled = track(audit.settled());
    await clock!.tickAsync(0);
    assert.ok(settled.done());
  });

  it('still awaits a failure event through publishIn', async () => {
    const { p, audit } = await boot();
    const published = sinon.spy(audit, 'publishIn');
    const detached = sinon.spy(audit, 'publishDetached');
    const auth = track<AuthenticationResult>(p.service.authenticate({ kind: 'bearer', token: 'spt_bad' }, ctx()));
    await clock!.tickAsync(50);
    assert.ok(!auth.done(), 'a failure waits for its audit event');
    await clock!.tickAsync(2000);
    assert.ok(auth.done());
    assert.strictEqual((await auth.value).status, 'failure');
    assert.ok(published.args.some(([, body]) => body.type === 'token.use' && body.outcome === 'failure'));
    assert.strictEqual(detached.callCount, 0);
  });
});
