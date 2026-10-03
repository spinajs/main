import 'mocha';
import { runAuthnBehaviour } from '@spinajs/authn-testing';
import { keysHarness } from './harness.js';

runAuthnBehaviour(['A17'], (ctx) => keysHarness(ctx, 'memory'), { title: 'authn-keys: A17 keys, memory store', facets: ['A17/keys'], claim: ['A17/keys'] });

runAuthnBehaviour(['A17'], (ctx) => keysHarness(ctx, 'sqlite'), { title: 'authn-keys: A17 keys, sqlite store', facets: ['A17/keys'], claim: ['A17/keys'], timeoutMs: 30_000 });
