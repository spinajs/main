import { DI } from '@spinajs/di';
import { MemorySessionStore } from '../src/index.js';
import { runSessionProviderConformance } from './conformance/session-provider-conformance.js';
import type { IConformanceExpiration } from './conformance/session-provider-conformance.js';
import { plantLegacyRow, uncacheOwned, withSessionConfig } from './support.js';

describe('MemorySessionStore', () => {
  after(() => {
    uncacheOwned();
  });

  runSessionProviderConformance(
    async (expiration: IConformanceExpiration) => {
      await withSessionConfig({ authn: { session: { service: 'MemorySessionStore', expiration } } });
      return DI.resolve(MemorySessionStore);
    },
    { seedLegacy: async (provider, row) => plantLegacyRow(provider as MemorySessionStore, row) },
  );
});
