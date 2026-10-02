import { MfaPolicy } from '@spinajs/authn/contracts';
import type { AuthenticationStrategy, AuthnEventSink, Credentials, AuthnFacts, AuthnService, AuthnThrottle, ExternalSubject, IdentityRef, MfaStep } from '@spinajs/authn/contracts';
import { KIT_ATTRIBUTES, throttleParams } from '../../src/behaviour/index.js';
import type { HarnessContext } from '../../src/behaviour/index.js';
import { EnrolledMfaPolicy, FakeIdentityStore, FakeMfaStep, FakeStrategy, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, fakeSeedPort } from '../../src/fakes/index.js';
import type { MemorySessionOptions } from '../../src/fakes/index.js';
import { UnsupportedConfig } from '../../src/harness/index.js';
import type { ConfigOverrides, Harness, ThrottleParams } from '../../src/harness/index.js';
import { referenceBoot } from './boot.js';
import { ReferenceAuthnService } from './service.js';
import type { ReferenceDeps } from './service.js';
import { ReferenceBackoffThrottle } from './throttle.js';

/** Config the reference applies; any other key makes the factory throw UnsupportedConfig. */
const SUPPORTED = ['authn.throttle', 'authn.session', 'authn.linking', 'authn.mfa.policy.force'];
/** The http app also applies these. */
export const HTTP_SUPPORTED = [...SUPPORTED, 'env', 'authn.http.trustProxy', 'authn.http.csrf'];
const STORE_SUPPORTED = ['authn.session'];

function leafKeys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    return [prefix];
  }
  return Object.entries(o).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

function checkConfig(config: ConfigOverrides, supported: readonly string[]): void {
  const unsupported = leafKeys(config).filter((k) => k !== '' && !supported.some((s) => k === s || k.startsWith(`${s}.`)));
  if (unsupported.length > 0) {
    throw new UnsupportedConfig(unsupported);
  }
}

const sessionOptions = (c: ConfigOverrides): MemorySessionOptions => {
  const s = c.authn?.session;
  return { idleMinutes: s?.expiration?.ttl, absoluteMinutes: s?.expiration?.maxLifetime, pendingTtlSeconds: s?.pendingTtlSeconds };
};

/** authn.mfa.policy.force: every password login needs the step, enrolled or not. */
class ForcedMfaPolicy extends MfaPolicy {
  constructor(private readonly step: MfaStep) {
    super();
  }
  async required(_id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]> {
    return facts.method === 'password' ? [this.step.name] : [];
  }
}

const attributedId = (c: Credentials): IdentityRef | undefined => (c as unknown as { id?: IdentityRef }).id;

