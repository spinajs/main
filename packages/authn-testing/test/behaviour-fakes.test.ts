import 'mocha';
import { runAuthnBehaviour } from '../src/behaviour/index.js';
import { fakeStoreHarness } from './reference/harness.js';

// MemorySessionIssuer is the reference semantics of the session store facets (design §2.13).
runAuthnBehaviour(['A07', 'A09'], (ctx) => fakeStoreHarness(ctx), {
  title: 'kit fakes: MemorySessionIssuer',
  facets: ['A07/store', 'A09/store'],
  claim: ['A07/store', 'A09/store'],
});
