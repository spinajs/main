import { DI } from '@spinajs/di';
import { runSessionIssuerConformance } from '@spinajs/authn-testing';
import { DefaultSessionIssuer } from '@spinajs/authn-session';
import { sessionKitHarness } from '../../authn-session/test/kit-harness.js';
import { bootStore, disposeStore, storedKeys } from './support.js';

runSessionIssuerConformance(
  sessionKitHarness('DynamoDbSessionProvider', async (session) => {
    const store = await bootStore(session);
    await store.truncate();
    const issuer = await DI.resolve(DefaultSessionIssuer);
    return {
      issuer,
      storage: { storedKeys: () => storedKeys(store) },
      dispose: disposeStore,
    };
  }),
  { title: 'session issuer conformance (DynamoDbSessionProvider)' },
);
