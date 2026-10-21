import assert from 'node:assert/strict';
import 'mocha';
import { DI } from '@spinajs/di';
import { Perf, PerfSink } from '@spinajs/log-common';
import type { IPerfMetric } from '@spinajs/log-common';
import { FakeStrategy } from '@spinajs/authn-testing';

import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome } from '../../src/index.js';
import { buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const OWNER: IdentityRef = { type: 'user', id: 'owner-perf' };
const AUTHENTICATE = 'authn.authenticate';
const THROTTLE = 'authn.throttle.db';

class CapturingSink extends PerfSink {
  static metrics: IPerfMetric[] = [];
  public collect(metric: IPerfMetric): void {
    CapturingSink.metrics.push(metric);
  }
}

const ctx = (): AuthnContext => ({ now: new Date(), ip: '192.0.2.77', purpose: 'request' });
const named = (name: string) => CapturingSink.metrics.filter((m) => m.name === name);

describe('DefaultAuthnService perf metrics', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  beforeEach(() => {
    CapturingSink.metrics = [];
    Perf.Enabled = true;
    DI.register(CapturingSink).as(PerfSink);
    Perf.refreshSinks();
  });

  afterEach(async () => {
    DI.unregister(PerfSink, CapturingSink);
    Perf.refreshSinks();
    Perf.Enabled = true;
    await parts?.dispose();
    parts = undefined;
  });

  async function boot(interactive: boolean): Promise<CoreParts> {
    const verify = (c: Credentials): StrategyOutcome => (String((c as { token?: unknown }).token).endsWith('good') ? { ok: true, identity: OWNER, method: 'kit' } : { ok: false, reason: 'invalid_credentials' });
    const s = new FakeStrategy({ name: interactive ? 'pw' : 'token', kinds: ['bearer'], interactive, keys: () => [{ kind: 'account', value: 'acct-perf' }], verify });
    parts = await buildCore({}, { strategies: [{ name: s.name, service: `Svc_${s.name}`, instance: s, listed: true }] });
    parts.identities.add({ id: OWNER.id, login: 'owner@example.test' });
    return parts;
  }

  for (const interactive of [false, true]) {
    const kind = interactive ? 'interactive' : 'per-request';

    it(`emits one span labelled with the strategy and one throttle timing for a ${kind} success`, async () => {
      const p = await boot(interactive);
      const result = await p.service.authenticate({ kind: 'bearer', token: 'spt_good' }, ctx());
      assert.strictEqual(result.status === 'success' || result.status === 'mfa_required', true, JSON.stringify(result));

      const spans = named(AUTHENTICATE);
      assert.strictEqual(spans.length, 1);
      assert.strictEqual(spans[0].kind, 'span');
      assert.deepStrictEqual(spans[0].labels, { strategy: interactive ? 'pw' : 'token' });
      assert.strictEqual(typeof spans[0].durationMs, 'number');

      const timings = named(THROTTLE);
      assert.strictEqual(timings.length, 1);
      assert.strictEqual(timings[0].kind, 'value');
      assert.strictEqual(typeof timings[0].value, 'number');
      assert.ok((timings[0].value as number) >= 0);
    });
  }

  it('still emits the span for a refused credential', async () => {
    const p = await boot(false);
    const result = await p.service.authenticate({ kind: 'bearer', token: 'spt_bad' }, ctx());
    assert.strictEqual(result.status, 'failure');
    assert.strictEqual(named(AUTHENTICATE).length, 1);
    assert.deepStrictEqual(named(AUTHENTICATE)[0].labels, { strategy: 'token' });
  });

  it('labels a call no strategy takes with none, and times no throttle', async () => {
    const p = await boot(false);
    const result = await p.service.authenticate({ kind: 'password', login: 'a', password: 'b' }, ctx());
    assert.strictEqual(result.status, 'failure');
    assert.strictEqual(named(AUTHENTICATE).length, 1);
    assert.deepStrictEqual(named(AUTHENTICATE)[0].labels, { strategy: 'none' });
    assert.strictEqual(named(THROTTLE).length, 0);
  });

  it('emits nothing when Perf is disabled', async () => {
    const p = await boot(false);
    Perf.Enabled = false;
    await p.service.authenticate({ kind: 'bearer', token: 'spt_good' }, ctx());
    assert.strictEqual(CapturingSink.metrics.length, 0);
  });
});
