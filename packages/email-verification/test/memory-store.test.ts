import { MemoryEmailVerificationStore } from '../src/stores/memory.js';
import { storeContract } from '../src/testing/index.js';

storeContract('MemoryEmailVerificationStore', async () => new MemoryEmailVerificationStore());
