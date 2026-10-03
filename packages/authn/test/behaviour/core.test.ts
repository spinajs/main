import 'mocha';
import { runAuthnBehaviour } from '@spinajs/authn-testing';
import type { Facet } from '@spinajs/authn-testing';

import { coreHarness, useHarnessLog } from './harness.js';

const FACETS: Facet[] = ['A01/core', 'A02/core', 'A02/external', 'A05/core', 'A06/core', 'A09/core', 'A10/core', 'A13/core', 'A19/core', 'A20/core', 'A21/core', 'A23/core'];

describe('N1 core behaviour', function () {
  useHarnessLog();
  runAuthnBehaviour(['A01', 'A02', 'A05', 'A06', 'A09', 'A10', 'A13', 'A19', 'A20', 'A21', 'A23'], coreHarness, { title: 'authn behaviour: DefaultAuthnService', facets: FACETS, claim: FACETS });
});
