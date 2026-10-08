import assert from 'node:assert/strict';
import 'mocha';
import { InvalidOption } from '@spinajs/exceptions';
import { runAuthnBehaviour } from '@spinajs/authn-testing';
import type { Facet } from '@spinajs/authn-testing';

import { bootPort, coreHarness, useHarnessLog } from './harness.js';

// A10/core is N8b's in the kit README; N1 claims it too because completeMfa counts codes in the mfa flow (task 3).
// A05/store and A06/store run in test/throttle/memory-throttle.test.ts (runThrottleConformance).
const FACETS: Facet[] = ['A01/core', 'A02/core', 'A02/external', 'A05/core', 'A06/core', 'A09/core', 'A10/core', 'A13/core', 'A19/core', 'A20/core', 'A21/core', 'A23/core', 'A24/boot'];

describe('N1 core behaviour', function () {
  useHarnessLog();
  runAuthnBehaviour(['A01', 'A02', 'A05', 'A06', 'A09', 'A10', 'A13', 'A19', 'A20', 'A21', 'A23', 'A24'], coreHarness, { title: 'authn behaviour: DefaultAuthnService', facets: FACETS, claim: FACETS });

  describe('boot port', () => {
    it('A01 an unknown service name fails boot in the strategy registry', async () => {
      const b = await bootPort().start({ strategies: [{ name: 'ghost', service: 'KitNoSuchStrategy', listed: true }] });
      assert.strictEqual(b.ok, false);
      const error = (b as { error: unknown }).error;
      assert.ok(error instanceof InvalidOption, String(error));
      assert.match(error.message, /authn\.strategies entry "ghost": no AuthenticationStrategy is registered as service "KitNoSuchStrategy"/);
    });
  });
});