const attributedStrategy = (name: string, kind: string, interactive: boolean) =>
  new FakeStrategy({
    name,
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

export interface ReferenceParts {
  readonly ctx: HarnessContext;
  readonly identities: FakeIdentityStore;
  readonly passwords: MemoryPasswordCredentialStore;
  readonly sessions: MemorySessionIssuer;
  readonly throttle: AuthnThrottle;
  readonly throttleParams: ThrottleParams;
  readonly events: RecordingEventSink;
  /** The live list the service publishes to; push a sink to add one. */
  readonly sinks: AuthnEventSink[];
  readonly principals: RecordingPrincipalFactory;
  readonly links: MemoryLinkStore;
  readonly step: FakeMfaStep;
  /** Bearer tokens the token strategy accepts: raw token → identity. */
  readonly tokens: Map<string, IdentityRef>;
  /** Subjects the external strategy (provider 'kit-idp') accepts. */
  readonly externalSubjects: Map<string, ExternalSubject>;
  readonly strategies: readonly AuthenticationStrategy[];
  readonly service: AuthnService;
}

export interface ReferenceOverrides {
  readonly throttle?: (params: ThrottleParams) => AuthnThrottle;
  readonly password?: (s: FakeStrategy, identities: FakeIdentityStore) => AuthenticationStrategy;
  readonly service?: (deps: ReferenceDeps) => AuthnService;
  /** Replaces the strategy list (BootPort). */
  readonly strategies?: readonly AuthenticationStrategy[];
}

/** Lets a batch add ports (and sinks through parts.sinks) without editing this file. */
export type ReferenceExtras = (base: Harness, parts: ReferenceParts) => Partial<Harness>;

export function buildReference(ctx: HarnessContext, over: ReferenceOverrides = {}, supported: readonly string[] = SUPPORTED): ReferenceParts & { readonly harness: Harness } {
  checkConfig(ctx.config, supported);
  const config = ctx.config;
  const linking = { jit: config.authn?.linking?.jit ?? false, byVerifiedEmail: config.authn?.linking?.byVerifiedEmail ?? false };
  const identities = new FakeIdentityStore({ jit: linking.jit });
  const passwords = new MemoryPasswordCredentialStore();
  const sessions = new MemorySessionIssuer(sessionOptions(config));
  const params = throttleParams(config);
  const throttle = over.throttle?.(params) ?? new ReferenceBackoffThrottle(params);
  const events = new RecordingEventSink();
  const second = new RecordingEventSink();
  const sinks: AuthnEventSink[] = [events, second];
  const principals = new RecordingPrincipalFactory();
  const links = new MemoryLinkStore();
  const step = new FakeMfaStep();
  const tokens = new Map<string, IdentityRef>();
  const externalSubjects = new Map<string, ExternalSubject>();
  const fakes = [FakeStrategy.password({ identities, passwords }), FakeStrategy.bearer({ tokens }), FakeStrategy.external({ provider: 'kit-idp', subjects: externalSubjects }), attributedStrategy('kit-attributed-login', 'kit-attributed-login', true), attributedStrategy('kit-attributed-request', 'kit-attributed-request', false)];
  const strategies = over.strategies ?? [over.password?.(fakes[0], identities) ?? fakes[0], ...fakes.slice(1)];
  const policy = config.authn?.mfa?.policy?.force ? new ForcedMfaPolicy(step) : new EnrolledMfaPolicy([step]);
  const deps: ReferenceDeps = { strategies, throttle, identities, links, linking, policy, steps: [step], sessions, sinks, principals };
  const service = over.service?.(deps) ?? new ReferenceAuthnService(deps);

  const harness: Harness = {
    service,
    seed: fakeSeedPort(identities, passwords),
    sessions,
    sessionStorage: sessions.storage,
    throttle: { throttle, params },
    events,
    sinks: [events, second],
    spy: { verifyCalls: () => fakes.reduce((n, s) => n + s.verifyCalls.length, 0) },
    mfa: { step, enrol: async (id) => step.enrol(id), code: async (id) => step.nextCode(id) },
    passwordStore: passwords,
    links,
    external: {
      provider: 'kit-idp',
      credentialsFor: async (subject) => {
        externalSubjects.set(subject.subject, { ...subject, provider: 'kit-idp' });
        return { kind: 'external', provider: 'kit-idp', payload: { subject: subject.subject } };
      },
    },
    attributed: { credentials: async (mode, id) => ({ kind: mode === 'interactive' ? 'kit-attributed-login' : 'kit-attributed-request', id }) },
    principals: { calls: () => principals.calls },
    boot: referenceBoot(ctx),
  };
  return { ctx, identities, passwords, sessions, throttle, throttleParams: params, events, sinks, principals, links, step, tokens, externalSubjects, strategies, service, harness };
}

/** The reference harness of design §10.3: the §22.4 flow over the kit fakes, with ctx.config applied. */
export function referenceHarness(ctx: HarnessContext, extras?: ReferenceExtras, over?: ReferenceOverrides): Harness {
  const parts = buildReference(ctx, over);
  return { ...parts.harness, ...extras?.(parts.harness, parts) };
}

/** Session store facets over MemorySessionIssuer and the identity fakes. */
export function fakeStoreHarness(ctx: HarnessContext, make: (o: MemorySessionOptions) => MemorySessionIssuer = (o) => new MemorySessionIssuer(o)): Harness {
  checkConfig(ctx.config, STORE_SUPPORTED);
  const sessions = make(sessionOptions(ctx.config));
  return { sessions, sessionStorage: sessions.storage, seed: fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore()) };
}

/** Throttle store facets over ReferenceBackoffThrottle (or a mutant of it). */
export function throttleHarness(ctx: HarnessContext, make: (p: ThrottleParams) => AuthnThrottle = (p) => new ReferenceBackoffThrottle(p)): Harness {
  checkConfig(ctx.config, ['authn.throttle']);
  const params = throttleParams(ctx.config);
  return { throttle: { throttle: make(params), params } };
}
