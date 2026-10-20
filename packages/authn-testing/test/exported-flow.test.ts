import 'mocha';
// Only the published entry point: what a lane without its own AuthnService (N3, N6, N7, N10) can build on.
import type { Credentials, IdentityRef } from '@spinajs/authn/contracts';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, FakeMfaStep, FakeStrategy, KIT_ATTRIBUTES, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, UnsupportedConfig, fakeSeedPort, runAuthnBehaviour, throttleParams } from '../src/index.js';
import type { Facet, Harness, HarnessContext } from '../src/index.js';

const attributedId = (c: Credentials): IdentityRef | undefined => (c as unknown as { id?: IdentityRef }).id;

const attributed = (kind: string, interactive: boolean): FakeStrategy =>
  new FakeStrategy({
    name: kind,
    kinds: [kind],
    interactive,
    keys: (c, ctx) => [
      { kind: 'account', value: `attr:${attributedId(c)?.id}` },
      { kind: 'account-ip', value: `attr:${attributedId(c)?.id}|${ctx.ip ?? ''}` },
    ],
    verify: (c) => {
      const id = attributedId(c);
      return id ? { ok: true, identity: id, method: 'kit', attributes: KIT_ATTRIBUTES } : { ok: false, reason: 'invalid_credentials' };
    },
  });

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
  const strategies = [local, attributed('kit-attributed-login', true), attributed('kit-attributed-request', false)];
  const service = new FakeAuthnService({
    strategies,
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
    spy: { verifyCalls: () => strategies.reduce((n, s) => n + s.verifyCalls.length, 0) },
    attributed: { credentials: async (mode, id) => ({ kind: mode === 'interactive' ? 'kit-attributed-login' : 'kit-attributed-request', id }) },
    mfa: { step, enrol: async (id) => step.enrol(id), code: async (id) => step.nextCode(id) },
  };
}

const FACETS: Facet[] = ['A02/core', 'A05/core', 'A05/store', 'A06/core', 'A06/store', 'A09/core'];

runAuthnBehaviour(['A02', 'A05', 'A06', 'A09'], laneHarness, { title: 'exported kit pieces: FakeAuthnService over the fakes', facets: FACETS, claim: FACETS });
