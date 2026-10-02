import 'mocha';
// Only the published entry point: what a lane without its own AuthnService (N3, N6, N7, N10) can build on.
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, FakeMfaStep, FakeStrategy, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, UnsupportedConfig, fakeSeedPort, runAuthnBehaviour, throttleParams } from '../src/index.js';
import type { Facet, Harness, HarnessContext } from '../src/index.js';

function laneHarness(ctx: HarnessContext): Harness {
  const unsupported = Object.keys(ctx.config.authn ?? {}).filter((k) => k !== 'throttle');
  if (ctx.config.env || ctx.config.http || unsupported.length > 0) {
    throw new UnsupportedConfig(unsupported.map((k) => `authn.${k}`));
  }
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const sessions = new MemorySessionIssuer();
  const params = throttleParams(ctx.config);
  const throttle = new FakeBackoffThrottle(params);
  const events = new RecordingEventSink();
  const step = new FakeMfaStep();
  const local = FakeStrategy.password({ identities, passwords });
  const service = new FakeAuthnService({
    strategies: [local],
    throttle,
    identities,
    links: new MemoryLinkStore(),
    linking: { jit: false, byVerifiedEmail: false },
    policy: new EnrolledMfaPolicy([step]),
    steps: [step],
    sessions,
    sinks: [events],
    principals: new RecordingPrincipalFactory(),
  });
  return {
    service,
    seed: fakeSeedPort(identities, passwords),
    sessions,
    throttle: { throttle, params },
    events,
    spy: { verifyCalls: () => local.verifyCalls.length },
    mfa: { step, enrol: async (id) => step.enrol(id), code: async (id) => step.nextCode(id) },
  };
}

const FACETS: Facet[] = ['A02/core', 'A05/core', 'A05/store', 'A06/core', 'A06/store', 'A09/core'];

runAuthnBehaviour(['A02', 'A05', 'A06', 'A09'], laneHarness, { title: 'exported kit pieces: FakeAuthnService over the fakes', facets: FACETS, claim: FACETS });
