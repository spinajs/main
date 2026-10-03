import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { runSessionIssuerConformance } from '@spinajs/authn-testing';
import { DefaultSessionIssuer } from '@spinajs/authn-session';
import { sessionKitHarness } from '../../authn-session/test/kit-harness.js';
import { bootStore, disposeStore, seedLegacyRow, storedKeys } from './support.js';

runSessionIssuerConformance(
  sessionKitHarness('DbSessionStore', async (session) => {
    await bootStore(session);
    const issuer = await DI.resolve(DefaultSessionIssuer);
    return {
      issuer,
      storage: {
        storedKeys,
        seedLegacy: async (r) => {
          const creation = DateTime.fromJSDate(r.creation);
          await seedLegacyRow({ rawId: r.rawId, user: r.user, authorized: r.authorized, impersonator: r.impersonator, creation, expiration: creation.plus({ minutes: 30 }) });
        },
      },
      dispose: disposeStore,
    };
  }),
  { title: 'session issuer conformance (DbSessionStore)' },
);
