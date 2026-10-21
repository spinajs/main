import 'mocha';
import { randomUUID } from 'node:crypto';
import { runTokenServiceConformance } from '../src/conformance/index.js';
import { MemoryTokenService } from '../src/fakes/index.js';

describe('token service conformance wrapper', () => {
  runTokenServiceConformance('MemoryTokenService conformance', async () => ({
    service: new MemoryTokenService(),
    owners: { make: async () => ({ type: 'user', id: randomUUID() }) },
  }));
});
