import assert from 'node:assert/strict';
import 'mocha';
import { SpanStatusCode } from '@opentelemetry/api';
import { FakeStrategy } from '@spinajs/authn-testing';
import { useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome } from '../../src/index.js';
import { buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const OWNER: IdentityRef = { type: 'user', id: 'owner-trace' };
const ctx = (): AuthnContext => ({ now: new Date(), ip: '192.0.2.78', purpose: 'request' });

describe('DefaultAuthnService spans', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;
  let spans: InMemorySpans;

  beforeEach(() => {
    spans = useInMemorySpans();
  });

  afterEach(async () => {
    await spans.detach();
    await parts?.dispose();
    parts = undefined;
  });

  async function boot(): Promise<CoreParts> {
    const verify = (c: Credentials): StrategyOutcome => (String((c as { token?: unknown }).token).endsWith('good') ? { ok: true, identity: OWNER, method: 'kit' } : { ok: false, reason: 'invalid_credentials' });
    const s = new FakeStrategy({ name: 'token', kinds: ['bearer'], interactive: false, keys: () => [{ kind: 'account', value: 'acct-trace' }], verify });
    parts = await buildCore({}, { strategies: [{ name: s.name, service: `Svc_${s.name}`, instance: s, listed: true }] });
    parts.identities.add({ id: OWNER.id, login: 'owner-trace@example.test' });
    return parts;
  }

  it('records one authn.authenticate span with the strategy, the status and the principal id', async () => {
    const p = await boot();
    const result = await p.service.authenticate({ kind: 'bearer', token: 'spt_good' }, ctx());
    assert.strictEqual(result.status, 'success', JSON.stringify(result));

    const found = spans.byName('authn.authenticate');
    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual(
      { strategy: found[0].attributes['spina.authn.strategy'], status: found[0].attributes['spina.authn.status'], principal: found[0].attributes['spina.principal.id'] },
      { strategy: 'token', status: 'success', principal: 'user:owner-trace' },
    );
  });

  it('records a refused credential with its reason and no ERROR status', async () => {
    const p = await boot();
    const result = await p.service.authenticate({ kind: 'bearer', token: 'spt_bad' }, ctx());
    assert.strictEqual(result.status, 'failure');

    const [span] = spans.byName('authn.authenticate');
    assert.strictEqual(span.attributes['spina.authn.status'], 'failure');
    assert.strictEqual(span.attributes['spina.authn.reason'], 'invalid_credentials');
    assert.strictEqual(span.attributes['spina.principal.id'], undefined);
    assert.strictEqual(span.status.code, SpanStatusCode.UNSET);
  });
});
