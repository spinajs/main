import 'mocha';
import { runAuthnBehaviour } from '@spinajs/authn-testing';
import type { Facet } from '@spinajs/authn-testing';

import { coreHarness, useHarnessLog } from './harness.js';

const FACETS: Facet[] = ['A01/core', 'A02/core', 'A02/external', 'A05/core', 'A06/core', 'A21/core', 'A23/core'];

// A06/core, A21/core and A23/core each hold one case that needs completeMfa (the `mfa` port); task 3 claims them.
const CLAIM: Facet[] = ['A01/core', 'A02/core', 'A02/external', 'A05/core'];

describe('N1 core behaviour', function () {
  useHarnessLog();
  runAuthnBehaviour(['A01', 'A02', 'A05', 'A06', 'A21', 'A23'], coreHarness, { title: 'authn behaviour: DefaultAuthnService', facets: FACETS, claim: CLAIM });
});
