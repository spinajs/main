import { AsyncService, Autoinject, Container, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { TimeSpan, _is_object, _is_string, _non_empty, _try_check_arg, isNonEmptyString, isPlainObject } from '@spinajs/util';

import type { AuthnEvent, AuthnEventType } from '../contracts/audit.js';
import type { AuthnContext, Credentials, IdentityRef } from '../contracts/credentials.js';
import { errorClass, isRef } from '../support/guards.js';
import { IdentityStore } from '../contracts/identity.js';
import type { IdentityStatus } from '../contracts/identity.js';
import { ImpersonationGuard } from '../contracts/impersonation.js';
import type { AuthnFacts, Ceiling, Principal, PrincipalRef } from '../contracts/principal.js';
import { PrincipalFactory } from '../contracts/service.js';
import { SessionIssuer } from '../contracts/session.js';
import type { SessionHandle } from '../contracts/session.js';
import { AuthnAudit } from '../audit/authn-audit.js';
import { FreshAuthCheck } from '../freshauth/fresh-auth-check.js';
import { Session, SessionKeys, resolveSession } from '../contracts/session-state.js';
import { ACTIVE_ROLE_KEY, activeRoleCeiling } from './active-role.js';

/**
 * The session data key of the impersonation block: `{ startedAt, actorRoles? }`, the start as an ISO string and the
 * `ceiling.roles` of the actor's role switch at start. Not under ActiveRole, which would narrow the target.
 */
export const IMPERSONATION_BLOCK = SessionKeys.Impersonation.name;

export type ImpersonationStart = { readonly ok: true; readonly session: SessionHandle } | { readonly ok: false };

export interface ImpersonationConfig {
  readonly requirePassword: boolean;
  readonly requireMfa: boolean;
  readonly maxMinutes: number;
  readonly clockSkewSeconds: number;
}

type About = { readonly identity?: IdentityRef; readonly actor?: PrincipalRef; readonly session?: string };

type EventBody = Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>;

type Denial = { readonly reason: string; readonly data?: Readonly<Record<string, unknown>> };

type Ending = { readonly type: AuthnEventType; readonly reason: string };

type Block = { readonly startedAt: Date; readonly actorCeiling?: Ceiling };

type Live = { readonly block: Block } | { readonly ending: Ending };

const refOf = (r: PrincipalRef): IdentityRef => ({ type: r.type, id: r.id });

const sameRef = (a: PrincipalRef, b: PrincipalRef): boolean => a.type === b.type && a.id === b.id;

const validDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

// The schema is the gate; the checks below hold for values set at runtime that never went through it: a switch is off
// only when false, and a limit that is not a finite positive number ends the session instead of never ending it.
const positive = (v: unknown): v is number => Number.isFinite(v) && (v as number) > 0;

/** Strategies vouch for these through their own record checks; every other type is asked (D4b). */
const VOUCHED_TYPES: ReadonlySet<string> = new Set(['service', 'agent']);

function refusal(st: IdentityStatus): string | null {
  if (!st.exists) return 'unknown_identity';
  if (st.deleted) return 'deleted';
  if (st.banned) return 'banned';
  if (!st.active) return 'inactive';
  return null;
}

/** The facts of the impersonator's own session, rebuilt from those of an impersonation session. */
function ownFacts(f: AuthnFacts): AuthnFacts {
  return { method: f.method, strategy: f.strategy, assurance: f.assurance, mfa: [...f.mfa], authenticatedAt: f.authenticatedAt };
}

/** The actor's facts for the guard: its own, through the session it acts through now. */
function actingFacts(f: AuthnFacts): AuthnFacts {
  return { ...ownFacts(f), ...(isNonEmptyString(f.sessionHandle) ? { sessionHandle: f.sessionHandle } : {}) };
}

/**
 * Impersonation (design §22.14, A20, SR-06): start and stop issue a new session and revoke the old one. Only the call
 * whose revoke ended the old session keeps its new one, so parallel starts or stops on one session, in any process, let
 * one through. An ended impersonation answers null, never the impersonator, because a request cannot rotate the cookie.
 * One per container (D11).
 */
@PerChildInstance()
export class AuthnImpersonationService extends AsyncService {
  @Config('authn.impersonation')
  protected Settings: ImpersonationConfig;

  @Config('authn.session.expiration.maxLifetime')
  protected MaxLifetimeMinutes: number;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer, { check: true })
  protected Sessions: SessionIssuer;

  @Autoinject(IdentityStore, { check: true })
  protected Identities: IdentityStore;

  @Autoinject(PrincipalFactory, { check: true })
  protected Principals: PrincipalFactory;

  @Autoinject(ImpersonationGuard, { optional: true })
  protected Guard: ImpersonationGuard | undefined;

  @Autoinject(FreshAuthCheck)
  protected Fresh: FreshAuthCheck;

  @Autoinject(AuthnAudit)
  protected Auditor: AuthnAudit;

  /** What a request with this session resolves to; null when it yields no principal. */
  public async principalOf(session: SessionHandle, ctx: AuthnContext): Promise<Principal | null> {
    const stored = await this.restore(session);
    if (!stored) return null;
    const impersonator = stored.facts.impersonator;
    if (!impersonator) {
      // The session stop hands back is a new row whose store lifetime starts again; the login bounds it.
      if (this.beyondLifetime(stored.facts, ctx)) {
        await this.Sessions.revoke(stored.handle);
        await this.audit(ctx, { type: 'session.expire', outcome: 'success', reason: 'session_lifetime', identity: refOf(stored.identity), ...this.handleOf(stored) });
        return null;
      }
      if (await this.statusRefusal(stored.identity)) return null;
      return this.Principals.principalOf(stored.identity, stored.facts, {});
    }
    const live = this.live(stored, ctx);
    if ('ending' in live) return this.end(ctx, stored, live.ending.type, live.ending.reason);
    const actorRefused = await this.statusRefusal(refOf(impersonator));
    if (actorRefused) return this.end(ctx, stored, 'impersonation.end', `impersonator_${actorRefused}`);
    const targetRefused = await this.statusRefusal(stored.identity);
    if (targetRefused) return this.end(ctx, stored, 'impersonation.end', `target_${targetRefused}`);
    const denied = await this.denial(refOf(impersonator), actingFacts(stored.facts), stored.identity, live.block.actorCeiling);
    if (denied) return this.end(ctx, stored, 'impersonation.end', denied.reason, denied.data);
    return this.Principals.principalOf(stored.identity, stored.facts, {});
  }

  /**
   * Ends every session of `impersonator`, those in which it impersonates someone included, except `except`. For the
   * code that bans or deactivates an identity or changes or resets its password (SR-06); it audits nothing itself.
   */
  public endFor(impersonator: IdentityRef, opts: { except?: SessionHandle } = {}): Promise<number> {
    return this.Sessions.revokeAll(impersonator, { includeImpersonations: true, ...(opts.except ? { except: opts.except } : {}) });
  }

  /** `reauth` is verified only when `requirePassword` is on and the session is not fresh. */
  public async start(session: SessionHandle, target: IdentityRef, ctx: AuthnContext, reauth?: Credentials): Promise<ImpersonationStart> {
    let about: About = {};
    let issued: SessionHandle | undefined;
    try {
      const stored = await this.restore(session);
      if (!stored) return await this.refuseStart(ctx, 'not_active', about);
      const actor = refOf(stored.identity);
      about = { actor, ...(isRef(target) ? { identity: refOf(target) } : {}), ...this.handleOf(stored) };
      const actorCeiling = activeRoleCeiling(stored);
      const refused = await this.startRefusal(stored, target, ctx, actorCeiling, reauth);
      if (refused) return await this.refuseStart(ctx, refused.reason, about, refused.data);

      issued = await this.Sessions.issue(refOf(target), { ...ownFacts(stored.facts), impersonator: actor });
      await this.Sessions.set(issued, IMPERSONATION_BLOCK, { startedAt: ctx.now.toISOString(), ...(actorCeiling ? { actorRoles: [...(actorCeiling.roles ?? [])] } : {}) });
      const now = await this.Sessions.restore(issued.id);
      // A parallel start, or an endFor of the actor, ended the old session first.
      if (!(await this.Sessions.revoke(stored.handle))) {
        await this.Sessions.revoke(issued);
        return await this.refuseStart(ctx, 'revoked', about);
      }
      await this.audit(ctx, { type: 'impersonation.start', outcome: 'success', identity: refOf(target), actor, ...(now ? this.handleOf(now) : {}) });
      return { ok: true, session: issued };
    } catch (err) {
      if (issued) await this.Sessions.revoke(issued).catch(() => undefined);
      return this.refuseStart(ctx, issued ? 'session_error' : 'store_error', about, { error: errorClass(err) });
    }
  }

  /** The impersonator's new session, or null when this is no live impersonation or the impersonator may not log in. */
  public async stop(session: SessionHandle, ctx: AuthnContext): Promise<SessionHandle | null> {
    let about: About = {};
    let issued: SessionHandle | undefined;
    try {
      const stored = await this.restore(session);
      if (!stored) return await this.refuseStop(ctx, 'not_active', about);
      const impersonator = stored.facts.impersonator;
      about = { identity: refOf(stored.identity), ...(impersonator ? { actor: refOf(impersonator) } : {}), ...this.handleOf(stored) };
      if (!impersonator) return await this.refuseStop(ctx, 'not_impersonating', about);
      const live = this.live(stored, ctx);
      if ('ending' in live) return await this.end(ctx, stored, live.ending.type, live.ending.reason);
      const refused = await this.statusRefusal(refOf(impersonator));
      if (refused) return await this.end(ctx, stored, 'impersonation.end', `impersonator_${refused}`);

      issued = await this.Sessions.issue(refOf(impersonator), ownFacts(stored.facts));
      const { actorCeiling } = live.block;
      // No role is stored as '', which activeRoleCeiling narrows to no role as it did the actor's malformed value.
      if (actorCeiling) await this.Sessions.set(issued, ACTIVE_ROLE_KEY, actorCeiling.roles?.[0] ?? '');
      const now = await this.Sessions.restore(issued.id);
      if (!(await this.Sessions.revoke(stored.handle))) {
        await this.Sessions.revoke(issued);
        return await this.refuseStop(ctx, 'revoked', about);
      }
      await this.audit(ctx, { type: 'impersonation.end', outcome: 'success', identity: refOf(stored.identity), actor: refOf(impersonator), ...(now ? this.handleOf(now) : {}) });
      return issued;
    } catch (err) {
      if (issued) await this.Sessions.revoke(issued).catch(() => undefined);
      return this.refuseStop(ctx, issued ? 'session_error' : 'store_error', about, { error: errorClass(err) });
    }
  }

  private async startRefusal(stored: Session, target: IdentityRef, ctx: AuthnContext, actorCeiling: Ceiling | undefined, reauth?: Credentials): Promise<Denial | null> {
    if (!this.Guard) return { reason: 'no_guard' };
    if (stored.facts.impersonator !== undefined) return { reason: 'nested' };
    if (this.beyondLifetime(stored.facts, ctx)) return { reason: 'session_lifetime' };
    if (!isRef(target)) return { reason: 'invalid_target' };
    if (sameRef(stored.identity, target)) return { reason: 'self' };
    // Sessions are for users only (D12).
    if (target.type !== 'user') return { reason: 'non_user_target' };
    if (this.Settings.requireMfa !== false && stored.facts.assurance !== 'aal2') return { reason: 'mfa_required' };
    const actorRefused = await this.statusRefusal(stored.identity);
    if (actorRefused) return { reason: actorRefused };
    if (this.Settings.requirePassword !== false && !(await this.Fresh.check(stored.handle, { ...ctx, session: stored.handle, purpose: 'reauth' }, reauth))) {
      return { reason: 'not_fresh' };
    }
    const targetRefused = await this.statusRefusal(target);
    if (targetRefused) return { reason: `target_${targetRefused}` };
    return this.denial(stored.identity, actingFacts(stored.facts), target, actorCeiling);
  }

  private async restore(h: SessionHandle): Promise<Session | null> {
    const [ok, id] = _try_check_arg(_is_object(), (s: SessionHandle) => s.id, _is_string(_non_empty()))(h, 'session');
    if (!ok) return null;
    const stored = await this.Sessions.restore(id);
    if (!stored) return null;
    const session = resolveSession(this.Container, stored);
    return session.handle.state === 'active' ? session : null;
  }

  /** The block of a live impersonation, or why the impersonation is over whatever the stores say. */
  private live(stored: Session, ctx: AuthnContext): Live {
    const block = this.block(stored, ctx);
    if (block === null) return { ending: { type: 'impersonation.end', reason: 'invalid_block' } };
    const max = this.Settings.maxMinutes;
    if (!positive(max) || ctx.now.getTime() - block.startedAt.getTime() >= TimeSpan.fromMinutes(max).totalMilliseconds) return { ending: { type: 'impersonation.expire', reason: 'max_minutes' } };
    if (this.beyondLifetime(stored.facts, ctx)) return { ending: { type: 'impersonation.end', reason: 'session_lifetime' } };
    return { block };
  }

  /**
   * The block; without one (a migrated 2.x session) the authentication time as the start, which never comes after it,
   * and no actor ceiling. A block whose start or actor ceiling cannot be read, or whose start lies ahead or before the
   * authentication by more than the clock skew allowed between instances, is null: nothing honest writes one. A clock
   * skew set past the schema that is not a finite number >= 0 gives null too.
   */
  private block(stored: Session, ctx: AuthnContext): Block | null {
    const authenticated = stored.facts.authenticatedAt;
    if (!validDate(authenticated)) return null;
    const block = stored.impersonation;
    if (block === undefined) return { startedAt: authenticated };
    if (block === null) return null;
    const t = block.startedAt.getTime();
    const skew: unknown = this.Settings.clockSkewSeconds;
    if (!Number.isFinite(skew) || (skew as number) < 0) return null;
    const skewMs = (skew as number) * 1000;
    if (t > ctx.now.getTime() + skewMs || t < authenticated.getTime() - skewMs) return null;
    return { startedAt: block.startedAt, ...(block.actorRoles ? { actorCeiling: { roles: [...block.actorRoles] } } : {}) };
  }

  /** Start and stop issue new sessions, so the store's absolute lifetime would start again without this bound (I1). */
  private beyondLifetime(facts: AuthnFacts, ctx: AuthnContext): boolean {
    const at = facts.authenticatedAt;
    const max = this.MaxLifetimeMinutes;
    return !validDate(at) || !positive(max) || ctx.now.getTime() - at.getTime() >= TimeSpan.fromMinutes(max).totalMilliseconds;
  }

  /** Why the guard, or its absence, refuses `actor`, narrowed by its role switch, impersonating `target` now; null when it consents. */
  private async denial(actor: IdentityRef, facts: AuthnFacts, target: IdentityRef, ceiling: Ceiling | undefined): Promise<Denial | null> {
    if (!this.Guard) return { reason: 'no_guard' };
    try {
      const principal = await this.Principals.principalOf(actor, facts, ceiling ? { ceiling } : {});
      const answer: unknown = await this.Guard.allowed(principal, target);
      if (isPlainObject(answer) && answer.ok === true) return null;
      return { reason: isPlainObject(answer) && isNonEmptyString(answer.code) ? answer.code : 'forbidden' };
    } catch (err) {
      return { reason: 'guard_error', data: { error: errorClass(err) } };
    }
  }

  private async end(ctx: AuthnContext, stored: Session, type: AuthnEventType, reason: string, data?: Readonly<Record<string, unknown>>): Promise<null> {
    await this.Sessions.revoke(stored.handle);
    const impersonator = stored.facts.impersonator;
    await this.audit(ctx, { type, outcome: 'success', reason, identity: refOf(stored.identity), ...(impersonator ? { actor: refOf(impersonator) } : {}), ...this.handleOf(stored), ...(data ? { data } : {}) });
    return null;
  }

  private async statusRefusal(subject: IdentityRef): Promise<string | null> {
    return VOUCHED_TYPES.has(subject.type) ? null : refusal(await this.Identities.status(subject));
  }

  private handleOf(stored: Session): { session?: string } {
    return isNonEmptyString(stored.facts.sessionHandle) ? { session: stored.facts.sessionHandle } : {};
  }

  private async refuseStart(ctx: AuthnContext, reason: string, about: About, data?: Readonly<Record<string, unknown>>): Promise<{ ok: false }> {
    await this.audit(ctx, { type: 'impersonation.start', outcome: 'failure', reason, ...about, ...(data ? { data } : {}) });
    return { ok: false };
  }

  private async refuseStop(ctx: AuthnContext, reason: string, about: About, data?: Readonly<Record<string, unknown>>): Promise<null> {
    await this.audit(ctx, { type: 'impersonation.end', outcome: 'failure', reason, ...about, ...(data ? { data } : {}) });
    return null;
  }

  private audit(ctx: AuthnContext, e: EventBody): Promise<void> {
    return this.Auditor.publish({ ...e, at: ctx.now, ...(isNonEmptyString(ctx.ip) ? { ip: ctx.ip } : {}), ...(isNonEmptyString(ctx.userAgent) ? { userAgent: ctx.userAgent } : {}) });
  }
}
