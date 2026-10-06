import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { AuthenticationStrategy, AuthnEventSink, AuthnThrottle, IdentityStore, PasswordCredentialStore, PasswordService, SecretStore, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, PrincipalRef, TokenCreateOptions, TokenCreateResult, TokenRecord, TokenValidation } from '@spinajs/authn/contracts';
import {
  EnrolledMfaPolicy,
  FakeAuthnService,
  FakeBackoffThrottle,
  FakeIdentityStore,
  MemoryLinkStore,
  MemoryPasswordCredentialStore,
  MemorySecretStore,
  MemorySessionIssuer,
  RecordingEventSink,
  RecordingPrincipalFactory,
  UnsupportedConfig,
  throttleParams,
} from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HarnessContext, StrategySubject, ThrottleParams } from '@spinajs/authn-testing';

import packageConfig from '../src/config/authn-local.js';
import { Argon2PasswordHasher, PasswordHasher } from '../src/hasher.js';
import { PasswordMail, PasswordMailer } from '../src/mailer.js';
import { LocalPasswordPolicy, PasswordBlocklist } from '../src/policy.js';
import { LocalPasswordService } from '../src/service.js';
import { LocalPasswordStrategy } from '../src/strategy.js';

/** The ConfigOverrides keys this harness applies; any other key makes a case pending (or fail when claimed). */
const SUPPORTED = [
  'authn.local.hasher.maxConcurrent',
  'authn.local.pepper.secret',
  'authn.local.pepper.version',
  'authn.local.policy.minLength',
  'authn.local.policy.maxLength',
  'authn.local.policy.rule',
  'authn.local.policy.blocklist',
  'authn.local.reset.ttlSeconds',
  'authn.local.reset.revokeTokens',
  'authn.local.invite.ttlSeconds',
  'authn.throttle',
];

function leafKeys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    return [prefix];
  }
  return Object.entries(o).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

function checkSupported(config: ConfigOverrides): void {
  const unsupported = leafKeys(config).filter((k) => k !== '' && !SUPPORTED.some((s) => k === s || k.startsWith(`${s}.`)));
  if (unsupported.length > 0) {
    throw new UnsupportedConfig(unsupported);
  }
}

/** What the per-case DI types read; set before the container builds them. */
interface CaseState {
  values: Record<string, unknown>;
  params: ThrottleParams;
  blocklist: readonly string[];
}

let current: CaseState = { values: {}, params: throttleParams({}), blocklist: [] };

const BLACK_HOLE_LOGGER = {
  targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
  rules: [{ name: '*', level: 'trace', target: 'Empty' }],
};

type SchemaNode = { default?: unknown; properties?: Record<string, SchemaNode> };

/** What the schema would fill for this node: the defaults of its members over its own default. */
function schemaDefaults(node: SchemaNode | undefined): unknown {
  if (!node) return undefined;
  if (!node.properties) return node.default;
  const out: Record<string, unknown> = { ...((node.default as object | undefined) ?? {}) };
  for (const [key, member] of Object.entries(node.properties)) {
    const value = schemaDefaults(member);
    if (value !== undefined && !(key in out)) out[key] = value;
  }
  return out;
}

function withDefaults(value: unknown, defaults: unknown): unknown {
  const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!plain(value) || !plain(defaults)) return value === undefined ? defaults : value;
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, v] of Object.entries(value)) out[key] = withDefaults(v, defaults[key]);
  return out;
}

/** The harness reads no schema through a Configuration, so it fills the schema defaults itself. */
function schemaDefaultAt(parts: string[]): unknown {
  let node = parts[0] === 'authn' ? (AUTHN_CONFIGURATION_SCHEMA as SchemaNode) : undefined;
  for (const part of parts.slice(1)) node = node?.properties?.[part];
  return schemaDefaults(node);
}

/**
 * The case's values over this package's own `authn` config, then the code defaults. A FrameworkConfiguration would also merge
 * every installed package's config, and @spinajs/users still ships 2.x `authn.local` keys (a policy rule,
 * `expiration.enabled: true`) that are not §22.5 defaults.
 */
