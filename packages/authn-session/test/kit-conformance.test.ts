import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import { runSessionIssuerConformance } from '@spinajs/authn-testing';
import { DefaultSessionIssuer, MemorySessionStore } from '../src/index.js';
import type { ISession } from '../src/index.js';
import { sessionKitHarness } from './kit-harness.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const rowsOf = (store: MemorySessionStore) => (store as unknown as { Sessions: Map<string, ISession> }).Sessions;

runSessionIssuerConformance(
  sessionKitHarness('MemorySessionStore', async (session) => {
    await withSessionConfig({ authn: { session } }, [DefaultSessionIssuer, SessionIssuer]);
    const issuer = await DI.resolve(DefaultSessionIssuer);
    const store = await DI.resolve(MemorySessionStore);
    await store.truncate();
    return {
      issuer,
      storage: {
        storedKeys: async () => [...rowsOf(store).keys()],
      },
      dispose: async () => uncacheOwned([DefaultSessionIssuer, SessionIssuer]),
    };
  }),
  { title: 'session issuer conformance (MemorySessionStore)' },
);
