import 'mocha';
import { runAuthnBehaviour } from '../src/behaviour/index.js';
import type { Facet } from '../src/behaviour/index.js';
import { referenceHarness } from './reference/harness.js';

const FACETS: Facet[] = ['A02/core', 'A02/external', 'A05/store', 'A05/core', 'A06/store', 'A06/core', 'A09/core'];

runAuthnBehaviour(['A02', 'A05', 'A06', 'A09'], (ctx) => referenceHarness(ctx), { title: 'reference: core facets', facets: FACETS, claim: FACETS });
