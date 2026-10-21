import assert from 'node:assert/strict';
import 'mocha';
import { FakeStrategy } from '@spinajs/authn-testing';

import { AuthnThrottle } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, Credentials, IdentityRef, PeekVerdict, PeekableThrottle, StrategyOutcome, ThrottleFlow, ThrottleKey } from '../../src/index.js';
import { buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const IP = '192.0.2.44';
const OWNER: IdentityRef = { type: 'user', id: 'owner-pr' };

/** Answers every peek with a fixed verdict and records the order of throttle calls and verifies. */
class SpyThrottle extends AuthnThrottle implements PeekableThrottle {
  readonly calls: string[] = [];

  constructor(private readonly verdict: PeekVerdict) {
    super();
  }

  async peek(_keys: readonly ThrottleKey[], flow: ThrottleFlow, _ctx: AuthnContext): Promise<PeekVerdict> {
    this.calls.push(`peek:${flow}`);
    return this.verdict;
  }

  async attempt(_keys: readonly ThrottleKey[], flow: ThrottleFlow, _ctx: AuthnContext): Promise<{ allowed: true }> {
    this.calls.push(`attempt:${flow}`);
    return { allowed: true };
  }

  async succeed(_keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    this.calls.push(`succeed:${flow}`);
  }

  count(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }
}

const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: IP, purpose: 'request', ...over });

function success(r: AuthenticationResult): void {
  assert.strictEqual(r.status, 'success', JSON.stringify(r));
}

describe('DefaultAuthnService writes nothing to the throttle for a clean per-request success', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  const verifier =
    (spy: () => SpyThrottle, method: string) =>
    (c: Credentials): StrategyOutcome => {
      spy().calls.push('verify');
      return String((c as { token?: unknown }).token).endsWith('good') ? { ok: true, identity: OWNER, method } : { ok: false, reason: 'invalid_credentials' };
    };

  async function boot(verdict: PeekVerdict, interactive: boolean): Promise<{ p: CoreParts; spy: SpyThrottle }> {
    const spy = new SpyThrottle(verdict);
    const s = new FakeStrategy({ name: interactive ? 'pw' : 'token', kinds: ['bearer'], interactive, keys: () => [{ kind: 'account', value: 'acct-1' }], verify: verifier(() => spy, interactive ? 'password' : 'token') });
    parts = await buildCore({}, { throttle: () => spy, strategies: [{ name: s.name, service: `Svc_${s.name}`, instance: s, listed: true }] });
    parts.identities.add({ id: OWNER.id, login: 'owner@example.test' });
    return { p: parts, spy };
  }

  it('does not call succeed when the peek reports a clean key set', async () => {
    const { p, spy } = await boot({ allowed: true, clean: true }, false);
    success(await p.service.authenticate({ kind: 'bearer', token: 'spt_good' }, ctx()));
    assert.deepStrictEqual(spy.calls, ['peek:login', 'verify']);
  });

  it('calls succeed once when the peek reports live rows for the keys', async () => {
    const { p, spy } = await boot({ allowed: true, clean: false }, false);
    success(await p.service.authenticate({ kind: 'bearer', token: 'spt_good' }, ctx()));
    assert.deepStrictEqual(spy.calls, ['peek:login', 'verify', 'succeed:login']);
    assert.strictEqual(spy.count('succeed:login'), 1);
  });

  it('still counts a per-request failure after verify, whatever the peek said', async () => {
    const { p, spy } = await boot({ allowed: true, clean: true }, false);
    const r = await p.service.authenticate({ kind: 'bearer', token: 'spt_bad' }, ctx());
    assert.strictEqual(r.status, 'failure');
    assert.deepStrictEqual(spy.calls, ['peek:login', 'verify', 'attempt:login']);
  });

  it('keeps an interactive login counted before verify and succeeded after (A05)', async () => {
    const { p, spy } = await boot({ allowed: true, clean: true }, true);
    success(await p.service.authenticate({ kind: 'bearer', token: 'pw_good' }, ctx({ purpose: 'login' })));
    assert.deepStrictEqual(spy.calls, ['attempt:login', 'verify', 'succeed:login']);
  });
});
