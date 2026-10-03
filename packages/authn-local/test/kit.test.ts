import 'mocha';
import { runAuthnBehaviour, runStrategyConformance } from '@spinajs/authn-testing';
import type { Facet } from '@spinajs/authn-testing';

import { localHarness, localStrategySubject, registerHarnessTypes, unregisterHarnessTypes } from './kit-harness.js';

const N3_FACETS: Facet[] = ['A02/local', 'A03/argon2', 'A04/local', 'A11/local', 'A13/local', 'A30/local'];

// Wrapped so the harness types live only while the kit runs; later suites register their own fakes under the same keys.
describe('authn-local kit acceptance', function () {
  before(registerHarnessTypes);
  after(unregisterHarnessTypes);

  runAuthnBehaviour(['A02', 'A03', 'A04', 'A11', 'A13', 'A30'], localHarness, {
    claim: N3_FACETS,
    facets: N3_FACETS,
    // argon2 at the library defaults on a slow host: every case gets at least a minute; the timing cases keep their 600 s.
    timeoutMs: 60_000,
    title: 'authn behaviour (authn-local)',
  });

  runStrategyConformance(localStrategySubject, { title: 'LocalPasswordStrategy conformance' });
});
