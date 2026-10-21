import { Autoinject, Container, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AutoinjectNamedService, Config, Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';

import { asciiLower, isNonEmptyString, isPlainObject, uniqueBy } from '@spinajs/util';

import type { AuthnEventType } from '../contracts/audit.js';
import type { AuthenticationResult, AuthnContext, AuthnFailure, Credentials, ExternalSubject, IdentityRef, StrategyOutcome } from '../contracts/credentials.js';
import { errorClass, isRef } from '../support/guards.js';
import { restoreHandle, statusRefusal } from '../support/identity.js';
import { DEFAULT_IPV6_PREFIX, throttleIp } from '../support/ip-key.js';
import { IdentityStore } from '../contracts/identity.js';
import { IdentityLinkStore } from '../contracts/link.js';
import { MfaPolicy } from '../contracts/mfa.js';
import { ExternalLoginHook } from '../contracts/hooks.js';
import { sameRef } from '../contracts/principal.js';
import type { AuthnFacts, Ceiling, Principal } from '../contracts/principal.js';
import { AuthnService, PrincipalFactory } from '../contracts/service.js';
import { SessionIssuer } from '../contracts/session.js';
import type { SessionHandle } from '../contracts/session.js';
import type { AuthenticationStrategy } from '../contracts/strategy.js';
import { AuthnThrottle, identityThrottleKeys } from '../contracts/throttle.js';
import type { ThrottleKey } from '../contracts/throttle.js';
import { AuthnAudit } from '../audit/authn-audit.js';
import type { AuthnEventBody } from '../audit/authn-audit.js';
import { mfaEnrolmentRefusal } from '../flow/mfa-enrolments.js';
import { RECOVERY_STEP } from '../flow/default-mfa-policy.js';
import { MFA_POLICY_SERVICE } from '../flow/select-policy.js';
import { linkingSwitchesOf } from '../link/switches.js';
import { StrategyRegistry } from '../registry/strategy-registry.js';
import { canPeek } from '../throttle/peek.js';
import type { PeekableThrottle } from '../throttle/peek.js';
import { AUTHN_THROTTLE_SERVICE } from '../throttle/select.js';
import { AUTHN_ENV_FALLBACK_WARNING, authnEnvFellBack } from './boot/env.js';
import { checkAuthnSecrets } from './boot/secrets.js';

type Success = Extract<AuthenticationResult, { status: 'success' }>;
type Failure = Extract<AuthenticationResult, { status: 'failure' }>;
type Verified = Extract<StrategyOutcome, { ok: true }>;

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

const dedupe = (keys: ThrottleKey[]): ThrottleKey[] => uniqueBy(keys, (k) => `${k.kind}\u0000${k.value}`);

/** A strategy may answer these; anything else breaks the contract (D5). */
const STRATEGY_FAILURES: ReadonlySet<string> = new Set<AuthnFailure>(['invalid_credentials', 'unsupported_credentials', 'expired', 'revoked', 'not_linked', 'throttled']);

const KEY_KINDS: ReadonlySet<string> = new Set(['jws-assertion', 'http-signature']);

const sameEmail = (stored: unknown, verified: string): boolean => isNonEmptyString(stored) && asciiLower(stored) === asciiLower(verified);

const fail = (reason: AuthnFailure): Failure => ({ status: 'failure', reason });

/** A strategy short of capacity names no usable wait: ask for one second. */
const retryAfterOf = (o: { readonly retryAfterSeconds?: number }): number => (Number.isInteger(o.retryAfterSeconds) && o.retryAfterSeconds! > 0 ? o.retryAfterSeconds! : 1);

/** The audit reason and data of an MFA policy that threw: the step names of a refusal over stored enrolments, else the error class. */
const policyRefusal = (err: unknown, otherwise: string): { reason: string; data: Readonly<Record<string, unknown>> } => {
  const refusal = mfaEnrolmentRefusal(err);
  return refusal ? { reason: refusal.reason, data: { steps: [...refusal.steps] } } : { reason: otherwise, data: { error: errorClass(err) } };
};

function checkOutcome(o: unknown): StrategyOutcome | null {
  if (!isPlainObject(o)) return null;
  if (o.ok === false) return isNonEmptyString(o.reason) && STRATEGY_FAILURES.has(o.reason) ? (o as StrategyOutcome) : null;
  if (o.ok !== true || !isNonEmptyString(o.method)) return null;
  const hasIdentity = o.identity !== undefined;
  if (hasIdentity === (o.external !== undefined)) return null;
  if (hasIdentity ? !isRef(o.identity) : !(isPlainObject(o.external) && isNonEmptyString(o.external.provider) && isNonEmptyString(o.external.subject))) return null;
  if (o.delegation !== undefined && !(isPlainObject(o.delegation) && isRef(o.delegation.onBehalfOf) && (o.delegation.mode === 'inherit' || o.delegation.mode === 'intersect'))) return null;
  if ((o.ceiling !== undefined && !isPlainObject(o.ceiling)) || (o.attributes !== undefined && !isPlainObject(o.attributes))) return null;
  if (o.assurance !== undefined && o.assurance !== 'aal1' && o.assurance !== 'aal2') return null;
  return o as StrategyOutcome;
}

const validKeys = (v: unknown): v is readonly ThrottleKey[] => Array.isArray(v) && v.every((k) => isPlainObject(k) && isNonEmptyString(k.kind) && typeof k.value === 'string');

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
 * One per container (D11): its dependencies are property decorators resolved in the resolving container, which also
 * gives the configuration. A `SessionIssuer` and the MFA policy (`authn.mfa.policy.service`) are resolved at every boot,
 * also when only per-request strategies are listed. The throttle is `authn.throttle.service`; when that is unset, the
 * only registered throttle, or the only one besides `MemoryAuthnThrottle` (so an app that imports authn-orm gets
 * `DbAuthnThrottle`). Boot fails when the named throttle is not registered rather than falling back to memory, which
 * would throttle each instance of a multi-instance app apart.
 * A throttle class resolves through DI (`MemoryAuthnThrottle` is one root singleton); a throttle registered as a factory
 * is called once per container, so the factory must return a shared instance or the counts split per container.
 *
 * Boot also fails on the secret checks (A24, `checkAuthnSecrets`) and on the throttle's `checkConfiguration`.
 */
@PerChildInstance()
@Injectable(AuthnService)
export class DefaultAuthnService extends AuthnService {
  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(Configuration)
  protected Configuration: Configuration;

  @Autoinject(StrategyRegistry)
  protected Registry: StrategyRegistry;

  @Autoinject(AuthnAudit)
  protected Auditor: AuthnAudit;

  @Autoinject(IdentityStore, { check: true })
  protected Identities: IdentityStore;

  @Autoinject(PrincipalFactory, { check: true })
  protected Principals: PrincipalFactory;

  @Autoinject(IdentityLinkStore, { optional: true })
  protected Links: IdentityLinkStore | undefined;

  @Autoinject(SessionIssuer, { check: true })
  protected Sessions: SessionIssuer;

  @AutoinjectNamedService('authn.mfa.policy.service', MfaPolicy, MFA_POLICY_SERVICE)
  protected Policy: MfaPolicy;

  @AutoinjectNamedService('authn.throttle.service', AuthnThrottle, AUTHN_THROTTLE_SERVICE)
  protected Throttle: AuthnThrottle;

  private peeker: PeekableThrottle | undefined;

  @Logger('authn-boot')
  protected Log: Log;

  @Config('authn.linking')
  protected Linking!: Linking;

  @Config('authn.login.requireVerifiedAddress', { defaultValue: false })
  protected RequireVerifiedAddress: boolean;

  @Config('authn.throttle.global')
  protected ThrottleGlobal: unknown;

  @Config('authn.throttle.ipv6Prefix')
  protected ThrottleIpv6Prefix: unknown;

  private get ipv6Prefix(): number {
    return typeof this.ThrottleIpv6Prefix === 'number' ? this.ThrottleIpv6Prefix : DEFAULT_IPV6_PREFIX;
  }

  private get globalGate(): boolean {
    return isPlainObject(this.ThrottleGlobal);
  }

  public async resolve(): Promise<void> {
    if (authnEnvFellBack(this.Configuration)) this.warnOnce(AUTHN_ENV_FALLBACK_WARNING);
    await checkAuthnSecrets(this.Configuration, () => this.Policy.steps(), (m) => this.warnOnce(m));
    await this.Throttle.checkConfiguration?.(this.Configuration);
    if (canPeek(this.Throttle)) this.peeker = this.Throttle;
    else if (this.Registry.strategies().some((s) => !s.interactive)) this.warnOnce(NO_PEEK_WARNING);
    await super.resolve();
  }

  // Every child container with the same configuration repeats the boot checks; each warning is logged once per process.
  private warnOnce(message: string): void {
    this.Log.warnOnce(message, message);
  }

  public strategies(): readonly AuthenticationStrategy[] {
    return this.Registry.strategies();
  }

  public async authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult> {
    const candidates = this.Registry.candidates(c);
    if (candidates.length === 0) {
      await this.Auditor.publishIn(ctx, { type: 'login', outcome: 'failure', reason: 'unsupported_credentials' });
      return fail('unsupported_credentials');
    }
    const only = candidates.length === 1 ? { strategy: candidates[0].name } : {};

    const keyed = this.keysFor(candidates, c, ctx);
    if ('error' in keyed) {
      await this.Auditor.publishIn(ctx, { type: this.eventOf(keyed.strategy), outcome: 'failure', strategy: keyed.strategy.name, reason: 'strategy_error', data: { error: keyed.error } });
      return fail('invalid_credentials');
    }
    // Per-request credentials count only their failures (K5): counted before verify, the requests a busy client has
    // in flight with a valid token or key would add up to a backoff. A login method keeps A05's count before verify.
    // A parallel burst of failures is then verified in full (PeekableThrottle), which only unguessable credentials allow.
    const failuresOnly = this.peeker !== undefined && candidates.every((s) => !s.interactive);
    const gate = failuresOnly ? await this.peeker!.peek(keyed.all, 'login', ctx) : await this.Throttle.attempt(keyed.all, 'login', ctx);
    if (!gate.allowed) return this.throttled(ctx, gate.retryAfterSeconds, only);
    const clean = 'clean' in gate && gate.clean === true;

    const result = await this.verified(candidates, keyed, c, ctx, only, clean);
    if (!failuresOnly || result.status === 'success') return result;
    const counted = await this.Throttle.attempt(keyed.all, 'login', ctx);
    return counted.allowed ? result : this.throttled(ctx, counted.retryAfterSeconds, only);
  }

  /** `clean`: the peek found no row a success would lower or clear, so a per-request success skips `succeed`. */
  private async verified(candidates: readonly AuthenticationStrategy[], keyed: Keyed, c: Credentials, ctx: AuthnContext, only: { strategy?: string }, clean: boolean): Promise<AuthenticationResult> {
    const v = await this.verifyWith(candidates, c, ctx);
    if (v === null) {
      await this.Auditor.publishIn(ctx, { type: 'login', outcome: 'failure', reason: 'unsupported_credentials', ...only });
      return fail('unsupported_credentials');
    }
    if ('broken' in v) return this.refuse(ctx, v.s, v.broken, 'invalid_credentials', v.data ? { data: v.data } : {});
    if (!v.outcome.ok) {
      const refused = await this.refuse(ctx, v.s, v.outcome.reason, v.outcome.reason);
      return v.outcome.reason === 'throttled' ? { ...refused, retryAfterSeconds: retryAfterOf(v.outcome) } : refused;
    }
    try {
      return await this.accept(v.s, v.outcome, keyed.of(v.s), ctx, clean);
    } catch (err) {
      // Only a verified credential gets here: a rejection would tell it apart from a wrong one (A02).
      return this.refuse(ctx, v.s, 'store_error', 'invalid_credentials', { data: { error: errorClass(err) } });
    }
  }

  public async completeMfa(pending: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult> {
    const stored = await restoreHandle(this.Sessions, pending);
    if (!stored || stored.handle.state !== 'pending') {
      await this.Auditor.publishIn(ctx, { type: 'mfa.verify', outcome: 'failure', reason: 'not_pending' });
      return fail('invalid_credentials');
    }
    const id = stored.identity;
    const about = { identity: id, strategy: stored.facts.strategy, ...(isNonEmptyString(stored.facts.sessionHandle) ? { session: stored.facts.sessionHandle } : {}) };
    const keys = identityThrottleKeys(id, ctx);
    const gate = await this.Throttle.attempt(keys, 'mfa', ctx);
    if (!gate.allowed) {
      await this.Auditor.publishIn(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', ...about });
      return { status: 'failure', reason: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }

    let passed: boolean | string;
    try {
      passed = await this.passMfa(id, stored.facts, step, response);
    } catch (err) {
      await this.Auditor.publishIn(ctx, { type: 'mfa.verify', outcome: 'failure', ...policyRefusal(err, 'step_error'), ...about });
      return fail('invalid_credentials');
    }
    if (passed !== true) {
      await this.Auditor.publishIn(ctx, { type: 'mfa.verify', outcome: 'failure', reason: passed === false ? 'invalid_code' : passed, ...about });
      return fail('invalid_credentials');
    }
    // An account banned or deleted between the two steps must not get in.
    let refused: string | null;
    try {
      refused = await statusRefusal(this.Identities, id);
      if (refused) await this.Sessions.revoke(stored.handle);
    } catch (err) {
      await this.Auditor.publishIn(ctx, { type: 'mfa.verify', outcome: 'failure', reason: 'store_error', data: { error: errorClass(err) }, ...about });
      return fail('invalid_credentials');
    }
    if (refused) {
      await this.Auditor.publishIn(ctx, { type: 'login', outcome: 'failure', reason: refused, ...about });
      return fail('invalid_credentials');
    }

    let session: SessionHandle;
    let facts: Success['facts'];
    try {
      session = await this.Sessions.elevate({ id: pending.id, state: 'pending' }, { assurance: 'aal2', mfa: [step] });
      const now = await this.Sessions.restore(session.id);
      if (!now) throw new InvalidOperation('the elevated session is gone');
      const { authenticatedAt: _at, ...rest } = now.facts;
      facts = rest;
      await this.Throttle.succeed(keys, 'mfa');
    } catch (err) {
      await this.Auditor.publishIn(ctx, { type: 'mfa.verify', outcome: 'failure', reason: 'session_error', data: { error: errorClass(err) }, ...about });
      return fail('invalid_credentials');
    }
    const done = { identity: id, strategy: facts.strategy, ...(isNonEmptyString(facts.sessionHandle) ? { session: facts.sessionHandle } : {}) };
    await this.Auditor.publishIn(ctx, { type: 'mfa.verify', outcome: 'success', ...done });
    await this.Auditor.publishIn(ctx, { type: 'login', outcome: 'success', ...done });
    return { status: 'success', identity: id, facts, session };
  }

  public async reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean> {
    const stored = await restoreHandle(this.Sessions, session);
    if (!stored || stored.handle.state !== 'active') {
      await this.Auditor.publishIn(ctx, { type: 'reauth', outcome: 'failure', reason: 'not_active' });
      return false;
    }
    const id = stored.identity;
    const about = { identity: id, ...(isNonEmptyString(stored.facts.sessionHandle) ? { session: stored.facts.sessionHandle } : {}) };
    // The target's password must not let an impersonator act as the target (M6).
    if (stored.facts.impersonator !== undefined) {
      await this.Auditor.publishIn(ctx, { type: 'reauth', outcome: 'failure', reason: 'impersonation', ...about });
      return false;
    }
    // A login method shows the user is present; a token or key the client holds does not.
    const candidates = this.Registry.candidates(c).filter((s) => s.interactive);
    if (candidates.length === 0) {
      await this.Auditor.publishIn(ctx, { type: 'reauth', outcome: 'failure', reason: 'unsupported_credentials', ...about });
      return false;
    }
    const keys = identityThrottleKeys(id, ctx);
    if (!(await this.Throttle.attempt(keys, 'reauth', ctx)).allowed) {
      await this.Auditor.publishIn(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', ...about });
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
      else reason = (await this.isSessionIdentity(v.outcome, id)) ? await statusRefusal(this.Identities, id) : 'other_identity';
      if (reason === null) await this.Throttle.succeed(keys, 'reauth');
    } catch (err) {
      [reason, data] = ['store_error', { error: errorClass(err) }];
    }
    if (reason !== null) {
      await this.Auditor.publishIn(ctx, { type: 'reauth', outcome: 'failure', reason, ...(data ? { data } : {}), ...strategy, ...about });
      return false;
    }
    await this.Auditor.publishIn(ctx, { type: 'reauth', outcome: 'success', ...strategy, ...about });
    return true;
  }

  public async principalOf(result: Success): Promise<Principal> {
    if (!isPlainObject(result) || result.status !== 'success' || !isRef(result.identity)) {
      throw new InvalidArgument('principalOf takes a success result');
    }
    let facts: AuthnFacts;
    if (result.session) {
      const stored = await this.Sessions.restore(result.session.id);
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
      extra.onBehalfOf = await this.Principals.principalOf(result.delegation.onBehalfOf, facts, {});
      extra.delegation = result.delegation.mode;
    }
    if (result.attributes !== undefined) extra.attributes = result.attributes;
    return this.Principals.principalOf(result.identity, facts, extra);
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

  private async accept(s: AuthenticationStrategy, r: Verified, keys: readonly ThrottleKey[], ctx: AuthnContext, clean: boolean): Promise<AuthenticationResult> {
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
    // A token or key is no login: only a login method is held to authn.login.requireVerifiedAddress.
    const refused = await statusRefusal(this.Identities, r.delegation?.onBehalfOf ?? id, { requireVerifiedAddress: s.interactive && this.RequireVerifiedAddress === true });
    if (refused) return this.refuse(ctx, s, refused, refused === 'unverified_address' ? 'unverified_address' : 'invalid_credentials', { identity: id });
    // Before the link by verified email, so a login a hook refuses leaves neither a session nor a new email link.
    if (s.interactive && r.external) {
      const hookError = await this.runLoginHooks(id, r.external);
      if (hookError !== null) return this.refuse(ctx, s, 'hook_error', 'invalid_credentials', { identity: id, data: { error: hookError } });
    }

    if (found.link && !found.provisioned) await this.link(ctx, s, id, found.link);

    const facts = { method: r.method, strategy: s.name, assurance: r.assurance ?? ('aal1' as const), mfa: [] as string[] };
    const extra = { ...(r.ceiling !== undefined ? { ceiling: r.ceiling } : {}), ...(r.delegation ? { delegation: r.delegation } : {}), ...(r.attributes !== undefined ? { attributes: r.attributes } : {}) };
    // A token or key is used on every request: its success skips a succeed with nothing to do and waits for no sink.
    if (!s.interactive) {
      if (!clean) await this.Throttle.succeed(keys, 'login');
      this.Auditor.publishDetached(ctx, { type: this.eventOf(s), outcome: 'success', strategy: s.name, identity: id });
      return { status: 'success', identity: id, facts, ...extra };
    }

    const sessions = this.Sessions;
    let steps: string[];
    try {
      steps = [...(await this.Policy.required(id, { method: facts.method, strategy: facts.strategy }))];
    } catch (err) {
      const why = policyRefusal(err, 'policy_error');
      return this.refuse(ctx, s, why.reason, 'invalid_credentials', { identity: id, data: why.data });
    }
    // Only now: a login the policy refuses keeps its count, so the backoff cannot tell its right password from a wrong one.
    await this.Throttle.succeed(keys, 'login');
    const issued: AuthnFacts = { ...facts, authenticatedAt: ctx.now };
    if (steps.length > 0) {
      const pending = await sessions.issue(id, issued, { pending: { steps } });
      await this.Auditor.publishIn(ctx, { type: 'mfa.challenge', outcome: 'success', strategy: s.name, identity: id, session: await this.handleOf(pending) });
      return { status: 'mfa_required', pending, steps };
    }
    const session = await sessions.issue(id, issued);
    const handle = await this.handleOf(session);
    await this.Auditor.publishIn(ctx, { type: 'login', outcome: 'success', strategy: s.name, identity: id, session: handle });
    await this.Auditor.publishIn(ctx, { type: 'session.issue', outcome: 'success', strategy: s.name, identity: id, session: handle });
    return { status: 'success', identity: id, facts: { ...facts, ...(handle !== undefined ? { sessionHandle: handle } : {}) }, session, ...extra };
  }

  /**
   * Every ExternalLoginHook of this container's lineage (as AuthnAudit takes its sinks), resolved per login so hooks
   * registered late run; the error class of the first that throws, or null.
   */
  private async runLoginHooks(id: IdentityRef, external: ExternalSubject): Promise<string | null> {
    try {
      const chain = (await this.Container.resolve(Array.chainOf(ExternalLoginHook))) as readonly ExternalLoginHook[];
      for (const hook of chain) await hook.afterLogin(id, external);
      return null;
    } catch (err) {
      return errorClass(err);
    }
  }

  /**
   * True: passed; false: a wrong code; a string: why the step cannot be taken (audit reason). The steps the policy
   * requires now are alternatives; `recovery` goes to the first enrolled step that takes recovery codes (D6).
   */
  private async passMfa(id: IdentityRef, facts: AuthnFacts, step: string, response: string): Promise<boolean | string> {
    const required = await this.Policy.required(id, { method: facts.method, strategy: facts.strategy });
    if (required.length === 0) return 'no_steps';
    const steps = await this.Policy.steps();
    if (step === RECOVERY_STEP) {
      for (const s of steps.values()) {
        if (typeof s.verifyRecovery === 'function' && (await s.enrolled(id))) return (await s.verifyRecovery(id, response)) === true;
      }
      return 'no_recovery_step';
    }
    const s = required.includes(step) ? steps.get(step) : undefined;
    if (!s) return 'unknown_step';
    // Under force the required step may be one the identity has not enrolled; the MfaStep contract does not oblige verify to refuse that.
    if (!(await s.enrolled(id))) return 'not_enrolled';
    return (await s.verify(id, response)) === true;
  }

  /** A re-authentication proves the session's own identity: a delegation or an unlinked subject does not (A13). */
  private async isSessionIdentity(r: Verified, id: IdentityRef): Promise<boolean> {
    if (r.delegation) return false;
    const verified = r.identity ?? (r.external && this.Links ? (await this.Links.find(r.external.provider, r.external.subject))?.identity : undefined);
    return verified !== undefined && sameRef(verified, id);
  }

  /**
   * A linked identity, or one found by verified email or provisioned (then `link` is the subject to link). Each way past
   * an existing link needs the global switch and the strategy's own switch for the provider (K6).
   */
  private async linked(s: AuthenticationStrategy, external: ExternalSubject): Promise<Found> {
    if (!this.Links) return { id: null };
    const found = await this.Links.find(external.provider, external.subject);
    if (found) return { id: found.identity };
    // === true: a value set at runtime never went through the schema, and a truthy string must not switch linking on.
    const global = { jit: this.Linking.jit === true, byVerifiedEmail: this.Linking.byVerifiedEmail === true };
    const own = global.jit || global.byVerifiedEmail ? linkingSwitchesOf(s, external) : { jit: false, byVerifiedEmail: false };
    if (global.byVerifiedEmail && own.byVerifiedEmail && external.emailVerified === true && isNonEmptyString(external.email)) {
      // findByLogin also matches login names; only the identity's own stored email may decide.
      const id = await this.Identities.findByLogin(external.email);
      if (id && sameEmail((await this.Identities.display(id))?.email, external.email)) return { id, link: external, provisioned: false };
    }
    if (global.jit && own.jit && typeof this.Identities.provision === 'function') {
      return { id: await this.Identities.provision(external), link: external, provisioned: true };
    }
    return { id: null };
  }

  private async link(ctx: AuthnContext, s: AuthenticationStrategy, id: IdentityRef, external: ExternalSubject): Promise<void> {
    await this.Links!.link(id, external);
    await this.Auditor.publishIn(ctx, { type: 'identity.link', outcome: 'success', strategy: s.name, identity: id, data: { provider: external.provider } });
  }

  /**
   * Each candidate's keys with `account-ip` = `<account>|<ip>` for its account keys, and the shared ip and global keys.
   * The service builds `account-ip` itself and drops the strategies' own (D8b): the throttle takes every `account-ip`
   * in a success off the ip key, so a value without this ip would clear another ip's failures. The attempt counts
   * the union; `succeed` gets only the answering strategy's keys (D8).
   *
   * The ip in all three keys is the throttleIp form: an IPv6 client holds a whole prefix, so its addresses share one row (L3).
   *
   * A per-request strategy's `account` key is `request:<account>|<ip>` (K6): its credential ids travel in clear (a key
   * id in every signed request), so a credential-wide key would let anyone keep a victim's key or token in backoff.
   * Guessing stays bounded by that key per ip and by the ip key. An interactive strategy's is `login:<account>`, so no
   * login string can name a per-request key.
   */
  private keysFor(candidates: readonly AuthenticationStrategy[], c: Credentials, ctx: AuthnContext): Keyed | { strategy: AuthenticationStrategy; error: string } {
    const own = new Map<AuthenticationStrategy, ThrottleKey[]>();
    const ip = isNonEmptyString(ctx.ip) ? throttleIp(ctx.ip, this.ipv6Prefix) : undefined;
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
      if (ip !== undefined) {
        for (const k of accounts) keys.push({ kind: 'account-ip', value: `${k.value}|${ip}` });
      }
      if (!s.interactive) {
        for (const k of accounts) k.value = `${k.value}|${ip ?? ''}`;
      }
      own.set(s, keys);
    }
    const shared: ThrottleKey[] = [...(ip !== undefined ? [{ kind: 'ip', value: ip }] : []), ...(this.globalGate ? [{ kind: 'global', value: 'login' }] : [])];
    return { all: dedupe([...[...own.values()].flat(), ...shared]), of: (s) => dedupe([...(own.get(s) ?? []), ...shared]) };
  }

  private async throttled(ctx: AuthnContext, retryAfterSeconds: number, only: { strategy?: string }): Promise<Failure> {
    await this.Auditor.publishIn(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', ...only });
    return { status: 'failure', reason: 'throttled', retryAfterSeconds };
  }

  private async refuse(ctx: AuthnContext, s: AuthenticationStrategy, reason: string, answer: AuthnFailure, extra: Partial<AuthnEventBody> = {}): Promise<Failure> {
    await this.Auditor.publishIn(ctx, { type: this.eventOf(s), outcome: 'failure', strategy: s.name, reason, ...extra });
    return fail(answer);
  }

  /** Interactive strategies log in; the others are uses of a token or a key. */
  private eventOf(s: AuthenticationStrategy): AuthnEventType {
    if (s.interactive) return 'login';
    return s.kinds.some((k) => KEY_KINDS.has(k)) ? 'key.use' : 'token.use';
  }

  private async handleOf(h: SessionHandle): Promise<string | undefined> {
    return (await this.Sessions.restore(h.id))?.facts.sessionHandle;
  }

}
