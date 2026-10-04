import 'mocha';
import { expect } from 'chai';
import { MemorySessionIssuer, RecordingEventSink, UnsupportedConfig, runAuthnBehaviour, runStrategyConformance } from '@spinajs/authn-testing';
import type { HarnessContext, StrategySubject } from '@spinajs/authn-testing';
import type { Credentials } from '@spinajs/authn/contracts';

import { encodeFlow } from '../src/flow/cookie.js';
import { oidcHarness } from './support/harness.js';
import { ORIGIN, world } from './support/world.js';

const FACETS = ['A02/external', 'A19/oidc', 'A27/oidc'] as const;

runAuthnBehaviour(['A02', 'A19', 'A27'], oidcHarness, { title: 'authn-oidc: A02, A19, A27', claim: [...FACETS], facets: [...FACETS] });

async function oidcSubject(): Promise<StrategySubject> {
  const w = await world();
  await w.links.link({ type: 'user', id: 'conformance-user' }, { provider: 'oidc:corp', subject: 'conf-1' });
  const credentials = async (tamper?: 'wrong-nonce'): Promise<Credentials> => {
    const { flow, location } = await w.provider.begin({ redirectUri: `${ORIGIN}/auth/oidc/corp/callback`, mode: 'login', now: new Date() });
    return { kind: 'external', provider: 'oidc:corp', payload: { flow: encodeFlow(flow), query: w.idp.authorize(location, { claims: { sub: 'conf-1' }, ...(tamper ? { tamper } : {}) }) } };
  };
  const sessions = new MemorySessionIssuer();
  return {
    strategy: w.strategy,
    valid: () => credentials(),
    invalid: () => credentials('wrong-nonce'),
    // No unknown(): the strategy looks up no account; the core links the external subject.
    secretsOf: (c) => {
      const p = (c as unknown as { payload: { flow: string; query: Record<string, string> } }).payload;
      return [p.flow, p.query.code, p.query.state];
    },
    sessions: { count: async () => (await sessions.storage.storedKeys()).length },
    events: new RecordingEventSink(),
  };
}

runStrategyConformance(oidcSubject, { title: 'OidcStrategy conformance' });

describe('authn-oidc behaviour harness', () => {
  it('refuses config it cannot apply', async () => {
    const err = await oidcHarness({ config: { authn: { token: { maxTtlDays: 7 } } } } as unknown as HarnessContext).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(UnsupportedConfig);
  });
});
