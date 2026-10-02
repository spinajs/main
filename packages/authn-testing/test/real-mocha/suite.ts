// Run by real-mocha.test.ts in a child mocha process: the lane path (mocha globals, this.skip, this.timeout).
import 'mocha';
import { runAuthnBehaviour } from '../../src/behaviour/index.js';
import { runStrategyConformance } from '../../src/conformance/index.js';
import { FAST_TIMING, passwordSubject } from '../reference/conformance-support.js';
import { fakeStoreHarness } from '../reference/harness.js';

runAuthnBehaviour(['A07'], (ctx) => fakeStoreHarness(ctx), { title: 'real mocha: behaviour', facets: ['A07/store', 'A07/http'], claim: ['A07/store'] });
runStrategyConformance(passwordSubject(), { title: 'real mocha: FakeStrategy.password', timing: FAST_TIMING });