class HarnessConfiguration extends Configuration {
  public get RootConfig() {
    return { ...current.values, onConfigLoad: () => undefined };
  }
  public get<T>(path: string[] | string, defaultValue?: T): T {
    const parts = Array.isArray(path) ? path : path.split('.');
    let node: unknown = current.values;
    for (const p of parts) {
      if (node === null || typeof node !== 'object' || !(p in node)) {
        node = undefined;
        break;
      }
      node = (node as Record<string, unknown>)[p];
    }
    const filled = withDefaults(node, schemaDefaultAt(parts));
    return filled === undefined ? (defaultValue as T) : (filled as T);
  }
  public set(): void {}
  public merge(): void {}
  public async mergeSource(): Promise<void> {}
  public async load(): Promise<void> {}
  protected onLoad(): unknown {
    return {};
  }
}

class HarnessIdentityStore extends FakeIdentityStore {}
class HarnessPasswordStore extends MemoryPasswordCredentialStore {}
class HarnessSessionIssuer extends MemorySessionIssuer {}
class HarnessSecretStore extends MemorySecretStore {}
class HarnessSink extends RecordingEventSink {}
class HarnessSecondSink extends RecordingEventSink {}

class HarnessThrottle extends FakeBackoffThrottle {
  constructor() {
    super(current.params);
  }
}

/** `authn.local.policy.blocklist` in the kit is a list of strings; the policy takes the name of a PasswordBlocklist. */
class HarnessBlocklist extends PasswordBlocklist {
  private readonly list = new Set(current.blocklist);
  public async isBlocked(password: string): Promise<boolean> {
    return this.list.has(password);
  }
}

class HarnessMailer extends PasswordMailer {
  public readonly mails: PasswordMail[] = [];
  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }
  public secretFor(id: IdentityRef, purpose: 'reset' | 'invite'): string | null {
    const m = [...this.mails].reverse().find((x) => x.identity.type === id.type && x.identity.id === id.id && x.purpose === purpose);
    return m ? m.secret : null;
  }
}

interface StoredToken {
  readonly hash: string;
  readonly record: TokenRecord;
  revoked: boolean;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const sameRef = (a: IdentityRef, b: IdentityRef) => a.type === b.type && a.id === b.id;

/** Test-only TokenService: stores SHA-256 only; validate checks revocation and expiry against ctx.now. */
class HarnessTokenService extends TokenService {
  private readonly tokens: StoredToken[] = [];

  public async create(owner: IdentityRef, opts: TokenCreateOptions, ctx: AuthnContext): Promise<TokenCreateResult> {
    if ((opts.kind === 'agent') !== (opts.scope?.agent === true)) {
      return { ok: false, code: 'invalid_scope' };
    }
    if (opts.expiresAt.getTime() <= ctx.now.getTime()) {
      return { ok: false, code: 'invalid_expiry' };
    }
    const plaintext = `kit_${randomBytes(32).toString('base64url')}`;
    const record: TokenRecord = {
      id: randomUUID(),
      owner,
      name: opts.name,
      kind: opts.kind,
      ...(opts.scope ? { scope: opts.scope } : {}),
      createdAt: ctx.now,
      expiresAt: opts.expiresAt,
    };
    this.tokens.push({ hash: sha256hex(plaintext), record, revoked: false });
    return { ok: true, plaintext, record };
  }

  public async list(owner: IdentityRef): Promise<readonly TokenRecord[]> {
    return this.tokens.filter((t) => !t.revoked && sameRef(t.record.owner, owner)).map((t) => t.record);
  }

  public async revoke(owner: IdentityRef, id: string): Promise<boolean> {
    const t = this.tokens.find((x) => !x.revoked && x.record.id === id && sameRef(x.record.owner, owner));
    if (t) {
      t.revoked = true;
    }
    return t !== undefined;
  }

  public async revokeAllFor(owner: IdentityRef, _ctx: AuthnContext, _opts?: { readonly actor?: PrincipalRef }): Promise<number> {
    let n = 0;
    for (const t of this.tokens) {
      if (!t.revoked && sameRef(t.record.owner, owner)) {
        t.revoked = true;
        n++;
      }
    }
    return n;
  }

