import 'mocha';
import { runAuthnBehaviour } from '@spinajs/authn-testing';
import { keysHarness } from './harness.js';

// A17/http belongs to N8b (the routes); it stays pending here.
for (const kind of ['memory', 'sqlite'] as const) {
  runAuthnBehaviour(['A17', 'A18'], (ctx) => keysHarness(ctx, kind), {
    title: `authn-keys: A17 and A18, ${kind} store`,
    facets: ['A17/keys', 'A17/jws', 'A17/core', 'A18/core'],
    claim: ['A17/keys', 'A17/jws', 'A17/core', 'A18/core'],
    timeoutMs: 30_000,
  });
}
