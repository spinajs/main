import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { AuthnEventSink, AuthnService, AuthnThrottle, MfaStep, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, AuthnFacts, Credentials, IdentityRef, PrincipalRef, SessionHandle, ThrottleKey } from '@spinajs/authn/contracts';
import { TotpAlreadyEnrolled, TotpEnrolmentChanged, TotpInvalidCode, TotpNotBegun, TotpNotEnrolled, TotpRecoveryCodesNotIssued } from '../step/errors.js';
import { TotpMfaStep } from '../step/totp-step.js';
import { freshAuthMaxAge, isFresh } from './fresh-auth.js';

export type TotpBeginResult = { readonly ok: true; readonly provisioning: string } | { readonly ok: false; readonly code: 'no_session' | 'not_fresh' | 'enrolled' };
/** `enrolled`: already enrolled, another confirmation won, or the codes could not be issued; the owner regenerates the codes. */
export type TotpConfirmResult = { readonly ok: true; readonly recoveryCodes: readonly string[] } | { readonly ok: false; readonly code: 'no_session' | 'not_begun' | 'invalid_code' | 'enrolled' | 'throttled'; readonly retryAfterSeconds?: number };
export type TotpDisableResult = { readonly ok: true } | { readonly ok: false; readonly code: 'no_session' | 'not_fresh' | 'not_enrolled' | 'invalid_code' | 'throttled'; readonly retryAfterSeconds?: number };
export type TotpRegenerateResult = { readonly ok: true; readonly recoveryCodes: readonly string[] } | { readonly ok: false; readonly code: 'no_session' | 'not_fresh' | 'not_enrolled' };

/** Left out, a dependency is resolved from DI on first use. */
export interface TotpServiceDeps {
  readonly step?: TotpMfaStep;
  readonly sessions?: SessionIssuer;
  readonly authn?: AuthnService;
  readonly throttle?: AuthnThrottle;
  readonly sinks?: readonly AuthnEventSink[];
  /** `authn.freshAuth.maxAgeSeconds`. */
  readonly maxAgeSeconds?: number;
}

interface Resolved {
  readonly step: TotpMfaStep;
  readonly sessions: SessionIssuer;
  readonly authn: AuthnService;
  readonly throttle: AuthnThrottle;
  readonly sinks: readonly AuthnEventSink[];
  readonly maxAgeSeconds: number;
}

interface Current {
  readonly handle: SessionHandle;
  readonly identity: IdentityRef;
  readonly facts: AuthnFacts;
}

/**
 * The owner's TOTP enrolment (D9): begin, confirm, disable and regenerate act on the identity of the restored session,
 * never on one the caller names. Refusals are results, not exceptions. Begin, disable and regenerate need fresh auth
 * (A13); a pending session may only begin and confirm, and only while the identity is not enrolled (A09). Every code
 * check of confirm and disable counts into the `mfa` throttle first (A10).
 *
 * `adminReset` does not check who may reset whom: the caller applies the target guard (A25, `users:credentials`) first.
 * It never returns a secret (SR-10). No result or event carries a secret, a code or a recovery code (SR-01, A21).
 */
@Injectable()
export class TotpService {
  private resolved: Resolved | null = null;
  private readonly maxAgeSeconds: number | undefined;

  constructor(private readonly deps: TotpServiceDeps = {}) {
    this.maxAgeSeconds = deps.maxAgeSeconds === undefined ? undefined : freshAuthMaxAge(deps.maxAgeSeconds);
  }

