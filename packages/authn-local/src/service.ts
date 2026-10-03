import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { AuthnEventSink, AuthnThrottle, IdentityStore, PasswordCredentialStore, PasswordService, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type {
  AuthnContext,
  AuthnEvent,
  IdentityRef,
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
import { PasswordHasher } from './hasher.js';
import { isLoginLength, LocalPasswordPolicy } from './policy.js';

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
  readonly log?: AuditLog;
  /** `authn.local.reset.revokeTokens`; default true. */
  readonly revokeTokens?: boolean;
}

const sameRef = (a: IdentityRef, b: IdentityRef) => a.type === b.type && a.id === b.id;

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

  @Logger('authn-local')
  protected Log: Log;

  constructor(protected readonly Deps?: LocalPasswordServiceDeps) {
    super();
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

  public async requestReset(_login: string, _ctx: AuthnContext): Promise<PasswordResetRequestResult> {
    throw new MethodNotImplemented('LocalPasswordService.requestReset is not implemented yet');
  }

  public async redeemReset(_login: string, _secret: string, _newPassword: string, _ctx: AuthnContext): Promise<PasswordResetResult> {
    throw new MethodNotImplemented('LocalPasswordService.redeemReset is not implemented yet');
  }

  public async invite(_id: IdentityRef, _ctx: AuthnContext, _opts?: { readonly actor?: PrincipalRef }): Promise<void> {
    throw new MethodNotImplemented('LocalPasswordService.invite is not implemented yet');
  }

  public async expire(_id: IdentityRef, _opts: PasswordExpiry, _ctx: AuthnContext): Promise<void> {
    throw new MethodNotImplemented('LocalPasswordService.expire is not implemented yet');
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
