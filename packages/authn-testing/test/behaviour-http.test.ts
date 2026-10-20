import assert from 'node:assert/strict';
import 'mocha';
import { planCases, runAuthnBehaviour, settleCase } from '../src/behaviour/index.js';
import { FakeClock } from '../src/fakes/index.js';
import { UnsupportedConfig } from '../src/harness/index.js';
import { referenceHarness } from './reference/harness.js';
import { referenceHttpHarness } from './reference/http-app.js';

const factory = (ctx: Parameters<typeof referenceHttpHarness>[0]) => referenceHttpHarness(ctx);

// A09/http stays unclaimed: the reference app has no enrolment route, so the force row is pending there.
runAuthnBehaviour(['A02', 'A05', 'A07', 'A09'], factory, {
  title: 'reference http app',
  facets: ['A02/http', 'A05/http', 'A07/http', 'A09/http'],
  claim: ['A02/http', 'A05/http', 'A07/http'],
});

describe('reference http app: A09/http', () => {
  it('passes every A09/http case but the force row, which is pending', async () => {
    const results = [];
    for (const p of planCases(['A09'], { facets: ['A09/http'] })) {
      results.push(await settleCase(p, factory));
    }
    const failed = results.filter((r) => r.status === 'failed');
    assert.deepStrictEqual(
      failed.map((r) => `${r.title}: ${String(r.error)}`),
      [],
    );
    assert.deepStrictEqual(
      results.filter((r) => r.status === 'pending').map((r) => r.title),
      ['A09 under force a pending session reaches the enrolment routes only [pending: missing http.routes.mfaEnrol]'],
    );
    assert.strictEqual(results.length, 8);
  });
});

describe('reference harness config', () => {
  const ctx = (config: object) => ({ rule: 'A02', facet: 'A02/core', caseName: 'probe', clock: new FakeClock(), config } as Parameters<typeof referenceHttpHarness>[0]);

  it('refuses config it does not apply, and http config off the http app', () => {
    assert.throws(
      () => referenceHarness(ctx({ authn: { freshAuth: { maxAgeSeconds: 300 } } })),
      (e: Error) => e instanceof UnsupportedConfig && e.keys.includes('authn.freshAuth.maxAgeSeconds'),
    );
    assert.throws(() => referenceHarness(ctx({ authn: { http: { trustProxy: 1 } } })), UnsupportedConfig);
    assert.throws(() => referenceHarness(ctx({ env: 'production' })), UnsupportedConfig);
    assert.ok(referenceHttpHarness(ctx({ env: 'production', authn: { http: { trustProxy: 1, csrf: { enabled: false } } } })).http);
  });
});