  async begin(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<TotpBeginResult> {
    const { step } = await this.resolve();
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
    const { step, throttle } = await this.resolve();
    // An enrolled identity's pending session reaches here too, so a lost double submit in the forced first login hears `enrolled`.
    const c = await this.restored(session);
    if (!c) {
      return { ok: false, code: 'no_session' };
    }
    const state = await step.enrolment(c.identity);
    if (state !== 'pending') {
      const failure = state === 'confirmed' ? 'enrolled' : 'not_begun';
      await this.audit(ctx, c, { type: 'mfa.enrol', outcome: 'failure', reason: failure });
      return { ok: false, code: failure };
    }
    const keys = throttleKeys(c.identity, ctx);
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
    const { step, throttle } = await this.resolve();
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
    const keys = throttleKeys(c.identity, ctx);
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
    const { step } = await this.resolve();
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
    const { step } = await this.resolve();
    const before = await step.enrolment(target);
    await step.disable(target);
    await this.publish(ctx, { type: 'mfa.disable', outcome: 'success', identity: target, actor, data: { reset: true, existed: before } });
    return { reset: before !== 'none' };
  }

  /** The restored session, active or pending, unless it is gone or impersonated. */
  private async restored(session: SessionHandle): Promise<Current | null> {
    const { sessions } = await this.resolve();
    const id: unknown = (session as Partial<SessionHandle> | null | undefined)?.id;
    if (typeof id !== 'string' || id === '') {
      return null;
    }
    const s = await sessions.restore(id);
    if (!s || s.facts.impersonator !== undefined || (s.handle.state !== 'active' && s.handle.state !== 'pending')) {
      return null;
    }
    return s;
  }

  /** As `restored`; a pending session only where allowed and only while the identity is not enrolled. */
  private async current(session: SessionHandle, allowPending: boolean): Promise<Current | null> {
    const { step } = await this.resolve();
    const s = await this.restored(session);
    if (s && (s.handle.state === 'active' || (allowPending && !(await step.enrolled(s.identity))))) {
      return s;
    }
    return null;
  }

  /** `reauth` is checked only when the session is not fresh, and never for a pending one (reauthenticate refuses it). */
  private async fresh(c: Current, ctx: AuthnContext, reauth?: Credentials): Promise<boolean> {
    const { authn, maxAgeSeconds } = await this.resolve();
    if (isFresh(c.facts, ctx.now, maxAgeSeconds)) {
      return true;
    }
    return c.handle.state === 'active' && reauth !== undefined && (await authn.reauthenticate(c.handle, reauth, ctx));
  }

  private async audit(ctx: AuthnContext, c: Current, e: Pick<AuthnEvent, 'type' | 'outcome' | 'reason' | 'data'>): Promise<void> {
    await this.publish(ctx, { ...e, identity: c.identity, ...(c.facts.sessionHandle ? { session: c.facts.sessionHandle } : {}) });
  }

  private async publish(ctx: AuthnContext, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
    const { sinks } = await this.resolve();
    const event: AuthnEvent = { at: ctx.now, ...(ctx.ip ? { ip: ctx.ip } : {}), ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}), ...e };
    for (const sink of sinks) {
      await sink.publish(event);
    }
  }

  private async resolve(): Promise<Resolved> {
    if (this.resolved) {
      return this.resolved;
    }
    const d = this.deps;
    const step = d.step ?? (DI.check(MfaStep) ? (await DI.resolve(Array.ofType(MfaStep))).find((s): s is TotpMfaStep => s instanceof TotpMfaStep) : undefined);
    const sessions = d.sessions ?? (await resolveOne(SessionIssuer));
    const authn = d.authn ?? (await resolveOne(AuthnService));
    const throttle = d.throttle ?? (await resolveOne(AuthnThrottle));
    if (!step || !sessions || !authn || !throttle) {
      throw new InvalidOperation('TotpService: register TotpMfaStep, a SessionIssuer, an AuthnService and an AuthnThrottle');
    }
    const sinks = d.sinks ?? (DI.check(AuthnEventSink) ? await DI.resolve(Array.ofType(AuthnEventSink)) : []);
    const maxAgeSeconds = this.maxAgeSeconds ?? freshAuthMaxAge(DI.get(Configuration)?.get<unknown>(['authn', 'freshAuth', 'maxAgeSeconds']));
    this.resolved = { step, sessions, authn, throttle, sinks, maxAgeSeconds };
    return this.resolved;
  }
}

async function resolveOne<T>(type: abstract new (...args: never[]) => T): Promise<T | null> {
  const t = type as unknown as new () => T;
  return DI.check(t) ? ((await DI.resolve(t)) as T) : null;
}

/** N1's `mfa` flow keys. */
function throttleKeys(id: IdentityRef, ctx: AuthnContext): ThrottleKey[] {
  return [{ kind: 'account', value: id.id }, { kind: 'account-ip', value: `${id.id}|${ctx.ip ?? ''}` }, ...(ctx.ip ? [{ kind: 'ip', value: ctx.ip }] : [])];
}
