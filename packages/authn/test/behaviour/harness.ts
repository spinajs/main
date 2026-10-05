import { randomBytes } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { FakeIdentityStore, FakeImpersonationGuard, FakeMfaStep, FakeStrategy, KIT_ATTRIBUTES, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, UnsupportedConfig, fakeSeedPort } from '@spinajs/authn-testing';
import type { BootPort, BootSpec, ConfigOverrides, Harness, HarnessContext, MemorySessionOptions } from '@spinajs/authn-testing';

import { AUTHN_CONFIGURATION_SCHEMA, AUTHN_PUBLIC_COOKIE_SECRET, AccountLinkService, AuthenticationStrategy, checkAuthnConfig, AuthnEventSink, AuthnService, AuthnThrottle, IdentityLinkStore, IdentityStore, ImpersonationGuard, AuthnImpersonationService, MemoryAuthnThrottle, MfaStep, PasswordCredentialStore, PrincipalFactory, SessionIssuer } from '../../src/index.js';
import type { Credentials, ExternalSubject, IdentityRef } from '../../src/index.js';
import { TestLog, useTestLog } from '../audit/test-log.js';

/** Config keys the harness applies; any other key makes the factory throw UnsupportedConfig. */
export const CORE_SUPPORTED: readonly string[] = ['env', 'authn.throttle', 'authn.linking', 'authn.session', 'authn.mfa.policy.force', 'authn.freshAuth', 'authn.impersonation'];

/** The service name of the kit MFA step, listed in authn.mfa.steps. */
export const KIT_MFA_STEP = 'KitMfaStep';

/** Registers a capturing DI Log for the `logs` port; call inside the describe that runs the harness. */
export const useHarnessLog = useTestLog;

export interface StrategySpec {
  readonly name: string;
  readonly service: string;
  readonly instance?: AuthenticationStrategy;
  readonly listed: boolean;
}

/** Neighbours a test may leave unregistered. */
export type Neighbour = 'IdentityStore' | 'IdentityLinkStore' | 'SessionIssuer' | 'PrincipalFactory' | 'PasswordCredentialStore' | 'ImpersonationGuard';

export interface CoreOptions {
  /** Replaces the kit strategies. */
  readonly strategies?: readonly StrategySpec[];
  /** Builds the throttle registered as `MemoryAuthnThrottle` from the child's Configuration. */
  readonly throttle?: (configuration: Configuration) => AuthnThrottle;
  /** Merged into the app config after the semantic overrides (keys ConfigOverrides lacks). */
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly omit?: readonly Neighbour[];
  /** Extra registrations before the service resolves. */
  readonly register?: (child: IContainer) => void;
  /** The kit MFA step declares that it stores secrets (D3). */
  readonly secretStoringStep?: boolean;
  /** Names no env, as an app started without --env, APP_ENV or NODE_ENV (else `config.env`, else test). */
  readonly unsetEnv?: boolean;
}

export interface CoreParts {
  readonly child: IContainer;
  readonly configuration: Configuration;
  readonly service: AuthnService;
  readonly identities: FakeIdentityStore;
  readonly passwords: MemoryPasswordCredentialStore;
  readonly sessions: MemorySessionIssuer;
  readonly throttle: AuthnThrottle;
  readonly events: RecordingEventSink;
  readonly second: RecordingEventSink;
  readonly principals: RecordingPrincipalFactory;
  readonly links: MemoryLinkStore;
  readonly step: FakeMfaStep;
  readonly guard: FakeImpersonationGuard;
  /** Bearer tokens the kit token strategy accepts: raw token → identity. */
  readonly tokens: Map<string, IdentityRef>;
  /** Subjects the kit external strategy (provider 'kit-idp') accepts. */
  readonly externalSubjects: Map<string, ExternalSubject>;
  readonly strategies: readonly StrategySpec[];
  dispose(): Promise<void>;
}

function leafKeys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [prefix];
  return Object.entries(o).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

