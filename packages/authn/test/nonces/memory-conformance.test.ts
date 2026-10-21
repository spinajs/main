import 'mocha';
import { runNonceStoreConformance } from '@spinajs/authn-testing';

import { MemoryNonceStore } from '../../src/nonces/index.js';

runNonceStoreConformance('MemoryNonceStore conformance', async () => new MemoryNonceStore());
