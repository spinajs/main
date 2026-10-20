import 'mocha';
import { runAuthnBehaviour } from '../src/behaviour/index.js';
import { fakeStoreHarness, referenceHarness } from './reference/harness.js';
import { referenceHttpHarness } from './reference/http-app.js';

runAuthnBehaviour(['A01'], (ctx) => referenceHarness(ctx), { title: 'reference: A01', facets: ['A01/core'], claim: ['A01/core'] });

// MemorySessionIssuer is the reference semantics of the session store facets (design §2.13).
runAuthnBehaviour(['A08'], (ctx) => fakeStoreHarness(ctx), { title: 'kit fakes: A08', facets: ['A08/store'], claim: ['A08/store'] });

runAuthnBehaviour(['A08'], (ctx) => referenceHttpHarness(ctx), { title: 'reference http app: A08', facets: ['A08/http'], claim: ['A08/http'] });
