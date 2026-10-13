import { createHash } from 'node:crypto';
import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { TimeSpan, isNonEmptyString, isPlainObject } from '@spinajs/util';

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
import { ACTIVE_ROLE_KEY, activeRoleCeiling } from './active-role.js';

/**
 * The session data key of the impersonation block: `{ startedAt, actorRoles? }`, the start as an ISO string and the
 * `ceiling.roles` of the actor's role switch at start. Not under ActiveRole, which would narrow the target.
 */
export const IMPERSONATION_BLOCK = 'Impersonation';

export type ImpersonationStart = { readonly ok: true; readonly session: SessionHandle } | { readonly ok: false };

export interface ImpersonationConfig {
  readonly requirePassword: boolean;
  readonly requireMfa: boolean;
  readonly maxMinutes: number;
  readonly clockSkewSeconds: number;
}

type Stored = NonNullable<Awaited<ReturnType<SessionIssuer['restore']>>>;

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

/** The block's actor ceiling: absent is none, null cannot be read. A role switch writes at most one role. */
function blockCeiling(block: Record<string, unknown>): Ceiling | undefined | null {
  if (!('actorRoles' in block)) return undefined;
  const roles: unknown = block.actorRoles;
  return Array.isArray(roles) && roles.length <= 1 && roles.every(isNonEmptyString) ? { roles: [...roles] } : null;
}

// Per process, across containers: two parallel starts (or stops) on one session must not both pass the checks.
const switching = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(session: SessionHandle, run: () => Promise<T>): Promise<T> {
  if (!isPlainObject(session) || !isNonEmptyString(session.id)) return run();
  const key = createHash('sha256').update(session.id).digest('hex');
  const mine = (switching.get(key) ?? Promise.resolve()).then(run, run);
  const tail = mine.catch(() => undefined);
  switching.set(key, tail);
  try {
    return await mine;
  } finally {
    if (switching.get(key) === tail) switching.delete(key);
  }
}

/**
 * Impersonation (design §22.14, A20, SR-06): start and stop issue a new session and revoke the old one. An ended
 * impersonation answers null, never the impersonator, because a request cannot rotate the cookie. One per container (D11).
 */
@PerChildInstance()
@Inject(Container)
export class AuthnImpersonationService extends AsyncService {
  @Config('authn.impersonation')
  protected Settings: ImpersonationConfig;

  @Config('authn.session.expiration.maxLifetime')
  protected MaxLifetimeMinutes: number;

