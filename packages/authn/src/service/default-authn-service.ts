import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import type { AuthnEvent, AuthnEventType } from '../contracts/audit.js';
import type { AuthenticationResult, AuthnContext, AuthnFailure, Credentials, ExternalSubject, IdentityRef, StrategyOutcome } from '../contracts/credentials.js';
import { IdentityStore } from '../contracts/identity.js';
import type { IdentityStatus } from '../contracts/identity.js';
import { IdentityLinkStore } from '../contracts/link.js';
import { MfaPolicy } from '../contracts/mfa.js';
import { ExternalLoginHook } from '../contracts/hooks.js';
import type { AuthnFacts, Ceiling, Principal } from '../contracts/principal.js';
import { AuthnService, PrincipalFactory } from '../contracts/service.js';
import { SessionIssuer } from '../contracts/session.js';
import type { SessionHandle } from '../contracts/session.js';
import type { AuthenticationStrategy } from '../contracts/strategy.js';
import { AuthnThrottle } from '../contracts/throttle.js';
import type { ThrottleKey } from '../contracts/throttle.js';
import { AuthnAudit } from '../audit/authn-audit.js';
import { MfaStepRegistry, RECOVERY_STEP } from '../flow/mfa-step-registry.js';
import { linkingSwitchesOf } from '../link/switches.js';
import { instantiate, nearestRegistration, registeredNames } from '../registry/named.js';
import { StrategyRegistry } from '../registry/strategy-registry.js';
import { canPeek } from '../throttle/peek.js';
import type { PeekableThrottle } from '../throttle/peek.js';
import { selectAuthnThrottle } from '../throttle/select.js';
import { AUTHN_ENV_FALLBACK_WARNING, authnEnvFellBack } from './boot/env.js';
import { checkAuthnLegacyKeys } from './boot/legacy-keys.js';
import { warnOnce } from './boot/log.js';
import { checkAuthnSecrets } from './boot/secrets.js';

type Success = Extract<AuthenticationResult, { status: 'success' }>;
type Failure = Extract<AuthenticationResult, { status: 'failure' }>;
type Verified = Extract<StrategyOutcome, { ok: true }>;
type EventBody = Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>;
type Stored = NonNullable<Awaited<ReturnType<SessionIssuer['restore']>>>;

/** The answer of the first candidate that does not pass the credentials on, or why none gave one. */
type Verification = { readonly s: AuthenticationStrategy; readonly outcome: StrategyOutcome } | { readonly s: AuthenticationStrategy; readonly broken: 'strategy_error' | 'strategy_contract'; readonly data?: Readonly<Record<string, unknown>> } | null;

const NO_PEEK_WARNING = 'DefaultAuthnService: the throttle has no peek(), so token and key requests count before verify and a client with many parallel requests on a valid credential gets throttled';

interface Linking {
  readonly jit: boolean;
  readonly byVerifiedEmail: boolean;
}

interface Found {
  readonly id: IdentityRef | null;
  readonly link?: ExternalSubject;
  readonly provisioned?: boolean;
}

interface Keyed {
  /** What the attempt counts: every candidate's keys. */
  readonly all: readonly ThrottleKey[];
  /** What a success of `s` gives back. */
  of(s: AuthenticationStrategy): readonly ThrottleKey[];
}

