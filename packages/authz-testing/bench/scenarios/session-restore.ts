import { DefaultSessionIssuer, MemorySessionStore, SessionExpirationProvider, SessionProvider, SlidingExpiration } from '@spinajs/authn-session';
import { DbSessionStore } from '@spinajs/session-provider-db';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, SessionHandle } from '@spinajs/authn/contracts';

import type { Scenario } from '../lib.js';
import { bootAuthn } from './_authn-boot.js';
import type { AuthnBoot } from './_authn-boot.js';

const FACTS: AuthnFacts = { method: 'password', strategy: 'password', assurance: 'aal1', mfa: [], authenticatedAt: new Date() };

// The store `service` is resolved by name from authn.session.service.
function restoreScenario(name: string, description: string, service: string, store: unknown, iterations: number): Scenario {
  let boot: AuthnBoot;
  let issuer: DefaultSessionIssuer;
  let handle: SessionHandle;

  return {
    name,
    description,
    iterations,
    warmup: iterations / 10,
    setup: async () => {
      boot = await bootAuthn({ session: { service, expiration: { service: 'SlidingExpiration', ttl: 60 } } });
      boot.own(SessionProvider, store, SessionExpirationProvider, SlidingExpiration, DefaultSessionIssuer, SessionIssuer);
      issuer = await boot.resolve(DefaultSessionIssuer);
      handle = await issuer.issue({ type: 'user', id: 'bench-user' }, FACTS);
    },
    verify: async () => {
      const session = await issuer.restore(handle.id);
      if (session?.identity.id !== 'bench-user' || session.handle.state !== 'active') {
        throw new Error(`restore did not return the issued active session: ${JSON.stringify(session?.identity)}`);
      }
    },
    teardown: async () => {
      await boot?.dispose();
    },
    run: () => issuer.restore(handle.id),
  };
}

export default [restoreScenario('session.restore.memory', 'DefaultSessionIssuer.restore over MemorySessionStore, sliding 60 min', 'MemorySessionStore', MemorySessionStore, 50_000), restoreScenario('session.restore.sqlite', 'DefaultSessionIssuer.restore over DbSessionStore on in-memory sqlite, sliding 60 min', 'DbSessionStore', DbSessionStore, 5_000)] satisfies Scenario[];
