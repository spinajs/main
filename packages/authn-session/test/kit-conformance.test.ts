import { DateTime } from 'luxon';
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
        seedLegacy: async (r) => {
          const creation = DateTime.fromJSDate(r.creation);
          const data = new Map<string, unknown>([
            ['User', r.user],
            ['Logged', true],
            ['Authorized', r.authorized],
            ...(r.impersonator ? ([['Impersonator', r.impersonator]] as [string, unknown][]) : []),
          ]);
          rowsOf(store).set(r.rawId, { SessionId: r.rawId, Creation: creation, Expiration: creation.plus({ minutes: 30 }), Data: data } as unknown as ISession);
        },
      },
      dispose: async () => uncacheOwned([DefaultSessionIssuer, SessionIssuer]),
    };
  }),
  { title: 'session issuer conformance (MemorySessionStore)' },
);