const dedupe = (keys: readonly ThrottleKey[]): ThrottleKey[] => {
  const seen = new Set<string>();
  return keys.filter((k) => {
    const id = `${k.kind}\u0000${k.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/** A strategy may answer these; anything else breaks the contract (D5). */
const STRATEGY_FAILURES: ReadonlySet<string> = new Set<AuthnFailure>(['invalid_credentials', 'unsupported_credentials', 'expired', 'revoked', 'not_linked']);

const KEY_KINDS: ReadonlySet<string> = new Set(['jws-assertion', 'http-signature']);

const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

const isRef = (v: unknown): v is IdentityRef => isObject(v) && nonEmpty(v.type) && nonEmpty(v.id);

const sameRef = (a: IdentityRef, b: IdentityRef): boolean => a.type === b.type && a.id === b.id;

// ASCII letters only: toLowerCase maps some non-ASCII letters to ASCII ones (the Kelvin sign U+212A to "k").
const foldAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const sameEmail = (stored: unknown, verified: string): boolean => nonEmpty(stored) && foldAscii(stored) === foldAscii(verified);

/** Strategies vouch for these through their own record checks (revocation, expiry, owner status); D4b. */
const VOUCHED_TYPES: ReadonlySet<string> = new Set(['service', 'agent']);

// The class only: a message may echo the credential that made the strategy throw.
const errorClass = (err: unknown): string => (err instanceof Error && nonEmpty(err.name) ? err.name : typeof err);

const fail = (reason: AuthnFailure): Failure => ({ status: 'failure', reason });

function checkOutcome(o: unknown): StrategyOutcome | null {
  if (!isObject(o)) return null;
  if (o.ok === false) return nonEmpty(o.reason) && STRATEGY_FAILURES.has(o.reason) ? (o as StrategyOutcome) : null;
  if (o.ok !== true || !nonEmpty(o.method)) return null;
  const hasIdentity = o.identity !== undefined;
  if (hasIdentity === (o.external !== undefined)) return null;
  if (hasIdentity ? !isRef(o.identity) : !(isObject(o.external) && nonEmpty(o.external.provider) && nonEmpty(o.external.subject))) return null;
  if (o.delegation !== undefined && !(isObject(o.delegation) && isRef(o.delegation.onBehalfOf) && (o.delegation.mode === 'inherit' || o.delegation.mode === 'intersect'))) return null;
  if ((o.ceiling !== undefined && !isObject(o.ceiling)) || (o.attributes !== undefined && !isObject(o.attributes))) return null;
  return o as StrategyOutcome;
}

const validKeys = (v: unknown): v is readonly ThrottleKey[] => Array.isArray(v) && v.every((k) => isObject(k) && nonEmpty(k.kind) && typeof k.value === 'string');

/** The audit reason of a status that refuses the login, or null. */
function refusal(st: IdentityStatus): string | null {
  if (!st.exists) return 'unknown_identity';
  if (st.deleted) return 'deleted';
  if (st.banned) return 'banned';
  if (!st.active) return 'inactive';
  return null;
}

/**
 * The authentication flow of design §22.4. Every failure the caller sees is one of the AuthnFailure values (A02); the
 * real reason, a refused status or a strategy error included, goes to audit only. Credentials, codes, login strings and
 * raw session ids never reach an event: sessions appear by their listed handle.
 *
 * Dispatch (D1): the listed candidates for the credentials are counted once, with the union of their keys, before any
 * verify (per-request candidates only after a failure, K5); an `unsupported_credentials` answer passes the
 * credentials to the next candidate.
 *
 * MFA: the session issuer does not give back the steps a pending session was issued with, so `completeMfa` asks the
 * policy again (D15 for every pending session). The required steps are alternatives: passing any one of them, or a
 * recovery code (D6), elevates the session to aal2.
 *
 * One per container (D11): it reads the resolving container's configuration and neighbours. The throttle is
 * `authn.throttle.service`; when that is unset, the only registered throttle, or the only one besides
 * `MemoryAuthnThrottle` (so an app that imports authn-orm gets `DbAuthnThrottle`). Boot fails when the named throttle is not
 * registered rather than falling back to memory, which would throttle each instance of a multi-instance app apart.
 * A throttle class resolves through DI (`MemoryAuthnThrottle` is one root singleton); a throttle registered as a factory
 * is called once per container, so the factory must return a shared instance or the counts split per container.
 *
 * Boot also fails on the secret checks (A24, `checkAuthnSecrets`), on the throttle's `checkConfiguration` and, when
 * `authn.config.rejectLegacyKeys` is true, on 2.x keys of the old-key table; otherwise those keys are only warned about.
 */
@PerChildInstance()
@Injectable(AuthnService)
@Inject(Container)
export class DefaultAuthnService extends AuthnService {
  private registry!: StrategyRegistry;
  private auditor!: AuthnAudit;
  private throttle!: AuthnThrottle;
  private peeker: PeekableThrottle | undefined;
  private identities!: IdentityStore;
  private principals!: PrincipalFactory;
  private links: IdentityLinkStore | undefined;
  private sessions: SessionIssuer | undefined;
  private policy: MfaPolicy | undefined;
  private steps: MfaStepRegistry | undefined;

  @Config('authn.linking')
  protected Linking!: Linking;

  @Config('authn.throttle.global')
  protected ThrottleGlobal: unknown;

  @Config('authn.mfa.policy.service')
  protected PolicyService!: string;

  @Config('authn.throttle.service')
  protected ThrottleService: string | undefined;

  constructor(private readonly container: IContainer) {
    super();
  }

  private get globalGate(): boolean {
    return isObject(this.ThrottleGlobal);
  }

  public async resolve(): Promise<void> {
    // The boot checks are plain functions over a Configuration and read APP_ENV, so they cannot use @Config.
    const configuration = await this.container.resolve(Configuration);
    if (authnEnvFellBack(configuration)) warnOnce(AUTHN_ENV_FALLBACK_WARNING);
    checkAuthnLegacyKeys(configuration, { warn: warnOnce });
    await checkAuthnSecrets(configuration, this.container, warnOnce);
    this.registry = await this.container.resolve(StrategyRegistry);
    this.auditor = await this.container.resolve(AuthnAudit);
    this.identities = (await this.neighbour(IdentityStore, 'IdentityStore', true))!;
    this.principals = (await this.neighbour(PrincipalFactory, 'PrincipalFactory', true))!;
    this.links = await this.neighbour(IdentityLinkStore, 'IdentityLinkStore', false);
    if (this.registry.strategies().some((s) => s.interactive)) {
      this.sessions = await this.neighbour(SessionIssuer, 'SessionIssuer', true);
      this.steps = await this.container.resolve(MfaStepRegistry);
      this.policy = await this.selectPolicy();
    }
    this.throttle = await selectAuthnThrottle(this.container, this.ThrottleService);
    await this.throttle.checkConfiguration?.(configuration);
    if (canPeek(this.throttle)) this.peeker = this.throttle;
    else if (this.registry.strategies().some((s) => !s.interactive)) warnOnce(NO_PEEK_WARNING);
    await super.resolve();
  }

  public strategies(): readonly AuthenticationStrategy[] {
    return this.registry.strategies();
  }

  public async authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult> {
    const candidates = this.registry.candidates(c);
    if (candidates.length === 0) {
      await this.audit(ctx, { type: 'login', outcome: 'failure', reason: 'unsupported_credentials' });
      return fail('unsupported_credentials');
    }
    const only = candidates.length === 1 ? { strategy: candidates[0].name } : {};

    const keyed = this.keysFor(candidates, c, ctx);
    if ('error' in keyed) {
      await this.audit(ctx, { type: this.eventOf(keyed.strategy), outcome: 'failure', strategy: keyed.strategy.name, reason: 'strategy_error', data: { error: keyed.error } });
      return fail('invalid_credentials');
    }
    // Per-request credentials count only their failures (K5): counted before verify, the requests a busy client has
    // in flight with a valid token or key would add up to a backoff. A login method keeps A05's count before verify.
    // A parallel burst of failures is then verified in full (PeekableThrottle), which only unguessable credentials allow.
    const failuresOnly = this.peeker !== undefined && candidates.every((s) => !s.interactive);
    const gate = failuresOnly ? await this.peeker!.peek(keyed.all, 'login', ctx) : await this.throttle.attempt(keyed.all, 'login', ctx);
    if (!gate.allowed) return this.throttled(ctx, gate.retryAfterSeconds, only);

    const result = await this.verified(candidates, keyed, c, ctx, only);
    if (!failuresOnly || result.status === 'success') return result;
    const counted = await this.throttle.attempt(keyed.all, 'login', ctx);
    return counted.allowed ? result : this.throttled(ctx, counted.retryAfterSeconds, only);
  }

  private async verified(candidates: readonly AuthenticationStrategy[], keyed: Keyed, c: Credentials, ctx: AuthnContext, only: { strategy?: string }): Promise<AuthenticationResult> {
    const v = await this.verifyWith(candidates, c, ctx);
    if (v === null) {
      await this.audit(ctx, { type: 'login', outcome: 'failure', reason: 'unsupported_credentials', ...only });
      return fail('unsupported_credentials');
    }
    if ('broken' in v) return this.refuse(ctx, v.s, v.broken, 'invalid_credentials', v.data ? { data: v.data } : {});
    if (!v.outcome.ok) return this.refuse(ctx, v.s, v.outcome.reason, v.outcome.reason);
    try {
      return await this.accept(v.s, v.outcome, keyed.of(v.s), ctx);
    } catch (err) {
      // Only a verified credential gets here: a rejection would tell it apart from a wrong one (A02).
      return this.refuse(ctx, v.s, 'store_error', 'invalid_credentials', { data: { error: errorClass(err) } });
    }
  }

  public async completeMfa(pending: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult> {
    const stored = await this.restore(pending);
    if (!stored || stored.handle.state !== 'pending') {
      await this.audit(ctx, { type: 'mfa.verify', outcome: 'failure', reason: 'not_pending' });
      return fail('invalid_credentials');
    }
    const id = stored.identity;
    const about = { identity: id, strategy: stored.facts.strategy, ...(nonEmpty(stored.facts.sessionHandle) ? { session: stored.facts.sessionHandle } : {}) };
    const keys = this.identityKeys(id, ctx);
    const gate = await this.throttle.attempt(keys, 'mfa', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', ...about });
      return { status: 'failure', reason: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }

    let passed: boolean | string;
    try {
      passed = await this.passMfa(id, stored.facts, step, response);
    } catch (err) {
      await this.audit(ctx, { type: 'mfa.verify', outcome: 'failure', reason: 'step_error', data: { error: errorClass(err) }, ...about });
      return fail('invalid_credentials');
    }
    if (passed !== true) {
      await this.audit(ctx, { type: 'mfa.verify', outcome: 'failure', reason: passed === false ? 'invalid_code' : passed, ...about });
      return fail('invalid_credentials');
    }
    // An account banned or deleted between the two steps must not get in.
    let refused: string | null;
    try {
      refused = await this.statusRefusal(id);
      if (refused) await this.sessions!.revoke(stored.handle);
    } catch (err) {
      await this.audit(ctx, { type: 'mfa.verify', outcome: 'failure', reason: 'store_error', data: { error: errorClass(err) }, ...about });
      return fail('invalid_credentials');
    }
    if (refused) {
      await this.audit(ctx, { type: 'login', outcome: 'failure', reason: refused, ...about });
      return fail('invalid_credentials');
    }

    let session: SessionHandle;
    let facts: Success['facts'];
    try {
      session = await this.sessions!.elevate({ id: pending.id, state: 'pending' }, { assurance: 'aal2', mfa: [step] });
      const now = await this.sessions!.restore(session.id);
      if (!now) throw new InvalidOperation('the elevated session is gone');
      const { authenticatedAt: _at, ...rest } = now.facts;
      facts = rest;
      await this.throttle.succeed(keys, 'mfa');
    } catch (err) {
      await this.audit(ctx, { type: 'mfa.verify', outcome: 'failure', reason: 'session_error', data: { error: errorClass(err) }, ...about });
      return fail('invalid_credentials');
    }
    const done = { identity: id, strategy: facts.strategy, ...(nonEmpty(facts.sessionHandle) ? { session: facts.sessionHandle } : {}) };
    await this.audit(ctx, { type: 'mfa.verify', outcome: 'success', ...done });
    await this.audit(ctx, { type: 'login', outcome: 'success', ...done });
    return { status: 'success', identity: id, facts, session };
  }

  public async reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean> {
    const stored = await this.restore(session);
    if (!stored || stored.handle.state !== 'active') {
      await this.audit(ctx, { type: 'reauth', outcome: 'failure', reason: 'not_active' });
      return false;
    }
    const id = stored.identity;
    const about = { identity: id, ...(nonEmpty(stored.facts.sessionHandle) ? { session: stored.facts.sessionHandle } : {}) };
    // The target's password must not let an impersonator act as the target (M6).
    if (stored.facts.impersonator !== undefined) {
      await this.audit(ctx, { type: 'reauth', outcome: 'failure', reason: 'impersonation', ...about });
      return false;
    }
    // A login method shows the user is present; a token or key the client holds does not.
    const candidates = this.registry.candidates(c).filter((s) => s.interactive);
    if (candidates.length === 0) {
      await this.audit(ctx, { type: 'reauth', outcome: 'failure', reason: 'unsupported_credentials', ...about });
      return false;
    }
    const keys = this.identityKeys(id, ctx);
    if (!(await this.throttle.attempt(keys, 'reauth', ctx)).allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', ...about });
      return false;
    }

    const v = await this.verifyWith(candidates, c, ctx);
    const strategy = v ? { strategy: v.s.name } : {};
    let reason: string | null;
    let data: Readonly<Record<string, unknown>> | undefined;
    try {
      if (v === null) reason = 'unsupported_credentials';
      else if ('broken' in v) [reason, data] = [v.broken, v.data];
      else if (!v.outcome.ok) reason = v.outcome.reason;
      else reason = (await this.isSessionIdentity(v.outcome, id)) ? await this.statusRefusal(id) : 'other_identity';
      if (reason === null) await this.throttle.succeed(keys, 'reauth');
    } catch (err) {
      [reason, data] = ['store_error', { error: errorClass(err) }];
    }
    if (reason !== null) {
      await this.audit(ctx, { type: 'reauth', outcome: 'failure', reason, ...(data ? { data } : {}), ...strategy, ...about });
      return false;
    }
    await this.audit(ctx, { type: 'reauth', outcome: 'success', ...strategy, ...about });
    return true;
  }

  public async principalOf(result: Success): Promise<Principal> {
    if (!isObject(result) || result.status !== 'success' || !isRef(result.identity)) {
      throw new InvalidArgument('principalOf takes a success result');
    }
    let facts: AuthnFacts;
    if (result.session) {
      const stored = this.sessions ? await this.sessions.restore(result.session.id) : null;
      if (!stored || stored.handle.state !== 'active' || !sameRef(stored.identity, result.identity)) {
        throw new InvalidOperation('principalOf: the session of this result is gone or not active');
      }
      facts = stored.facts;
    } else {
      facts = { ...result.facts, authenticatedAt: new Date() };
    }
    const extra: { ceiling?: Ceiling; onBehalfOf?: Principal; delegation?: 'inherit' | 'intersect'; attributes?: Readonly<Record<string, unknown>> } = {};
    if (result.ceiling !== undefined) extra.ceiling = result.ceiling;
    if (result.delegation) {
      extra.onBehalfOf = await this.principals.principalOf(result.delegation.onBehalfOf, facts, {});
      extra.delegation = result.delegation.mode;
    }
    if (result.attributes !== undefined) extra.attributes = result.attributes;
    return this.principals.principalOf(result.identity, facts, extra);
  }

  private async verifyWith(candidates: readonly AuthenticationStrategy[], c: Credentials, ctx: AuthnContext): Promise<Verification> {
    for (const s of candidates) {
      let raw: unknown;
      try {
        raw = await s.verify(c, ctx);
      } catch (err) {
        return { s, broken: 'strategy_error', data: { error: errorClass(err) } };
      }
      const checked = checkOutcome(raw);
      if (checked === null) return { s, broken: 'strategy_contract' };
      if (!checked.ok && checked.reason === 'unsupported_credentials') continue;
      return { s, outcome: checked };
    }
    return null;
  }

  private async accept(s: AuthenticationStrategy, r: Verified, keys: readonly ThrottleKey[], ctx: AuthnContext): Promise<AuthenticationResult> {
    let id: IdentityRef | null = r.identity ?? null;
    let found: Found = { id: null };
    if (!id && r.external) {
      found = await this.linked(s, r.external);
      id = found.id;
    }
    if (!id) return this.refuse(ctx, s, 'not_linked', 'not_linked');
    // A provisioned identity is linked even if refused below, so a retry finds it instead of provisioning again.
    if (found.link && found.provisioned) await this.link(ctx, s, id, found.link);
    // Service and agent identities authenticate per request only (D12).
    if (s.interactive && id.type !== 'user') return this.refuse(ctx, s, 'non_user_session', 'invalid_credentials', { identity: id });
    const refused = await this.statusRefusal(r.delegation?.onBehalfOf ?? id);
    if (refused) return this.refuse(ctx, s, refused, 'invalid_credentials', { identity: id });
    // Before the link by verified email, so a login a hook refuses leaves neither a session nor a new email link.
    if (s.interactive && r.external) {
      const hookError = await this.runLoginHooks(id, r.external);
      if (hookError !== null) return this.refuse(ctx, s, 'hook_error', 'invalid_credentials', { identity: id, data: { error: hookError } });
    }

    if (found.link && !found.provisioned) await this.link(ctx, s, id, found.link);
    await this.throttle.succeed(keys, 'login');

    const facts = { method: r.method, strategy: s.name, assurance: 'aal1' as const, mfa: [] as string[] };
    const extra = { ...(r.ceiling !== undefined ? { ceiling: r.ceiling } : {}), ...(r.delegation ? { delegation: r.delegation } : {}), ...(r.attributes !== undefined ? { attributes: r.attributes } : {}) };
    if (!s.interactive) {
      await this.audit(ctx, { type: this.eventOf(s), outcome: 'success', strategy: s.name, identity: id });
      return { status: 'success', identity: id, facts, ...extra };
    }

    const sessions = this.sessions!;
    let steps: string[];
    try {
      steps = [...(await this.policy!.required(id, { method: facts.method, strategy: facts.strategy }))];
    } catch (err) {
      return this.refuse(ctx, s, 'policy_error', 'invalid_credentials', { identity: id, data: { error: errorClass(err) } });
    }
    const issued: AuthnFacts = { ...facts, authenticatedAt: ctx.now };
    if (steps.length > 0) {
      const pending = await sessions.issue(id, issued, { pending: { steps } });
      await this.audit(ctx, { type: 'mfa.challenge', outcome: 'success', strategy: s.name, identity: id, session: await this.handleOf(pending) });
      return { status: 'mfa_required', pending, steps };
    }
    const session = await sessions.issue(id, issued);
    const handle = await this.handleOf(session);
    await this.audit(ctx, { type: 'login', outcome: 'success', strategy: s.name, identity: id, session: handle });
    await this.audit(ctx, { type: 'session.issue', outcome: 'success', strategy: s.name, identity: id, session: handle });
    return { status: 'success', identity: id, facts: { ...facts, ...(handle !== undefined ? { sessionHandle: handle } : {}) }, session, ...extra };
  }

  /**
   * Every ExternalLoginHook of this container's lineage (as AuthnAudit takes its sinks), resolved per login so hooks
   * registered late run; the error class of the first that throws, or null.
   */
  private async runLoginHooks(id: IdentityRef, external: ExternalSubject): Promise<string | null> {
    try {
      const chain = (await this.container.resolve(Array.chainOf(ExternalLoginHook))) as readonly ExternalLoginHook[];
      // A resolve of the abstract base itself leaves an instance of it in the chain; it is no hook.
      for (const hook of chain.filter((h) => h?.constructor !== ExternalLoginHook)) await hook.afterLogin(id, external);
      return null;
    } catch (err) {
      return errorClass(err);
    }
  }

  /** Only a subject of a type strategies vouch for skips the store, so an unknown type fails closed (D4, D4b). */
  private async statusRefusal(subject: IdentityRef): Promise<string | null> {
    return VOUCHED_TYPES.has(subject.type) ? null : refusal(await this.identities.status(subject));
  }

  /**
   * True: passed; false: a wrong code; a string: why the step cannot be taken (audit reason). The steps the policy
   * requires now are alternatives; `recovery` goes to the first enrolled step that takes recovery codes (D6).
   */
  private async passMfa(id: IdentityRef, facts: AuthnFacts, step: string, response: string): Promise<boolean | string> {
    const required = await this.policy!.required(id, { method: facts.method, strategy: facts.strategy });
    if (required.length === 0) return 'no_steps';
    if (step === RECOVERY_STEP) {
      for (const s of this.steps!.steps()) {
        if (typeof s.verifyRecovery === 'function' && (await s.enrolled(id))) return (await s.verifyRecovery(id, response)) === true;
      }
      return 'no_recovery_step';
    }
    const s = required.includes(step) ? this.steps!.get(step) : undefined;
    if (!s) return 'unknown_step';
    // Under force the required step may be one the identity has not enrolled; the MfaStep contract does not oblige verify to refuse that.
    if (!(await s.enrolled(id))) return 'not_enrolled';
    return (await s.verify(id, response)) === true;
  }

  /** A re-authentication proves the session's own identity: a delegation or an unlinked subject does not (A13). */
  private async isSessionIdentity(r: Verified, id: IdentityRef): Promise<boolean> {
    if (r.delegation) return false;
    const verified = r.identity ?? (r.external && this.links ? (await this.links.find(r.external.provider, r.external.subject))?.identity : undefined);
    return verified !== undefined && sameRef(verified, id);
  }

  private async restore(h: SessionHandle): Promise<Stored | null> {
    if (!this.sessions || !isObject(h) || !nonEmpty(h.id)) return null;
    return this.sessions.restore(h.id);
  }

  /**
   * A linked identity, or one found by verified email or provisioned (then `link` is the subject to link). Each way past
   * an existing link needs the global switch and the strategy's own switch for the provider (K6).
   */
  private async linked(s: AuthenticationStrategy, external: ExternalSubject): Promise<Found> {
    if (!this.links) return { id: null };
    const found = await this.links.find(external.provider, external.subject);
    if (found) return { id: found.identity };
    // === true: a value set at runtime never went through the schema, and a truthy string must not switch linking on.
    const global = { jit: this.Linking.jit === true, byVerifiedEmail: this.Linking.byVerifiedEmail === true };
    const own = global.jit || global.byVerifiedEmail ? linkingSwitchesOf(s, external) : { jit: false, byVerifiedEmail: false };
    if (global.byVerifiedEmail && own.byVerifiedEmail && external.emailVerified === true && nonEmpty(external.email)) {
      // findByLogin also matches login names; only the identity's own stored email may decide.
      const id = await this.identities.findByLogin(external.email);
      if (id && sameEmail((await this.identities.display(id))?.email, external.email)) return { id, link: external, provisioned: false };
    }
    if (global.jit && own.jit && typeof this.identities.provision === 'function') {
      return { id: await this.identities.provision(external), link: external, provisioned: true };
    }
    return { id: null };
  }

  private async link(ctx: AuthnContext, s: AuthenticationStrategy, id: IdentityRef, external: ExternalSubject): Promise<void> {
    await this.links!.link(id, external);
    await this.audit(ctx, { type: 'identity.link', outcome: 'success', strategy: s.name, identity: id, data: { provider: external.provider } });
  }

  /**
   * Each candidate's keys with `account-ip` = `<account>|<ip>` for its account keys, and the shared ip and global keys.
   * The service builds `account-ip` itself and drops the strategies' own (D8b): the throttle takes every `account-ip`
   * in a success off the ip key, so a value without this ip would clear another ip's failures. The attempt counts
   * the union; `succeed` gets only the answering strategy's keys (D8).
   *
   * A per-request strategy's `account` key is `request:<account>|<ip>` (K6): its credential ids travel in clear (a key
   * id in every signed request), so a credential-wide key would let anyone keep a victim's key or token in backoff.
   * Guessing stays bounded by that key per ip and by the ip key. An interactive strategy's is `login:<account>`, so no
   * login string can name a per-request key.
   */
  private keysFor(candidates: readonly AuthenticationStrategy[], c: Credentials, ctx: AuthnContext): Keyed | { strategy: AuthenticationStrategy; error: string } {
    const own = new Map<AuthenticationStrategy, ThrottleKey[]>();
    for (const s of candidates) {
      let given: unknown;
      try {
        given = s.throttleKeys(c, ctx);
      } catch (err) {
        return { strategy: s, error: errorClass(err) };
      }
      if (!validKeys(given)) return { strategy: s, error: 'malformed_throttle_keys' };
      const keys = given.filter((k) => k.kind !== 'account-ip').map((k) => ({ kind: k.kind, value: k.kind === 'account' ? `${s.interactive ? 'login' : 'request'}:${k.value}` : k.value }));
      const accounts = keys.filter((x) => x.kind === 'account');
      if (nonEmpty(ctx.ip)) {
        for (const k of accounts) keys.push({ kind: 'account-ip', value: `${k.value}|${ctx.ip}` });
      }
      if (!s.interactive) {
        for (const k of accounts) k.value = `${k.value}|${ctx.ip ?? ''}`;
      }
      own.set(s, keys);
    }
    const shared: ThrottleKey[] = [...(nonEmpty(ctx.ip) ? [{ kind: 'ip', value: ctx.ip }] : []), ...(this.globalGate ? [{ kind: 'global', value: 'login' }] : [])];
    return { all: dedupe([...[...own.values()].flat(), ...shared]), of: (s) => dedupe([...(own.get(s) ?? []), ...shared]) };
  }

  /** The keys of the `mfa` and `reauth` flows, shared with N3's PasswordService.change (D14). */
  private identityKeys(id: IdentityRef, ctx: AuthnContext): ThrottleKey[] {
    return [{ kind: 'account', value: id.id }, { kind: 'account-ip', value: `${id.id}|${ctx.ip ?? ''}` }, ...(nonEmpty(ctx.ip) ? [{ kind: 'ip', value: ctx.ip }] : [])];
  }

  private async throttled(ctx: AuthnContext, retryAfterSeconds: number, only: { strategy?: string }): Promise<Failure> {
    await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', ...only });
    return { status: 'failure', reason: 'throttled', retryAfterSeconds };
  }

  private async refuse(ctx: AuthnContext, s: AuthenticationStrategy, reason: string, answer: AuthnFailure, extra: Partial<EventBody> = {}): Promise<Failure> {
    await this.audit(ctx, { type: this.eventOf(s), outcome: 'failure', strategy: s.name, reason, ...extra });
    return fail(answer);
  }

  /** Interactive strategies log in; the others are uses of a token or a key. */
  private eventOf(s: AuthenticationStrategy): AuthnEventType {
    if (s.interactive) return 'login';
    return s.kinds.some((k) => KEY_KINDS.has(k)) ? 'key.use' : 'token.use';
  }

  private async handleOf(h: SessionHandle): Promise<string | undefined> {
    return (await this.sessions!.restore(h.id))?.facts.sessionHandle;
  }

  private audit(ctx: AuthnContext, e: EventBody): Promise<void> {
    return this.auditor.publish({ ...e, at: ctx.now, ...(nonEmpty(ctx.ip) ? { ip: ctx.ip } : {}), ...(nonEmpty(ctx.userAgent) ? { userAgent: ctx.userAgent } : {}) });
  }

  private async neighbour<T>(type: abstract new (...args: never[]) => T, name: string, required: boolean): Promise<T | undefined> {
    if (!this.container.hasRegistered(type as unknown as Class<T>)) {
      if (required) throw new InvalidOperation(`DefaultAuthnService: no ${name} is registered`);
      return undefined;
    }
    return (await this.container.resolve(type as unknown as Class<T>)) as T;
  }

  /** `authn.mfa.policy.service` (schema default DefaultMfaPolicy); the registration nearest to this container wins. */
  private async selectPolicy(): Promise<MfaPolicy> {
    const name = this.PolicyService;
    const type = nearestRegistration(this.container, MfaPolicy, name);
    if (!type) {
      const listed = registeredNames(this.container, MfaPolicy).map(q).join(', ') || 'none';
      throw new InvalidOption(`authn.mfa.policy.service ${q(name)}: no MfaPolicy is registered under that name (registered: ${listed})`);
    }
    const policy: unknown = await instantiate(this.container, type);
    if (!isObject(policy) || typeof policy.required !== 'function') throw new InvalidOption(`authn.mfa.policy.service ${q(name)} is not an MfaPolicy`);
    return policy as unknown as MfaPolicy;
  }
}
