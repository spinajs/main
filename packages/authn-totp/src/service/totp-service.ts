import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { _is_string, _non_empty, _try_check_arg } from '@spinajs/util';
import { AuthnAudit } from '@spinajs/authn/audit';
import type { AuthnAuditor, AuthnEventBody } from '@spinajs/authn/audit';
import { AuthnService, AuthnThrottle, MfaEnrolmentService, MfaStep, SessionIssuer, identityThrottleKeys, ipv6PrefixOf, isFresh } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, AuthnEventSink, AuthnFacts, Credentials, IdentityRef, MfaBeginResult, MfaConfirmResult, MfaDisableResult, MfaRegenerateResult, PrincipalRef, SessionHandle } from '@spinajs/authn/contracts';
import { TotpAlreadyEnrolled, TotpEnrolmentChanged, TotpInvalidCode, TotpNotBegun, TotpNotEnrolled, TotpRecoveryCodesNotIssued } from '../step/errors.js';
import { TotpMfaStep } from '../step/totp-step.js';

export type TotpBeginResult = MfaBeginResult;
export type TotpConfirmResult = MfaConfirmResult;
export type TotpDisableResult = MfaDisableResult;
export type TotpRegenerateResult = MfaRegenerateResult;

/** Left out, a dependency is the one injected by the container that resolves the service. */
export interface TotpServiceDeps {
  readonly step?: TotpMfaStep;
  /** Every MFA step of the app; a pending session may enrol only while the identity is enrolled in none of them. */
  readonly steps?: readonly MfaStep[];
  readonly sessions?: SessionIssuer;
  readonly authn?: AuthnService;
  readonly throttle?: AuthnThrottle;
  /** Published to through `AuthnAudit.over`; left out, the container's AuthnAudit. */
  readonly sinks?: readonly AuthnEventSink[];
  /** `authn.freshAuth.maxAgeSeconds`. */
  readonly maxAgeSeconds?: number;
  /** `authn.throttle.ipv6Prefix`. */
  readonly ipv6Prefix?: number;
}

interface Current {
  readonly handle: SessionHandle;
  readonly identity: IdentityRef;
  readonly facts: AuthnFacts;
}

/**
 * The owner's TOTP enrolment: begin, confirm, disable and regenerate act on the identity of the restored session,
 * never on one the caller names. Refusals are results, not exceptions. Begin, disable and regenerate need fresh auth
 * (A13); a pending session may only begin and confirm, and only while the identity is enrolled in no MFA step (A09): the
 * login accepts any enrolled step, so a second factor added from a password-only session would pass it. Every code
 * check of confirm and disable counts into the `mfa` throttle first (A10).
 *
 * `adminReset` does not check who may reset whom: the caller applies the target guard (A25, `users:credentials`) first.
 * It never returns a secret (SR-10). No result or event carries a secret, a code or a recovery code (SR-01, A21).
 */
@Injectable(MfaEnrolmentService)
export class TotpService extends MfaEnrolmentService {
  @Config('authn.freshAuth.maxAgeSeconds')
  protected MaxAgeSeconds: number;

  @Config('authn.throttle.ipv6Prefix')
  protected ThrottleIpv6Prefix: unknown;

  @Config('authn.mfa.encryptionKey.secret')
  protected EncryptionKey: string | null | undefined;

  @Autoinject(AuthnAudit)
  protected Audit: AuthnAudit;

  @Autoinject(MfaStep)
  protected Steps: MfaStep[];

  // Optional: the CLI's adminReset needs only the step and the audit.
  @Autoinject(SessionIssuer, { optional: true })
  protected Sessions: SessionIssuer | undefined;

  @Autoinject(AuthnService, { optional: true })
  protected Authn: AuthnService | undefined;

  @Autoinject(AuthnThrottle, { optional: true })
  protected Throttle: AuthnThrottle | undefined;

  private readonly sinkAudit: AuthnAuditor | undefined;

  constructor(private readonly deps: TotpServiceDeps = {}) {
    super();
    this.sinkAudit = deps.sinks && AuthnAudit.over(deps.sinks);
  }

  /** "Turning TOTP on": the steps list TotpMfaStep itself, not a subclass, and authn.mfa.encryptionKey.secret is set. */
  enabled(steps: Iterable<MfaStep>): boolean {
    return !!this.EncryptionKey && [...steps].some((s) => s.constructor === TotpMfaStep);
  }

