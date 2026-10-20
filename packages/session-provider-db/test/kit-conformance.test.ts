import { DI } from '@spinajs/di';
import { runSessionIssuerConformance } from '@spinajs/authn-testing';
import { DefaultSessionIssuer } from '@spinajs/authn-session';
import { sessionKitHarness } from '../../authn-session/test/kit-harness.js';
import { bootStore, disposeStore, storedKeys } from './support.js';

runSessionIssuerConformance(
  sessionKitHarness('DbSessionStore', async (session) => {
    await bootStore(session);
    const issuer = await DI.resolve(DefaultSessionIssuer);
    return {
      issuer,
      storage: { storedKeys },
      dispose: disposeStore,
    };
  }),
  { title: 'session issuer conformance (DbSessionStore)' },
);