function checkConfig(config: ConfigOverrides, supported: readonly string[] = CORE_SUPPORTED): void {
  const unsupported = leafKeys(config).filter((k) => k !== '' && !supported.some((s) => k === s || k.startsWith(`${s}.`)));
  if (unsupported.length > 0) throw new UnsupportedConfig(unsupported);
}

const sessionOptions = (c: ConfigOverrides): MemorySessionOptions => {
  const s = c.authn?.session;
  return { idleMinutes: s?.expiration?.ttl, absoluteMinutes: s?.expiration?.maxLifetime, pendingTtlSeconds: s?.pendingTtlSeconds };
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base: Record<string, unknown>, over: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/**
 * A Configuration class per container, so each boot reads its own values. `env` is the app env it resolves
 * (`process.env.APP_ENV`); undefined leaves it to the process, as an app started without `--env`. Unless `isolated`,
 * the file sources run as in an app; they load the package configs of node_modules/@spinajs only in ESM mode.
 */
export function configurationOf(values: Record<string, unknown>, env?: string, isolated = false): Class<Configuration> {
  const json = JSON.stringify(values);
  return class HarnessConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      if (env !== undefined) this.Env = env;
    }

    protected loadSources(): void {
      if (isolated) this.Sources = [];
      else super.loadSources();
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

/** A named factory: registries look services up by the registration's name. */
export function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

const attributedId = (c: Credentials): IdentityRef | undefined => (c as unknown as { id?: IdentityRef }).id;

const attributedStrategy = (name: string, kind: string, interactive: boolean): FakeStrategy =>
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

function kitStrategies(identities: FakeIdentityStore, passwords: MemoryPasswordCredentialStore, tokens: Map<string, IdentityRef>, subjects: Map<string, ExternalSubject>): StrategySpec[] {
  return [
    { name: 'local', service: 'KitPasswordStrategy', instance: FakeStrategy.password({ identities, passwords }), listed: true },
    { name: 'token', service: 'KitBearerStrategy', instance: FakeStrategy.bearer({ tokens }), listed: true },
    { name: 'fake-idp', service: 'KitExternalStrategy', instance: FakeStrategy.external({ provider: 'kit-idp', subjects }), listed: true },
    { name: 'kit-attributed-login', service: 'KitAttributedLogin', instance: attributedStrategy('kit-attributed-login', 'kit-attributed-login', true), listed: true },
    { name: 'kit-attributed-request', service: 'KitAttributedRequest', instance: attributedStrategy('kit-attributed-request', 'kit-attributed-request', false), listed: true },
  ];
}

/**
 * The real DefaultAuthnService, StrategyRegistry, AuthnAudit, LogAuthnAuditSink, MfaStepRegistry, DefaultMfaPolicy and
 * MemoryAuthnThrottle, resolved in a fresh child container with its own Configuration (all of them are per container,
 * D11), over kit fakes for the neighbours N1 does not own. The kit MFA step (`fake`) is listed in `authn.mfa.steps`.
 * The throttle is built from the child's Configuration and registered there under the name `MemoryAuthnThrottle`, so
 * each case gets its own rows and parameters.
 */
export async function buildCore(config: ConfigOverrides = {}, opts: CoreOptions = {}): Promise<CoreParts> {
  checkConfig(config);
  const parts = await prepareCore(config, opts);
  try {
    return { ...parts, service: await parts.child.resolve(AuthnService) };
  } catch (e) {
    await parts.dispose();
    throw e;
  }
}

// The part of the authn schema whose defaults the services read. Not the whole schema yet: the other blocks are still
// checked by hand, and their tests pass values the schema refuses. No $id, so it can sit beside the full schema.
const AUDIT_SCHEMA = { $configurationModule: 'authn', type: 'object', properties: { audit: AUTHN_CONFIGURATION_SCHEMA.properties.audit } };

/** buildCore up to, but not including, resolving the service. The app env is `config.env`, else `test`. */
async function prepareCore(config: ConfigOverrides, opts: CoreOptions): Promise<Omit<CoreParts, 'service'>> {
  const jit = config.authn?.linking?.jit ?? false;
  const identities = new FakeIdentityStore({ jit });
  const passwords = new MemoryPasswordCredentialStore();
  const sessions = new MemorySessionIssuer(sessionOptions(config));
  const events = new RecordingEventSink();
  const second = new RecordingEventSink();
  const principals = new RecordingPrincipalFactory();
  const links = new MemoryLinkStore();
  const step = new FakeMfaStep();
  if (opts.secretStoringStep) Object.defineProperty(step, 'storesSecrets', { value: true });
  const guard = new FakeImpersonationGuard();
  const tokens = new Map<string, IdentityRef>();
  const externalSubjects = new Map<string, ExternalSubject>();
  const strategies = opts.strategies ?? kitStrategies(identities, passwords, tokens, externalSubjects);

  const authn = deepMerge({ mfa: { steps: [{ name: step.name, service: KIT_MFA_STEP }] } }, { ...(config.authn ?? {}), strategies: strategies.filter((s) => s.listed).map((s) => ({ name: s.name, service: s.service })) });
  const values = deepMerge({ authn }, opts.raw ?? {});

  const child = DI.RootContainer.child();
  try {
    child.register(AUDIT_SCHEMA).asValue('__configurationSchema__');
    child.register(configurationOf(values, opts.unsetEnv ? undefined : (config.env ?? 'test'))).as(Configuration);
    const configuration = await child.resolve(Configuration);
    const throttle = (opts.throttle ?? ((c) => new MemoryAuthnThrottle(c)))(configuration);
    bind(child, AuthnThrottle, 'MemoryAuthnThrottle', throttle);
    const omit = new Set(opts.omit ?? []);
    const neighbours: [Neighbour, Class<unknown>, unknown][] = [
      ['IdentityStore', IdentityStore, identities],
      ['IdentityLinkStore', IdentityLinkStore, links],
      ['SessionIssuer', SessionIssuer, sessions],
      ['PrincipalFactory', PrincipalFactory, principals],
      ['PasswordCredentialStore', PasswordCredentialStore, passwords],
      ['ImpersonationGuard', ImpersonationGuard, guard],
    ];
    for (const [name, base, value] of neighbours) if (!omit.has(name)) bind(child, base, `Kit${name}`, value);
    bind(child, MfaStep, KIT_MFA_STEP, step);
    for (const s of strategies) if (s.instance) bind(child, AuthenticationStrategy, s.service, s.instance);
    bind(child, AuthnEventSink, 'KitEvents', events);
    bind(child, AuthnEventSink, 'KitEvents2', second);
    opts.register?.(child);
    return { child, configuration, identities, passwords, sessions, throttle, events, second, principals, links, step, guard, tokens, externalSubjects, strategies, dispose: () => child.dispose() };
  } catch (e) {
    await child.dispose();
    throw e;
  }
}

/** Keys a boot spec may set besides CORE_SUPPORTED: they only feed authn:check-config and the boot checks. */
const BOOT_SUPPORTED: readonly string[] = [...CORE_SUPPORTED, 'authn.strategies', 'authn.http', 'http'];

const strong = (): string => randomBytes(32).toString('hex');

/**
 * The spec as buildCore input. Secrets left out of the spec are strong, except the pepper, which is off. 'missing' and
 * 'off' are null: the http package config ships the public cookie secret, and a merge never removes a key.
 */
function bootInput(spec: BootSpec): { config: ConfigOverrides; opts: CoreOptions } {
  const given = spec.config ?? {};
  checkConfig(given, BOOT_SUPPORTED);
  const { strategies: listed, http: authnHttp, ...authnRest } = (given.authn ?? {}) as Record<string, unknown>;
  const s = spec.secrets ?? {};
  const raw = deepMerge(
    {
      http: { cookie: { secret: s.cookie === 'public' ? AUTHN_PUBLIC_COOKIE_SECRET : s.cookie === 'missing' ? null : strong() } },
      authn: {
        local: { pepper: { secret: s.pepper === 'strong' ? strong() : null, version: 1 } },
        mfa: { encryptionKey: { secret: s.mfaKey === 'missing' ? null : strong() } },
        ...(listed !== undefined ? { strategies: listed } : {}),
        ...(authnHttp !== undefined ? { http: authnHttp } : {}),
      },
    },
    given.http !== undefined ? { http: given.http } : {},
  );
  return {
    config: { env: spec.env ?? given.env, authn: authnRest },
    opts: { strategies: spec.strategies ?? [], raw, secretStoringStep: spec.mfaStep === 'secret-storing' },
  };
}

export function bootPort(): BootPort {
  return {
    async start(spec: BootSpec) {
      const { config, opts } = bootInput(spec);
      try {
        const parts = await buildCore(config, opts);
        return { ok: true, service: parts.service, dispose: parts.dispose };
      } catch (error) {
        if (error instanceof UnsupportedConfig) throw error;
        return { ok: false, error };
      }
    },
    async checkConfig(spec: BootSpec) {
      const { config, opts } = bootInput(spec);
      const parts = await prepareCore(config, opts);
      try {
        return await checkAuthnConfig(parts.child);
      } finally {
        await parts.dispose();
      }
    },
  };
}

const spyOf = (strategies: readonly StrategySpec[]) => ({
  verifyCalls: () => strategies.reduce((n, s) => n + ((s.instance as { verifyCalls?: unknown[] } | undefined)?.verifyCalls?.length ?? 0), 0),
});

/** Every port the core service has today. */
export function coreHarnessOf(parts: CoreParts): Harness {
  const logStart = TestLog.lines.length;
  return {
    service: parts.service,
    seed: fakeSeedPort(parts.identities, parts.passwords),
    sessions: parts.sessions,
    sessionStorage: parts.sessions.storage,
    throttle: { throttle: parts.throttle, params: (parts.throttle as MemoryAuthnThrottle).params },
    events: parts.events,
    sinks: [parts.events, parts.second],
    logs: { lines: () => TestLog.lines.slice(logStart).filter((l) => l.includes(' authn audit ')) },
    spy: spyOf(parts.strategies),
    mfa: { step: parts.step, enrol: async (id) => parts.step.enrol(id), code: async (id) => parts.step.nextCode(id) },
    passwordStore: parts.passwords,
    links: parts.links,
    accountLinks: {
      link: async (session, external, ctx) => (await parts.child.resolve(AccountLinkService)).link(session, external, ctx),
      unlink: async (session, linkId, ctx) => (await parts.child.resolve(AccountLinkService)).unlink(session, linkId, ctx),
    },
    impersonation: {
      start: async (session, target, ctx, reauth) => (await parts.child.resolve(AuthnImpersonationService)).start(session, target, ctx, reauth),
      stop: async (session, ctx) => (await parts.child.resolve(AuthnImpersonationService)).stop(session, ctx),
      principalOf: async (session, ctx) => (await parts.child.resolve(AuthnImpersonationService)).principalOf(session, ctx),
    },
    guard: parts.guard,
    external: {
      provider: 'kit-idp',
      credentialsFor: async (subject) => {
        parts.externalSubjects.set(subject.subject, { ...subject, provider: 'kit-idp' });
        return { kind: 'external', provider: 'kit-idp', payload: { subject: subject.subject } };
      },
    },
    attributed: { credentials: async (mode, id) => ({ kind: mode === 'interactive' ? 'kit-attributed-login' : 'kit-attributed-request', id }) },
    principals: { calls: () => parts.principals.calls },
    boot: bootPort(),
    dispose: parts.dispose,
  };
}

/** The lane's harness factory for runAuthnBehaviour. */
export async function coreHarness(ctx: HarnessContext): Promise<Harness> {
  return coreHarnessOf(await buildCore(ctx.config));
}
