import 'mocha';
import assert from 'node:assert/strict';
import { FakeClock, runAuthnBehaviour, UnsupportedConfig } from '@spinajs/authn-testing';
import type { ConfigOverrides } from '@spinajs/authn-testing';
import { disposeTotpHarnessDb, totpHarness } from './harness.js';

// A10/http belongs to N8b (the routes) and is not registered here.
for (const kind of ['memory', 'sqlite'] as const) {
  runAuthnBehaviour(['A10'], (ctx) => totpHarness(ctx, kind), {
    title: `authn-totp: A10, ${kind} store`,
    facets: ['A10/step', 'A10/totp', 'A10/core'],
    claim: ['A10/step', 'A10/totp', 'A10/core'],
    // Mid time step, so the 1 s tick in the throttle case stays in step T and the case proves the throttled attempt
    // did not spend it. The default start (the real time) would make that proof hold only by chance.
    clockStart: new Date('2026-10-04T10:00:15Z'),
    timeoutMs: 30_000,
  });
}

describe('v3 totpHarness config', () => {
  const build = (config: unknown) => totpHarness({ rule: 'A10', facet: 'A10/step', caseName: 'config', clock: new FakeClock(), config: config as ConfigOverrides });

  it('applies authn.mfa.totp options and authn.throttle', async () => {
    const h = await build({ authn: { mfa: { totp: { digits: 8, recoveryCodes: 3 } }, throttle: { resetAfterSeconds: 60 } } });
    assert.strictEqual(h.throttle?.params.resetAfterSeconds, 60);
  });

  it('refuses an unknown authn.mfa.totp key, another authn key and window 0', async () => {
    for (const [config, key] of [
      [{ authn: { mfa: { totp: { bogus: 1 } } } }, 'authn.mfa.totp.bogus'],
      [{ authn: { freshAuth: { maxAgeSeconds: 300 } } }, 'authn.freshAuth.maxAgeSeconds'],
      [{ authn: { mfa: { totp: { window: 0 } } } }, 'authn.mfa.totp.window'],
    ] as const) {
      await assert.rejects(build(config), (e: Error) => e instanceof UnsupportedConfig && e.message.includes(key), key);
    }
  });
});

after(async () => {
  await disposeTotpHarnessDb();
});