  async begin(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<TotpBeginResult> {
    const step = this.step();
    const c = await this.current(session, true);
    if (!c) {
      return { ok: false, code: 'no_session' };
    }
    if (!(await this.fresh(c, ctx, reauth))) {
      return { ok: false, code: 'not_fresh' };
    }
    try {
      const { provisioning } = await step.beginEnrolment(c.identity);
      return { ok: true, provisioning };
    } catch (err) {
      if (err instanceof TotpAlreadyEnrolled) {
        return { ok: false, code: 'enrolled' };
      }
      throw err;
    }
  }

  /** A successful confirm returns recovery codes, so every code is counted into the `mfa` throttle before it is checked. */
  async confirm(session: SessionHandle, code: string, ctx: AuthnContext): Promise<TotpConfirmResult> {
    const step = this.step();
    const throttle = this.throttle();
    // An enrolled identity's pending session reaches here too, so a lost double submit in the forced first login hears `enrolled`.
    const c = await this.restored(session);
    if (!c) {
      return { ok: false, code: 'no_session' };
    }
    const state = await step.enrolment(c.identity);
    if (state === 'pending' && c.handle.state === 'pending' && (await this.enrolledElsewhere(c.identity))) {
      return { ok: false, code: 'no_session' };
    }
    if (state !== 'pending') {
      const failure = state === 'confirmed' ? 'enrolled' : 'not_begun';
      await this.audit(ctx, c, { type: 'mfa.enrol', outcome: 'failure', reason: failure });
      return { ok: false, code: failure };
    }
    const keys = identityThrottleKeys(c.identity, ctx, this.ipv6Prefix());
    const gate = await throttle.attempt(keys, 'mfa', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, c, { type: 'throttle.block', outcome: 'failure', reason: 'throttled' });
      await this.audit(ctx, c, { type: 'mfa.enrol', outcome: 'failure', reason: 'throttled' });
      return { ok: false, code: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }
    let failure: 'not_begun' | 'invalid_code' | 'enrolled';
    try {
      const { recoveryCodes } = await step.confirmEnrolment(c.identity, code);
      await throttle.succeed(keys, 'mfa');
      await this.audit(ctx, c, { type: 'mfa.enrol', outcome: 'success' });
      return { ok: true, recoveryCodes: recoveryCodes ?? [] };
    } catch (err) {
      if (err instanceof TotpRecoveryCodesNotIssued) {
        await throttle.succeed(keys, 'mfa');
        await this.audit(ctx, c, { type: 'mfa.enrol', outcome: 'success', reason: 'recovery_codes_not_issued' });
        return { ok: false, code: 'enrolled' };
      }
      if (err instanceof TotpNotBegun) {
        failure = 'not_begun';
      } else if (err instanceof TotpInvalidCode || err instanceof TotpEnrolmentChanged) {
        failure = 'invalid_code';
      } else if (err instanceof TotpAlreadyEnrolled) {
        failure = 'enrolled';
      } else {
        throw err;
      }
    }
    await this.audit(ctx, c, { type: 'mfa.enrol', outcome: 'failure', reason: failure });
    return { ok: false, code: failure };
  }

  /** `code` is a TOTP code or a recovery code; counted into the `mfa` throttle before it is checked. */
  async disable(session: SessionHandle, code: string, ctx: AuthnContext, reauth?: Credentials): Promise<TotpDisableResult> {
    const step = this.step();
    const throttle = this.throttle();
    const c = await this.current(session, false);
    if (!c) {
      return { ok: false, code: 'no_session' };
    }
    if (!(await this.fresh(c, ctx, reauth))) {
      await this.audit(ctx, c, { type: 'mfa.disable', outcome: 'failure', reason: 'not_fresh' });
      return { ok: false, code: 'not_fresh' };
    }
    if (!(await step.enrolled(c.identity))) {
      return { ok: false, code: 'not_enrolled' };
    }
    const keys = identityThrottleKeys(c.identity, ctx, this.ipv6Prefix());
    const gate = await throttle.attempt(keys, 'mfa', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, c, { type: 'throttle.block', outcome: 'failure', reason: 'throttled' });
      await this.audit(ctx, c, { type: 'mfa.disable', outcome: 'failure', reason: 'throttled' });
      return { ok: false, code: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }
    if (!(await step.verify(c.identity, code)) && !(await step.verifyRecovery(c.identity, code))) {
      await this.audit(ctx, c, { type: 'mfa.disable', outcome: 'failure', reason: 'invalid_code' });
      return { ok: false, code: 'invalid_code' };
    }
    await throttle.succeed(keys, 'mfa');
    await step.disable(c.identity);
    await this.audit(ctx, c, { type: 'mfa.disable', outcome: 'success' });
    return { ok: true };
  }

  /** Audited as `mfa.enrol` with `data.recoveryCodes = 'regenerated'`: the contract has no event type of its own for it. */
  async regenerateRecoveryCodes(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<TotpRegenerateResult> {
    const step = this.step();
    const c = await this.current(session, false);
    if (!c) {
      return { ok: false, code: 'no_session' };
    }
    const data = { recoveryCodes: 'regenerated' };
    if (!(await this.fresh(c, ctx, reauth))) {
      await this.audit(ctx, c, { type: 'mfa.enrol', outcome: 'failure', reason: 'not_fresh', data });
      return { ok: false, code: 'not_fresh' };
    }
    let recoveryCodes: readonly string[];
    try {
      recoveryCodes = await step.regenerateRecoveryCodes(c.identity);
    } catch (err) {
      if (err instanceof TotpNotEnrolled) {
        await this.audit(ctx, c, { type: 'mfa.enrol', outcome: 'failure', reason: 'not_enrolled', data });
        return { ok: false, code: 'not_enrolled' };
      }
      throw err;
    }
    await this.audit(ctx, c, { type: 'mfa.enrol', outcome: 'success', data: { ...data, count: recoveryCodes.length } });
    return { ok: true, recoveryCodes };
  }

  /** True when an enrolment or a pending row existed. */
  async adminReset(actor: PrincipalRef, target: IdentityRef, ctx: AuthnContext): Promise<{ reset: boolean }> {
    const step = this.step();
    const before = await step.enrolment(target);
    await step.disable(target);
    await this.publish(ctx, { type: 'mfa.disable', outcome: 'success', identity: target, actor, data: { reset: true, existed: before } });
    return { reset: before !== 'none' };
  }

  /** The restored session, active or pending, unless it is gone or impersonated. */
  private async restored(session: SessionHandle): Promise<Current | null> {
    const sessions = this.sessions();
    const [ok, id] = _try_check_arg(_is_string(_non_empty()))((session as Partial<SessionHandle> | null | undefined)?.id, 'session.id');
    if (!ok) {
      return null;
    }
    const s = await sessions.restore(id);
    if (!s || s.facts.impersonator !== undefined || (s.handle.state !== 'active' && s.handle.state !== 'pending')) {
      return null;
    }
    return s;
  }

  /** As `restored`; a pending session only where allowed and only while the identity is enrolled in no MFA step. */
  private async current(session: SessionHandle, allowPending: boolean): Promise<Current | null> {
    const step = this.step();
    const s = await this.restored(session);
    if (s && (s.handle.state === 'active' || (allowPending && !(await step.enrolled(s.identity)) && !(await this.enrolledElsewhere(s.identity))))) {
      return s;
    }
    return null;
  }

  private async enrolledElsewhere(id: IdentityRef): Promise<boolean> {
    const step = this.step();
    for (const other of this.steps()) {
      if (other !== step && other.name !== step.name && (await other.enrolled(id))) {
        return true;
      }
    }
    return false;
  }

  /** `reauth` is checked only when the session is not fresh, and never for a pending one (reauthenticate refuses it). */
  private async fresh(c: Current, ctx: AuthnContext, reauth?: Credentials): Promise<boolean> {
    if (isFresh(c.facts, ctx.now, this.maxAgeSeconds())) {
      return true;
    }
    return c.handle.state === 'active' && reauth !== undefined && (await this.authn().reauthenticate(c.handle, reauth, ctx));
  }

  private async audit(ctx: AuthnContext, c: Current, e: Pick<AuthnEvent, 'type' | 'outcome' | 'reason' | 'data'>): Promise<void> {
    await this.publish(ctx, { ...e, identity: c.identity, ...(c.facts.sessionHandle ? { session: c.facts.sessionHandle } : {}) });
  }

  private async publish(ctx: AuthnContext, e: AuthnEventBody): Promise<void> {
    await this.auditor().publishIn(ctx, e);
  }

  private step(): TotpMfaStep {
    return this.deps.step ?? (this.Steps ?? []).find((s): s is TotpMfaStep => s instanceof TotpMfaStep) ?? missing('TotpMfaStep');
  }

  private steps(): readonly MfaStep[] {
    return this.deps.steps ?? this.Steps ?? [];
  }

  private sessions(): SessionIssuer {
    return this.deps.sessions ?? this.Sessions ?? missing('SessionIssuer');
  }

  private authn(): AuthnService {
    return this.deps.authn ?? this.Authn ?? missing('AuthnService');
  }

  private throttle(): AuthnThrottle {
    return this.deps.throttle ?? this.Throttle ?? missing('AuthnThrottle');
  }

  private auditor(): AuthnAuditor {
    return this.sinkAudit ?? this.Audit ?? missing('AuthnAudit');
  }

  private ipv6Prefix(): number {
    return this.deps.ipv6Prefix ?? ipv6PrefixOf(this.ThrottleIpv6Prefix);
  }

  private maxAgeSeconds(): number {
    return this.deps.maxAgeSeconds ?? this.MaxAgeSeconds;
  }
}

function missing(name: string): never {
  throw new InvalidOperation(`TotpService: no ${name} is registered`);
}