  private sessions!: SessionIssuer;
  private identities!: IdentityStore;
  private principals!: PrincipalFactory;
  private guard: ImpersonationGuard | undefined;
  private fresh!: FreshAuthCheck;
  private auditor!: AuthnAudit;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    this.sessions = await this.container.resolve(SessionIssuer, true);
    this.identities = await this.container.resolve(IdentityStore, true);
    this.principals = await this.container.resolve(PrincipalFactory, true);
    this.guard = await this.container.resolveOptional(ImpersonationGuard);
    this.fresh = await this.container.resolve(FreshAuthCheck);
    this.auditor = await this.container.resolve(AuthnAudit);
    await super.resolve();
  }

  /** `reauth` is verified only when `requirePassword` is on and the session is not fresh. */
  public start(session: SessionHandle, target: IdentityRef, ctx: AuthnContext, reauth?: Credentials): Promise<ImpersonationStart> {
    return oneAtATime(session, () => this.startNow(session, target, ctx, reauth));
  }

  /** The impersonator's new session, or null when this is no live impersonation or the impersonator may not log in. */
  public stop(session: SessionHandle, ctx: AuthnContext): Promise<SessionHandle | null> {
    return oneAtATime(session, () => this.stopNow(session, ctx));
  }

  /** What a request with this session resolves to; null when it yields no principal. */
  public async principalOf(session: SessionHandle, ctx: AuthnContext): Promise<Principal | null> {
    const stored = await this.restore(session);
    if (!stored) return null;
    const impersonator = stored.facts.impersonator;
    if (!impersonator) {
      // The session stop hands back is a new row whose store lifetime starts again; the login bounds it.
      if (this.beyondLifetime(stored.facts, ctx)) {
        await this.sessions.revoke(stored.handle);
        await this.audit(ctx, { type: 'session.expire', outcome: 'success', reason: 'session_lifetime', identity: refOf(stored.identity), ...this.handleOf(stored) });
        return null;
      }
      if (await this.statusRefusal(stored.identity)) return null;
      return this.principals.principalOf(stored.identity, stored.facts, {});
    }
    const live = this.live(stored, ctx);
    if ('ending' in live) return this.end(ctx, stored, live.ending.type, live.ending.reason);
    const actorRefused = await this.statusRefusal(refOf(impersonator));
    if (actorRefused) return this.end(ctx, stored, 'impersonation.end', `impersonator_${actorRefused}`);
    const targetRefused = await this.statusRefusal(stored.identity);
    if (targetRefused) return this.end(ctx, stored, 'impersonation.end', `target_${targetRefused}`);
    const denied = await this.denial(refOf(impersonator), actingFacts(stored.facts), stored.identity, live.block.actorCeiling);
    if (denied) return this.end(ctx, stored, 'impersonation.end', denied.reason, denied.data);
    return this.principals.principalOf(stored.identity, stored.facts, {});
  }

  /**
   * Ends every session of `impersonator`, those in which it impersonates someone included, except `except`. For the
   * code that bans or deactivates an identity or changes or resets its password (SR-06); it audits nothing itself.
   */
  public endFor(impersonator: IdentityRef, opts: { except?: SessionHandle } = {}): Promise<number> {
    return this.sessions.revokeAll(impersonator, { includeImpersonations: true, ...(opts.except ? { except: opts.except } : {}) });
  }

  private async startNow(session: SessionHandle, target: IdentityRef, ctx: AuthnContext, reauth?: Credentials): Promise<ImpersonationStart> {
    let about: About = {};
    let issued: SessionHandle | undefined;
    try {
      const stored = await this.restore(session);
      if (!stored) return await this.refuseStart(ctx, 'not_active', about);
      const actor = refOf(stored.identity);
      about = { actor, ...(isRef(target) ? { identity: refOf(target) } : {}), ...this.handleOf(stored) };
      const actorCeiling = activeRoleCeiling(stored.data);
      const refused = await this.startRefusal(stored, target, ctx, actorCeiling, reauth);
      if (refused) return await this.refuseStart(ctx, refused.reason, about, refused.data);

      issued = await this.sessions.issue(refOf(target), { ...ownFacts(stored.facts), impersonator: actor });
      await this.sessions.set(issued, IMPERSONATION_BLOCK, { startedAt: ctx.now.toISOString(), ...(actorCeiling ? { actorRoles: [...(actorCeiling.roles ?? [])] } : {}) });
      const now = await this.sessions.restore(issued.id);
      // An endFor of the actor that ran since the first restore swept the old session but not the new one.
      if (!(await this.sessions.restore(stored.handle.id))) {
        await this.sessions.revoke(issued);
        return await this.refuseStart(ctx, 'revoked', about);
      }
      await this.sessions.revoke(stored.handle);
      await this.audit(ctx, { type: 'impersonation.start', outcome: 'success', identity: refOf(target), actor, ...(now ? this.handleOf(now) : {}) });
      return { ok: true, session: issued };
    } catch (err) {
      if (issued) await this.sessions.revoke(issued).catch(() => undefined);
      return this.refuseStart(ctx, issued ? 'session_error' : 'store_error', about, { error: errorClass(err) });
    }
  }

  private async stopNow(session: SessionHandle, ctx: AuthnContext): Promise<SessionHandle | null> {
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

      issued = await this.sessions.issue(refOf(impersonator), ownFacts(stored.facts));
      const { actorCeiling } = live.block;
      // No role is stored as '', which activeRoleCeiling narrows to no role as it did the actor's malformed value.
      if (actorCeiling) await this.sessions.set(issued, ACTIVE_ROLE_KEY, actorCeiling.roles?.[0] ?? '');
      const now = await this.sessions.restore(issued.id);
      if (!(await this.sessions.restore(stored.handle.id))) {
        await this.sessions.revoke(issued);
        return await this.refuseStop(ctx, 'revoked', about);
      }
      await this.sessions.revoke(stored.handle);
      await this.audit(ctx, { type: 'impersonation.end', outcome: 'success', identity: refOf(stored.identity), actor: refOf(impersonator), ...(now ? this.handleOf(now) : {}) });
      return issued;
    } catch (err) {
      if (issued) await this.sessions.revoke(issued).catch(() => undefined);
      return this.refuseStop(ctx, issued ? 'session_error' : 'store_error', about, { error: errorClass(err) });
    }
  }

  private async startRefusal(stored: Stored, target: IdentityRef, ctx: AuthnContext, actorCeiling: Ceiling | undefined, reauth?: Credentials): Promise<Denial | null> {
    if (!this.guard) return { reason: 'no_guard' };
    if (stored.facts.impersonator !== undefined) return { reason: 'nested' };
    if (this.beyondLifetime(stored.facts, ctx)) return { reason: 'session_lifetime' };
    if (!isRef(target)) return { reason: 'invalid_target' };
    if (sameRef(stored.identity, target)) return { reason: 'self' };
    // Sessions are for users only (D12).
    if (target.type !== 'user') return { reason: 'non_user_target' };
    if (this.Settings.requireMfa !== false && stored.facts.assurance !== 'aal2') return { reason: 'mfa_required' };
    const actorRefused = await this.statusRefusal(stored.identity);
    if (actorRefused) return { reason: actorRefused };
    if (this.Settings.requirePassword !== false && !(await this.fresh.check(stored.handle, { ...ctx, session: stored.handle, purpose: 'reauth' }, reauth))) {
      return { reason: 'not_fresh' };
    }
    const targetRefused = await this.statusRefusal(target);
    if (targetRefused) return { reason: `target_${targetRefused}` };
    return this.denial(stored.identity, actingFacts(stored.facts), target, actorCeiling);
  }

  private async restore(h: SessionHandle): Promise<Stored | null> {
    if (!isPlainObject(h) || !isNonEmptyString(h.id)) return null;
    const stored = await this.sessions.restore(h.id);
    return stored && stored.handle.state === 'active' ? stored : null;
  }

  /** The block of a live impersonation, or why the impersonation is over whatever the stores say. */
  private live(stored: Stored, ctx: AuthnContext): Live {
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
  private block(stored: Stored, ctx: AuthnContext): Block | null {
    const authenticated = stored.facts.authenticatedAt;
    if (!validDate(authenticated)) return null;
    if (!stored.data.has(IMPERSONATION_BLOCK)) return { startedAt: authenticated };
    const block = stored.data.get(IMPERSONATION_BLOCK);
    if (!isPlainObject(block)) return null;
    const raw = block.startedAt;
    const started = typeof raw === 'string' ? new Date(raw) : raw;
    if (!validDate(started)) return null;
    const t = started.getTime();
    const skew: unknown = this.Settings.clockSkewSeconds;
    if (!Number.isFinite(skew) || (skew as number) < 0) return null;
    const skewMs = (skew as number) * 1000;
    if (t > ctx.now.getTime() + skewMs || t < authenticated.getTime() - skewMs) return null;
    const actorCeiling = blockCeiling(block);
    if (actorCeiling === null) return null;
    return { startedAt: started, ...(actorCeiling ? { actorCeiling } : {}) };
  }

  /** Start and stop issue new sessions, so the store's absolute lifetime would start again without this bound (I1). */
  private beyondLifetime(facts: AuthnFacts, ctx: AuthnContext): boolean {
    const at = facts.authenticatedAt;
    const max = this.MaxLifetimeMinutes;
    return !validDate(at) || !positive(max) || ctx.now.getTime() - at.getTime() >= TimeSpan.fromMinutes(max).totalMilliseconds;
  }

  /** Why the guard, or its absence, refuses `actor`, narrowed by its role switch, impersonating `target` now; null when it consents. */
  private async denial(actor: IdentityRef, facts: AuthnFacts, target: IdentityRef, ceiling: Ceiling | undefined): Promise<Denial | null> {
    if (!this.guard) return { reason: 'no_guard' };
    try {
      const principal = await this.principals.principalOf(actor, facts, ceiling ? { ceiling } : {});
      const answer: unknown = await this.guard.allowed(principal, target);
      if (isPlainObject(answer) && answer.ok === true) return null;
      return { reason: isPlainObject(answer) && isNonEmptyString(answer.code) ? answer.code : 'forbidden' };
    } catch (err) {
      return { reason: 'guard_error', data: { error: errorClass(err) } };
    }
  }

  private async end(ctx: AuthnContext, stored: Stored, type: AuthnEventType, reason: string, data?: Readonly<Record<string, unknown>>): Promise<null> {
    await this.sessions.revoke(stored.handle);
    const impersonator = stored.facts.impersonator;
    await this.audit(ctx, { type, outcome: 'success', reason, identity: refOf(stored.identity), ...(impersonator ? { actor: refOf(impersonator) } : {}), ...this.handleOf(stored), ...(data ? { data } : {}) });
    return null;
  }

  private async statusRefusal(subject: IdentityRef): Promise<string | null> {
    return VOUCHED_TYPES.has(subject.type) ? null : refusal(await this.identities.status(subject));
  }

  private handleOf(stored: Stored): { session?: string } {
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
    return this.auditor.publish({ ...e, at: ctx.now, ...(isNonEmptyString(ctx.ip) ? { ip: ctx.ip } : {}), ...(isNonEmptyString(ctx.userAgent) ? { userAgent: ctx.userAgent } : {}) });
  }
}
