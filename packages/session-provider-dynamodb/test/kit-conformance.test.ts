import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { runSessionIssuerConformance } from '@spinajs/authn-testing';
import { DefaultSessionIssuer } from '@spinajs/authn-session';
import { sessionKitHarness } from '../../authn-session/test/kit-harness.js';
import { bootStore, disposeStore, storedKeys, writeLegacyRow } from './support.js';

runSessionIssuerConformance(
  sessionKitHarness('DynamoDbSessionProvider', async (session) => {
    const store = await bootStore(session);
    await store.truncate();
    const issuer = await DI.resolve(DefaultSessionIssuer);
    return {
      issuer,
      storage: {
        storedKeys: () => storedKeys(store),
        seedLegacy: async (r) => {
          const creation = DateTime.fromJSDate(r.creation);
          await writeLegacyRow(store, { rawId: r.rawId, user: r.user, authorized: r.authorized, impersonator: r.impersonator, creation, expiration: creation.plus({ minutes: 30 }) });
        },
      },
      dispose: disposeStore,
    };
  }),
  { title: 'session issuer conformance (DynamoDbSessionProvider)' },
);