  public async validate(raw: string, ctx: AuthnContext): Promise<TokenValidation> {
    const t = this.tokens.find((x) => x.hash === sha256hex(raw));
    if (!t) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (t.revoked) {
      return { ok: false, reason: 'revoked' };
    }
    if (t.record.expiresAt.getTime() <= ctx.now.getTime()) {
      return { ok: false, reason: 'expired' };
    }
    if (t.record.kind === 'agent') {
      return {
        ok: true,
        identity: { type: 'agent', id: t.record.id },
        method: 'token',
        ceiling: { reason: 'out_of_scope' },
        delegation: { onBehalfOf: t.record.owner, mode: 'inherit' },
        token: t.record,
      };
    }
    return { ok: true, identity: t.record.owner, method: 'token', token: t.record };
  }
}

const REGISTRATIONS: [Function, Function][] = [
  [HarnessConfiguration, Configuration],
  [HarnessIdentityStore, IdentityStore],
  [HarnessPasswordStore, PasswordCredentialStore],
  [HarnessSessionIssuer, SessionIssuer],
  [HarnessSecretStore, SecretStore],
  [HarnessThrottle, AuthnThrottle],
  [HarnessSink, AuthnEventSink],
  [HarnessSecondSink, AuthnEventSink],
  [HarnessTokenService, TokenService],
  [HarnessMailer, PasswordMailer],
  [HarnessBlocklist, PasswordBlocklist],
];

/** Everything the container may cache for a case: the abstract keys, the fakes and the N3 classes. */
const CACHED: Function[] = [
  ...new Set([...REGISTRATIONS.flat(), PasswordHasher, Argon2PasswordHasher, LocalPasswordPolicy, PasswordService, LocalPasswordService, AuthenticationStrategy, LocalPasswordStrategy]),
];

/** Registers the per-case types; call once before the kit suites run (in a `before`). */
export function registerHarnessTypes(): void {
  DI.setESMModuleSupport();
  for (const [type, as] of REGISTRATIONS) {
    DI.register(type as never).as(as as never);
  }
}

/**
 * Undoes `registerHarnessTypes`. `DI.unregister` keeps the emptied key, so afterwards `DI.check(TokenService)` and the like stay
 * true and `DI.resolve` throws: a later suite that needs "none registered" must not rely on `DI.check` (DI owner hand-off).
 */
export function unregisterHarnessTypes(): void {
  freshContainer();
  for (const [type] of REGISTRATIONS) {
    DI.unregister(type as never);
  }
}

/** Never DI.clearCache(): only the types this harness registered or builds. */
function freshContainer(): void {
  for (const type of CACHED) {
    DI.uncache(type as never);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Objects merge key by key; anything else in `over`, arrays and null included, replaces the base value. */
function mergeOver(base: unknown, over: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(isPlainObject(over) ? over : {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeOver(out[k], v) : v;
  }
  return out;
}

/** Maps ConfigOverrides onto the `authn.local` keys N3 reads; the blocklist list becomes the name of HarnessBlocklist. */
function applyConfig(config: ConfigOverrides): void {
  checkSupported(config);
  const local = config.authn?.local ?? {};
  const blocklist = local.policy?.blocklist ?? null;
  const policy = { ...local.policy, blocklist: blocklist && blocklist.length > 0 ? HarnessBlocklist.name : null };
  current = {
    values: { logger: BLACK_HOLE_LOGGER, authn: mergeOver(packageConfig.authn, { local: { ...local, policy } }) },
    params: throttleParams(config),
    blocklist: blocklist ?? [],
  };
}

export interface LocalParts {
  readonly identities: HarnessIdentityStore;
  readonly passwords: HarnessPasswordStore;
  readonly sessions: HarnessSessionIssuer;
  readonly secrets: HarnessSecretStore;
  readonly throttle: HarnessThrottle;
  readonly sinks: readonly RecordingEventSink[];
  readonly tokens: HarnessTokenService;
  readonly mailer: HarnessMailer;
  readonly hasher: Argon2PasswordHasher;
  readonly strategy: LocalPasswordStrategy;
  readonly password: LocalPasswordService;
}

/** A fresh container for `config`, resolved as at boot (the hasher's dummy hash is made here, D4). */
async function buildParts(config: ConfigOverrides): Promise<LocalParts> {
  applyConfig(config);
  freshContainer();
  await DI.resolve(Configuration);
  const strategy = (await DI.resolve(LocalPasswordStrategy)) as LocalPasswordStrategy;
  return {
    identities: DI.resolve(IdentityStore) as HarnessIdentityStore,
    passwords: DI.resolve(PasswordCredentialStore) as HarnessPasswordStore,
    sessions: DI.resolve(SessionIssuer) as HarnessSessionIssuer,
    secrets: DI.resolve(SecretStore) as HarnessSecretStore,
    throttle: DI.resolve(AuthnThrottle) as HarnessThrottle,
    sinks: ((await DI.resolve(Array.ofType(AuthnEventSink))) as unknown[]).filter((s): s is RecordingEventSink => s instanceof RecordingEventSink),
    tokens: DI.resolve(TokenService) as HarnessTokenService,
    mailer: DI.resolve(PasswordMailer) as HarnessMailer,
    hasher: (await DI.resolve(PasswordHasher)) as Argon2PasswordHasher,
    strategy,
    password: (await DI.resolve(PasswordService)) as LocalPasswordService,
  };
}

/** The kit harness for N3 (README "Fakes for the service port"): the real N3 classes in DI, kit fakes around them. */
export async function localHarness(ctx: HarnessContext): Promise<Harness> {
  const p = await buildParts(ctx.config);
  const params = current.params;
  const [events, second] = p.sinks;
  let verifyCalls = 0;
  const verify = p.strategy.verify.bind(p.strategy);
  p.strategy.verify = async (c, vctx) => {
    verifyCalls++;
    return verify(c, vctx);
  };
  const service = new FakeAuthnService({
    strategies: [p.strategy],
    throttle: p.throttle,
    identities: p.identities,
    links: new MemoryLinkStore(),
    linking: { jit: false, byVerifiedEmail: false },
    policy: new EnrolledMfaPolicy([]),
    steps: [],
    sessions: p.sessions,
    sinks: p.sinks,
    principals: new RecordingPrincipalFactory(),
  });

  return {
    service,
    seed: {
      async user(spec) {
        const ref = p.identities.add({ login: spec.login, email: spec.email, status: spec.status });
        if (spec.password !== undefined) {
          await p.passwords.set(ref, await p.hasher.hash(spec.password));
        }
        return ref;
      },
      async setStatus(id, status) {
        p.identities.setStatus(id, status);
      },
    },
    sessions: p.sessions,
    events,
    sinks: [events, second],
    throttle: { throttle: p.throttle, params },
    password: p.password,
    passwordStore: p.passwords,
    hasher: {
      hash: (password) => p.hasher.hash(password),
      hashWith: (password, opts) => p.hasher.hashWith(password, opts),
      peakConcurrent: () => p.hasher.limiter.peak,
    },
    outbox: {
      async secretFor(id, purpose) {
        await p.password.drain();
        return p.mailer.secretFor(id, purpose);
      },
    },
    secrets: p.secrets,
    secretStorage: { rows: async () => p.secrets.rows() },
    tokens: p.tokens,
    spy: { verifyCalls: () => verifyCalls },
    async dispose() {
      await p.password.drain();
      freshContainer();
    },
  };
}

const KNOWN = { login: 'conformance@example.test', password: 'Conformance-Pass-1' };

/** runStrategyConformance subject: LocalPasswordStrategy from the same container, with session and event observers. */
export async function localStrategySubject(): Promise<StrategySubject> {
  const p = await buildParts({});
  const id = p.identities.add({ login: KNOWN.login });
  await p.passwords.set(id, await p.hasher.hash(KNOWN.password));
  let n = 0;
  return {
    strategy: p.strategy,
    valid: async () => ({ kind: 'password', login: KNOWN.login, password: KNOWN.password }),
    invalid: async () => ({ kind: 'password', login: KNOWN.login, password: `Wrong-Pass-${++n}x` }),
    unknown: async () => ({ kind: 'password', login: `nobody-${++n}@example.test`, password: `Wrong-Pass-${n}x` }),
    secretsOf: (c) => [(c as unknown as { password: string }).password],
    sessions: { count: async () => (await p.sessions.storage.storedKeys()).length },
    events: p.sinks[0],
    async dispose() {
      freshContainer();
    },
  };
}
