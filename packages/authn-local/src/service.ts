import { randomUUID } from 'node:crypto';
import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { AuthnEventSink, AuthnThrottle, IdentityStore, PasswordCredentialStore, PasswordService, SecretStore, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type {
  AuthnContext,
  AuthnEvent,
  IdentityRef,
  IdentityStatus,
  PasswordChangeResult,
  PasswordExpiry,
  PasswordPolicy,
  PasswordResetRequestResult,
  PasswordResetResult,
  PasswordSetResult,
  PasswordViolation,
  PrincipalRef,
  SessionHandle,
  ThrottleKey,
} from '@spinajs/authn/contracts';

import { AuditLog, publishAuthnEvent } from './audit.js';
import { DeferredWork } from './deferred.js';
import { EXPIRED_PASSWORD_MARKER, PasswordHasher } from './hasher.js';
import { PasswordMailer } from './mailer.js';
import { isLoginLength, LocalPasswordPolicy } from './policy.js';
import { normalizeLogin } from './strategy.js';

const INVALID = { status: 'invalid' } as const;

export interface LocalPasswordServiceDeps {
  readonly identities: IdentityStore;
  readonly passwords: PasswordCredentialStore;
  readonly sessions: SessionIssuer;
  readonly throttle: AuthnThrottle;
  /** null: no TokenService, so there are no tokens to revoke. */
  readonly tokens: TokenService | null;
  readonly sinks: readonly AuthnEventSink[];
  readonly hasher: PasswordHasher;
  readonly policy: LocalPasswordPolicy;
  /** Required by the reset and invite flows. */
  readonly secrets?: SecretStore;
  /** null or missing: no mailer, so reset and invite mails are not sent. */
  readonly mailer?: PasswordMailer | null;
  readonly log?: AuditLog;
  /** `authn.local.reset.revokeTokens`; default true. */
  readonly revokeTokens?: boolean;
  /** `authn.local.reset.ttlSeconds`; default 3600. */
  readonly resetTtlSeconds?: number;
  /** `authn.local.reset.url`; default ''. */
  readonly resetUrl?: string;
  /** `authn.local.invite.ttlSeconds`; default 900. */
  readonly inviteTtlSeconds?: number;
}

const sameRef = (a: IdentityRef, b: IdentityRef) => a.type === b.type && a.id === b.id;

/** D11, D12: exists, not deleted, not banned, and active or invite-pending. */
const eligible = (s: IdentityStatus) => s.exists && !s.deleted && !s.banned && (s.active || s.invitePending === true);

/** For work that must match a real identity's: a fresh ref no store or cache can know. */
const throwaway = (): IdentityRef => ({ type: 'user', id: randomUUID() });

/**
 * The reset flow's ip key. Callers without `ctx.ip` share one bucket rather than going unthrottled, so one caller's requests can
 * throttle every other caller that also omits it: HTTP callers must pass the trusted-proxy ip.
 */
const resetIpKey = (ctx: AuthnContext): ThrottleKey => ({ kind: 'ip', value: ctx.ip ?? 'unknown' });

/** Same keys as the kit's reauthenticate (D7). */
function reauthKeys(id: IdentityRef, ctx: AuthnContext): ThrottleKey[] {
  return [{ kind: 'account', value: id.id }, { kind: 'account-ip', value: `${id.id}|${ctx.ip ?? ''}` }, ...(ctx.ip ? [{ kind: 'ip', value: ctx.ip }] : [])];
}

/**
 * Local password flows (A04, A13, A30). Collaborators come from the container on use (D8), so the service can be resolved
 * before them; with `deps` the container is not used at all.
 */
@Injectable(PasswordService)
export class LocalPasswordService extends PasswordService {
  @Config('authn.local.reset.revokeTokens', { defaultValue: true })
  protected RevokeTokens: boolean;

  // Code defaults: @spinajs/users still ships these keys with its 2.x values.
  @Config('authn.local.reset.ttlSeconds', { defaultValue: 3600 })
  protected ResetTtlSeconds: number;

  @Config('authn.local.reset.url', { defaultValue: '' })
  protected ResetUrl: string;

  @Config('authn.local.invite.ttlSeconds', { defaultValue: 900 })
  protected InviteTtlSeconds: number;

  @Logger('authn-local')
  protected Log: Log;

  private _work?: DeferredWork;

  constructor(protected readonly Deps?: LocalPasswordServiceDeps) {
    super();
  }

  /** Resolves once every deferred reset job scheduled so far has finished (tests, shutdown). */
  public drain(): Promise<void> {
    return this.work().drain();
  }

  /** D9. Keeps every API and agent token (H32). */
  public async change(id: IdentityRef, oldPassword: string, newPassword: string, session: SessionHandle, ctx: AuthnContext): Promise<PasswordChangeResult> {
    const violations = await this.policyComponent().check(newPassword);
    if (violations.length > 0) {
      await this.audit(ctx, { type: 'password.change', outcome: 'failure', identity: id, reason: 'policy' });
      return { status: 'rejected', violations };
    }

    const sessions = this.sessions();
    const restored = await sessions.restore(session.id);
    if (!restored || restored.handle.state !== 'active' || !sameRef(restored.identity, id)) {
      await this.audit(ctx, { type: 'password.change', outcome: 'failure', identity: id, reason: 'session' });
      return INVALID;
    }
    const handle = restored.facts.sessionHandle;

    // An impersonator never changes the target's credentials, even knowing the old password; refused before the throttle so it
    // cannot back off the target's own reauth key.
    const impersonator = restored.facts.impersonator;
    if (impersonator !== undefined) {
      await this.audit(ctx, { type: 'password.change', outcome: 'failure', identity: id, actor: impersonator, reason: 'impersonation', session: handle });
      return INVALID;
    }

    const throttle = this.throttle();
    const keys = reauthKeys(id, ctx);
    const gate = await throttle.attempt(keys, 'reauth', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'password.change', outcome: 'failure', identity: id, reason: 'throttled', session: handle });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }

    if (!(await this.verifyPassword(id, oldPassword))) {
      await this.audit(ctx, { type: 'password.change', outcome: 'failure', identity: id, reason: 'wrong_password', session: handle });
      return INVALID;
    }
    await throttle.succeed(keys, 'reauth');

    await this.storePassword(id, newPassword);
    await sessions.revokeAll(id, { except: session, includeImpersonations: true });
    const rotated = await sessions.rotate(session);

    await this.audit(ctx, { type: 'password.change', outcome: 'success', identity: id, session: handle });
    return { status: 'changed', session: rotated };
  }

  /** D14. Not a voluntary change: every session and, with reset.revokeTokens, every token goes. */
  public async set(id: IdentityRef, newPassword: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<PasswordSetResult> {
    const violations = await this.policyComponent().check(newPassword);
    if (violations.length > 0) {
      return { status: 'rejected', violations };
    }

    await this.storePassword(id, newPassword);
    await this.sessions().revokeAll(id, { includeImpersonations: true });
    await this.revokeTokensOf(id, ctx, opts?.actor);

    await this.audit(ctx, { type: 'password.change', outcome: 'success', identity: id, ...(opts?.actor ? { actor: opts.actor } : {}), data: { cause: 'set' } });
    return { status: 'set' };
  }

  public check(password: string): Promise<readonly PasswordViolation[]> {
    return this.policyComponent().check(password);
  }

  public policy(): PasswordPolicy {
    return this.policyComponent().policy();
  }

  /**
   * D11. Counts first; then the lookup, issue, mail and audit run as deferred work, so the answer and its timing are the same for
   * known and unknown logins (A11, SR-04).
   */
  public async requestReset(login: string, ctx: AuthnContext): Promise<PasswordResetRequestResult> {
    const keys: ThrottleKey[] = [{ kind: 'account', value: normalizeLogin(login) }, resetIpKey(ctx)];
    const gate = await this.throttle().attempt(keys, 'reset', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', data: { flow: 'reset' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }

    this.work().defer(() => this.sendReset(login, ctx));
    return { status: 'accepted' };
  }

  /** D12. Every refusal answers `invalid`; the reason goes to audit only (SR-17). */
  public async redeemReset(login: string, secret: string, newPassword: string, ctx: AuthnContext): Promise<PasswordResetResult> {
    const gate = await this.throttle().attempt([resetIpKey(ctx)], 'reset', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', data: { flow: 'reset' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }

    const violations = await this.policyComponent().check(newPassword);
    if (violations.length > 0) {
      return { status: 'rejected', violations };
    }

    const identities = this.identities();
    const secrets = this.secrets();
    const id = await identities.findByLogin(login);
    const status = await identities.status(id ?? throwaway());
    const target = id && eligible(status) ? id : null;
    const pending = target !== null && status.invitePending === true;

    // Always two redeems, on throwaway refs where no real one is due: otherwise the time tells a pending invite from a missing
    // login (A02).
    const asReset = await secrets.redeem(target ?? throwaway(), 'reset', secret);
    const asInvite = await secrets.redeem(!asReset && pending ? target : throwaway(), 'invite', secret);

    if (!target) {
      await this.audit(ctx, { type: 'password.reset', outcome: 'failure', ...(id ? { identity: id } : {}), reason: id ? 'status' : 'unknown_login' });
      return INVALID;
    }
    if (!asReset && !asInvite) {
      await this.audit(ctx, { type: 'password.reset', outcome: 'failure', identity: target, reason: 'secret' });
      return INVALID;
    }
    const purpose = asReset ? 'reset' : 'invite';

    await this.storePassword(target, newPassword);
    await this.sessions().revokeAll(target, { includeImpersonations: true });
    await this.revokeTokensOf(target, ctx);

    if (purpose === 'reset') {
      await this.audit(ctx, { type: 'password.reset', outcome: 'success', identity: target });
    }
    // users activates an invited identity on invite.redeem, also when the invite expired and a reset link completed it.
    if (pending) {
      await this.audit(ctx, { type: 'invite.redeem', outcome: 'success', identity: target, ...(purpose === 'reset' ? { data: { via: 'reset' } } : {}) });
    }
    return { status: 'reset', purpose };
  }

  /** D13: an admin action, in the call and not throttled. */
  public async invite(id: IdentityRef, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<void> {
    const sent = await this.mail(id, 'invite', this.inviteTtlSeconds());
    // No event type exists for issuing an invite; it is recorded as a request of purpose invite.
    await this.audit(ctx, {
      type: 'password.reset.request',
      outcome: sent ? 'success' : 'failure',
      identity: id,
      ...(opts?.actor ? { actor: opts.actor } : {}),
      ...(sent ? {} : { reason: 'no_mailer' }),
      data: { purpose: 'invite' },
    });
  }

  /** D15. `admin` revokes tokens under reset.revokeTokens and mails only with `sendReset`; `aged` keeps tokens (H32) and mails. */
  public async expire(id: IdentityRef, opts: PasswordExpiry, ctx: AuthnContext): Promise<void> {
    const sessions = this.sessions();
    // The job skips marked identities, so for `aged` the marker goes after the revoke: a failed revoke leaves the identity
    // unmarked for the next run. An admin sees the error and retries, so there the password dies first.
    if (opts.cause === 'aged') {
      await sessions.revokeAll(id, { includeImpersonations: true });
      await this.passwords().set(id, EXPIRED_PASSWORD_MARKER);
    } else {
      await this.passwords().set(id, EXPIRED_PASSWORD_MARKER);
      await sessions.revokeAll(id, { includeImpersonations: true });
      await this.revokeTokensOf(id, ctx, opts.actor);
    }
    const actor = opts.cause === 'admin' ? opts.actor : undefined;
    // No password.expire event type exists.
    await this.audit(ctx, { type: 'password.change', outcome: 'success', identity: id, ...(actor ? { actor } : {}), data: { cause: opts.cause, expired: true } });

    if (opts.cause === 'aged' || opts.sendReset === true) {
      await this.mailResetAfterExpiry(id);
    }
  }

  /**
   * The expiry already holds, and the owner can still ask for a reset, so a mail failure is logged and not thrown. An identity
   * that could not redeem a reset gets none.
   */
  protected async mailResetAfterExpiry(id: IdentityRef): Promise<void> {
    try {
      if (eligible(await this.identities().status(id))) {
        await this.mail(id, 'reset', this.resetTtlSeconds());
      }
    } catch (err) {
      this.log().warn(`The reset mail after the password expiry of ${id.type} ${id.id} failed: ${(err as Error)?.name ?? typeof err}`);
    }
  }

  protected async sendReset(login: string, ctx: AuthnContext): Promise<void> {
    const identities = this.identities();
    const id = await identities.findByLogin(login);
    if (!id) {
      await this.audit(ctx, { type: 'password.reset.request', outcome: 'failure', reason: 'unknown_login' });
      return;
    }
    if (!eligible(await identities.status(id))) {
      await this.audit(ctx, { type: 'password.reset.request', outcome: 'failure', identity: id, reason: 'status' });
      return;
    }
    const sent = await this.mail(id, 'reset', this.resetTtlSeconds());
    await this.audit(ctx, { type: 'password.reset.request', outcome: sent ? 'success' : 'failure', identity: id, ...(sent ? {} : { reason: 'no_mailer' }) });
  }

  /** Issues the secret right before sending it (D10, SR-09); without a mailer nothing is issued. */
  protected async mail(id: IdentityRef, purpose: 'reset' | 'invite', ttlSeconds: number): Promise<boolean> {
    const mailer = await this.mailer();
    if (!mailer) {
      this.log().warn(`No PasswordMailer is registered: the ${purpose} mail for ${id.type} ${id.id} was not sent`);
      return false;
    }
    const to = await this.identities().display(id);
    const secret = await this.secrets().issue(id, purpose, ttlSeconds);
    await mailer.send({ identity: id, purpose, to, secret, url: this.resetUrl(), ttlSeconds });
    return true;
  }

  /** One argon2 verify on every path, like the login strategy: the fixed login bound, then the stored hash or the dummy. */
  protected async verifyPassword(id: IdentityRef, password: string): Promise<boolean> {
    const hasher = await this.hasher();
    if (!isLoginLength(password)) {
      await hasher.verify(null, '');
      return false;
    }
    return hasher.verify(await this.passwords().get(id), password);
  }

  protected async storePassword(id: IdentityRef, password: string): Promise<void> {
    const hasher = await this.hasher();
    await this.passwords().set(id, await hasher.hash(password));
  }

  protected async revokeTokensOf(id: IdentityRef, ctx: AuthnContext, actor?: PrincipalRef): Promise<void> {
    const enabled = this.Deps ? (this.Deps.revokeTokens ?? true) : this.RevokeTokens;
    const tokens = enabled ? await this.tokens() : null;
    if (tokens) {
      await tokens.revokeAllFor(id, ctx, actor ? { actor } : undefined);
    }
  }

  protected async audit(ctx: AuthnContext, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
    const event: AuthnEvent = {
      ...e,
      at: ctx.now,
      ...(ctx.ip !== undefined ? { ip: ctx.ip } : {}),
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
    };
    await publishAuthnEvent(await this.sinks(), event, this.log());
  }

  protected work(): DeferredWork {
    return (this._work ??= new DeferredWork(this.log()));
  }

  protected resetTtlSeconds(): number {
    return this.Deps ? (this.Deps.resetTtlSeconds ?? 3600) : this.ResetTtlSeconds;
  }

  protected inviteTtlSeconds(): number {
    return this.Deps ? (this.Deps.inviteTtlSeconds ?? 900) : this.InviteTtlSeconds;
  }

  protected resetUrl(): string {
    return this.Deps ? (this.Deps.resetUrl ?? '') : this.ResetUrl;
  }

  protected identities(): IdentityStore {
    return this.Deps ? this.Deps.identities : DI.resolve(IdentityStore);
  }

  protected secrets(): SecretStore {
    if (this.Deps) {
      if (!this.Deps.secrets) {
        throw new InvalidOperation('LocalPasswordService was built without a SecretStore');
      }
      return this.Deps.secrets;
    }
    return DI.resolve(SecretStore);
  }

  protected async mailer(): Promise<PasswordMailer | null> {
    if (this.Deps) {
      return this.Deps.mailer ?? null;
    }
    return DI.check(PasswordMailer) ? await DI.resolve(PasswordMailer) : null;
  }

  protected policyComponent(): LocalPasswordPolicy {
    return this.Deps ? this.Deps.policy : DI.resolve(LocalPasswordPolicy);
  }

  protected sessions(): SessionIssuer {
    return this.Deps ? this.Deps.sessions : DI.resolve(SessionIssuer);
  }

  protected throttle(): AuthnThrottle {
    return this.Deps ? this.Deps.throttle : DI.resolve(AuthnThrottle);
  }

  protected passwords(): PasswordCredentialStore {
    return this.Deps ? this.Deps.passwords : DI.resolve(PasswordCredentialStore);
  }

  protected async hasher(): Promise<PasswordHasher> {
    return this.Deps ? this.Deps.hasher : await DI.resolve(PasswordHasher);
  }

  protected async tokens(): Promise<TokenService | null> {
    if (this.Deps) {
      return this.Deps.tokens;
    }
    return DI.check(TokenService) ? await DI.resolve(TokenService) : null;
  }

  protected async sinks(): Promise<readonly AuthnEventSink[]> {
    if (this.Deps) {
      return this.Deps.sinks;
    }
    return DI.check(AuthnEventSink) ? await Promise.resolve(DI.resolve(Array.ofType(AuthnEventSink))) : [];
  }

  protected log(): AuditLog {
    return this.Deps ? (this.Deps.log ?? { warn: () => undefined }) : this.Log;
  }
}
