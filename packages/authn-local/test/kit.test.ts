import 'mocha';
import { expect } from 'chai';
import { runAuthnBehaviour, runStrategyConformance, timingDefaults, timingTimeoutMs } from '@spinajs/authn-testing';
import type { ConfigOverrides, Facet, HarnessContext } from '@spinajs/authn-testing';

import { localHarness, localStrategySubject, registerHarnessTypes, unregisterHarnessTypes } from './kit-harness.js';

const N3_FACETS: Facet[] = ['A02/local', 'A03/argon2', 'A04/local', 'A11/local', 'A13/local', 'A30/local'];

// Sized for a loaded host where one argon2 verify takes up to 500 ms; the kit's flat 600 s timed out there.
const TIMING_TIMEOUT_MS = timingTimeoutMs(timingDefaults(), 500);

// Wrapped so the harness types live only while the kit runs; later suites register their own fakes under the same keys.
describe('authn-local kit acceptance', function () {
  before(registerHarnessTypes);
  after(unregisterHarnessTypes);

  runAuthnBehaviour(['A02', 'A03', 'A04', 'A11', 'A13', 'A30'], localHarness, {
    claim: N3_FACETS,
    facets: N3_FACETS,
    timeoutMs: TIMING_TIMEOUT_MS,
    title: 'authn behaviour (authn-local)',
  });

  runStrategyConformance(localStrategySubject, { title: 'LocalPasswordStrategy conformance', timeoutMs: TIMING_TIMEOUT_MS });

  describe('kit harness config', function () {
    this.timeout(60_000);

    it('a partial pepper override takes the rest from the package config (version 1)', async () => {
      const config: ConfigOverrides = { authn: { local: { pepper: { secret: 'kit-harness-pepper-0123456789' } } } };
      const h = await localHarness({ config } as HarnessContext);
      try {
        const id = await h.seed!.user({ login: 'pepper@example.test', password: 'Pepper-Pass-1' });
        const stored = await h.passwordStore!.get(id);
        expect(stored!.startsWith('$sp1$$argon2id$'), stored!).to.equal(true);
      } finally {
        await h.dispose!();
      }
    });
  });
});
