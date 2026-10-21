import { randomUUID } from 'node:crypto';
import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import './register-schema.js';
import { AuthnAudit } from '@spinajs/authn/audit';
import type { AuthnAuditor, AuthnEventBody } from '@spinajs/authn/audit';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { AuthnThrottle, IdentityAddressVerifier, IdentityStore, PasswordCredentialStore, PasswordService, SecretStore, SessionIssuer, TokenService, DEFAULT_IPV6_PREFIX, identityThrottleKeys, ipKey, ipv6PrefixOf, sameRef } from '@spinajs/authn/contracts';
import type {
  AddressVerificationRequestResult,
  AddressVerificationResult,
  AuthnContext,
  AuthnEventSink,
  CodeRequestResult,
  IdentityRef,
  IdentityStatus,
  PasswordChangeResult,
  PasswordExpiry,
  PasswordPolicy,
  PasswordPolicyContext,
  PasswordResetRequestResult,
  PasswordResetResult,
  PasswordSetResult,
  PasswordViolation,
  PrincipalRef,
  SessionHandle,
  ThrottleKey,
} from '@spinajs/authn/contracts';

import type { AuditLog } from './audit.js';
import { AUTHN_LOCAL_DEFAULTS } from './defaults.js';
import { DeferredWork } from './deferred.js';
import { EmailCodes } from './email-code/codes.js';
import { EXPIRED_PASSWORD_MARKER, PasswordHasher } from './hasher.js';
import { PasswordMailer } from './mailer.js';
import { AuthnMailDispatcher } from './mail/contracts.js';
import type { AuthnMailPurpose, AuthnMailRequest } from './mail/contracts.js';
import { InlineAuthnMailDispatcher } from './mail/inline.js';
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
  /** Published to through `AuthnAudit.over`. */
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
  /** Missing: an `InlineAuthnMailDispatcher` over `deliver`. */
  readonly dispatcher?: AuthnMailDispatcher;
  /** Required by `redeemVerification`. */
  readonly verifier?: IdentityAddressVerifier | null;
  /** `authn.throttle.ipv6Prefix`; default 64. */
  readonly ipv6Prefix?: number;
  /** `authn.local.verify.ttlSeconds`; default 86400. */
  readonly verifyTtlSeconds?: number;
  /** `authn.local.verify.url`; default ''. */
  readonly verifyUrl?: string;
  /** `authn.local.emailCode.ttlSeconds`; default 600. */
  readonly emailCodeTtlSeconds?: number;
}

/** D11, D12: exists, not deleted, not banned, and active or invite-pending. */
const eligible = (s: IdentityStatus) => s.exists && !s.deleted && !s.banned && (s.active || s.invitePending === true);

/** For work that must match a real identity's: a fresh ref no store or cache can know. */
const throwaway = (): IdentityRef => ({ type: 'user', id: randomUUID() });

/** Its own account key: a verify request must not use up the reset request of the same account. */
const verifyKey = (id: IdentityRef): ThrottleKey => ({ kind: 'account', value: `verify:${id.type}:${id.id}` });

/** Its own account key: a code request must not use up the reset or verify request of the same account. */
const codeKey = (id: IdentityRef): ThrottleKey => ({ kind: 'account', value: `code:${id.type}:${id.id}` });

/** A code goes to an active identity whose address the store does not report unverified: whoever owns the mailbox can use it. */
const codeRefusal = (s: IdentityStatus): string | null => (!s.exists || s.deleted || s.banned || !s.active ? 'status' : s.addressVerified === false ? 'unverified_address' : null);

/**
 * POST /auth/verify takes the secret alone, and a SecretStore redeems per identity, so the mailed secret carries its
 * identity: `base64url(JSON [type, id]).raw`. The identity part is no secret; the raw part is.
 */
function verifySecretOf(id: IdentityRef, raw: string): string {
  return `${Buffer.from(JSON.stringify([id.type, id.id]), 'utf8').toString('base64url')}.${raw}`;
}

function parseVerifySecret(secret: string): { id: IdentityRef; raw: string } | null {
  const parts = typeof secret === 'string' ? secret.split('.') : [];
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return null;
  }
  try {
    const ref: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (Array.isArray(ref) && ref.length === 2 && ref.every((v) => typeof v === 'string' && v !== '')) {
      return { id: { type: ref[0] as string, id: ref[1] as string }, raw: parts[1] };
    }
    return null;
  } catch {
    return null;
  }
}

/** Local password flows (A04, A13, A30). With `deps` the container is not used at all. */
@Injectable(PasswordService)
export class LocalPasswordService extends PasswordService {
  @Config('authn.throttle.ipv6Prefix')
  protected ThrottleIpv6Prefix: unknown;

  @Config('authn.local.reset.revokeTokens')
  protected RevokeTokens: boolean;

  @Config('authn.local.reset.ttlSeconds')
  protected ResetTtlSeconds: number;

  @Config('authn.local.reset.url')
  protected ResetUrl: string;

  @Config('authn.local.invite.ttlSeconds')
  protected InviteTtlSeconds: number;

  @Config('authn.local.verify.ttlSeconds')
  protected VerifyTtlSeconds: number;

  @Config('authn.local.verify.url')
  protected VerifyUrl: string;

  @Config('authn.local.emailCode.ttlSeconds')
  protected EmailCodeTtlSeconds: number;

  @Logger('authn-local')
  protected Log: Log;

  @Autoinject(AuthnAudit)
  protected Audit: AuthnAudit;

  @Autoinject(IdentityStore)
  protected Identities: IdentityStore;

  @Autoinject(PasswordCredentialStore)
  protected Passwords: PasswordCredentialStore;

  @Autoinject(SessionIssuer)
  protected Sessions: SessionIssuer;

  @Autoinject(AuthnThrottle)
  protected Throttle: AuthnThrottle;

  @Autoinject(PasswordHasher)
  protected Hasher: PasswordHasher;

  @Autoinject(LocalPasswordPolicy)
  protected Policy: LocalPasswordPolicy;

  @Autoinject(SecretStore, { optional: true })
  protected Secrets: SecretStore | undefined;

  @Autoinject(PasswordMailer, { optional: true })
  protected Mailer: PasswordMailer | undefined;

  @Autoinject(TokenService, { optional: true })
  protected Tokens: TokenService | undefined;

  @Autoinject(IdentityAddressVerifier, { optional: true })
  protected Verifier: IdentityAddressVerifier | undefined;

  /** `@spinajs/users` registers one per `authn.local.mail.delivery`; none: inline. */
  @Autoinject(AuthnMailDispatcher, { optional: true })
  protected Dispatcher: AuthnMailDispatcher | undefined;

  private _work?: DeferredWork;
  private _dispatcher?: AuthnMailDispatcher;
  private _auditor?: AuthnAuditor;

  constructor(protected readonly Deps?: LocalPasswordServiceDeps) {
    super();
  }

  /** Resolves once the deferred reset lookups and every mail dispatched so far are done (tests, shutdown). */
  public async drain(): Promise<void> {
    await this.work().drain();
    await this.dispatcher().drain();
  }

  /** D9. Keeps every API and agent token (H32). */
  public async change(id: IdentityRef, oldPassword: string, newPassword: string, session: SessionHandle, ctx: AuthnContext): Promise<PasswordChangeResult> {
    const violations = await this.policyComponent().check(newPassword, await this.policyContext(id));
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
    const keys = identityThrottleKeys(id, ctx, this.ipv6Prefix);
    const gate = await throttle.attempt(keys, 'reauth', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'password.change', outcome: 'failure', identity: id, reason: 'throttled', session: handle });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }

    const verified = await this.verifiedHash(id, oldPassword);
    if (verified === null) {
      await this.audit(ctx, { type: 'password.change', outcome: 'failure', identity: id, reason: 'wrong_password', session: handle });
      return INVALID;
    }
    await throttle.succeed(keys, 'reauth');

    // Only over the hash the old password matched: an expiry, reset or set that landed meanwhile wins, and the old password
    // must not buy a new one after it (A30). No retry: the old password no longer verifies.
    if (!(await this.storePassword(id, newPassword, verified))) {
      await this.audit(ctx, { type: 'password.change', outcome: 'failure', identity: id, reason: 'stale', session: handle });
      return INVALID;
    }
    await sessions.revokeAll(id, { except: session, includeImpersonations: true });
    const rotated = await sessions.rotate(session);

    await this.audit(ctx, { type: 'password.change', outcome: 'success', identity: id, session: handle });
    return { status: 'changed', session: rotated };
  }

  /** D14. Not a voluntary change: every session and, with reset.revokeTokens, every token goes. */
  public async set(id: IdentityRef, newPassword: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<PasswordSetResult> {
    const violations = await this.policyComponent().check(newPassword, await this.policyContext(id));
    if (violations.length > 0) {
      return { status: 'rejected', violations };
    }

    await this.storePassword(id, newPassword);
    await this.sessions().revokeAll(id, { includeImpersonations: true });
    await this.revokeTokensOf(id, ctx, opts?.actor);

    await this.audit(ctx, { type: 'password.change', outcome: 'success', identity: id, ...(opts?.actor ? { actor: opts.actor } : {}), data: { cause: 'set' } });
    return { status: 'set' };
  }

  public check(password: string, ctx?: PasswordPolicyContext): Promise<readonly PasswordViolation[]> {
    return this.policyComponent().check(password, ctx);
  }

  public policy(): PasswordPolicy {
    return this.policyComponent().policy();
  }

  /**
   * D11. Counts first; then the lookup, issue, mail and audit run as deferred work, so the answer and its timing are the same for
   * known and unknown logins (A11, SR-04).
   */
  public async requestReset(login: string, ctx: AuthnContext): Promise<PasswordResetRequestResult> {
    const keys: ThrottleKey[] = [{ kind: 'account', value: normalizeLogin(login) }, this.resetIpKey(ctx)];
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
    const gate = await this.throttle().attempt([this.resetIpKey(ctx)], 'reset', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', data: { flow: 'reset' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }

    const identities = await this.identities();
    const secrets = await this.secrets();
    const id = await identities.findByLogin(login);
    const status = await identities.status(id ?? throwaway());
    const target = id && eligible(status) ? id : null;
    const pending = target !== null && status.invitePending === true;

    // After the lookup, so the similarity rule sees the account's identifiers; before the redeems, so a violation does not
    // use up the secret. A refused account shows the rule a throwaway ref, as an unknown login does.
    const violations = await this.policyComponent().check(newPassword, await this.policyContext(target ?? throwaway(), login));
    if (violations.length > 0) {
      return { status: 'rejected', violations };
    }

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
    const sent = await this.dispatchMail(id, 'invite', this.inviteTtlSeconds());
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

  /** Counts first; an identity that cannot verify or is verified already gets no mail and the same answer. */
  public async requestVerification(id: IdentityRef, ctx: AuthnContext): Promise<AddressVerificationRequestResult> {
    const gate = await this.throttle().attempt([verifyKey(id)], 'reset', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', identity: id, reason: 'throttled', data: { flow: 'verify' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }

    const status = await (await this.identities()).status(id);
    const refused = !eligible(status) ? 'status' : status.addressVerified === true ? 'verified' : null;
    if (refused) {
      await this.audit(ctx, { type: 'address.verify.request', outcome: 'failure', identity: id, reason: refused });
      return { status: 'accepted' };
    }
    const sent = await this.dispatchMail(id, 'verify', this.verifyTtlSeconds());
    await this.audit(ctx, { type: 'address.verify.request', outcome: sent ? 'success' : 'failure', identity: id, ...(sent ? {} : { reason: 'no_mailer' }) });
    return { status: 'accepted' };
  }

  /**
   * Counts first; then the lookup, issue, mail and audit run as deferred work, so the answer and its timing are the same for
   * known and unknown logins (SR-04).
   */
  public async requestCode(login: string, ctx: AuthnContext): Promise<CodeRequestResult> {
    const keys: ThrottleKey[] = [{ kind: 'account', value: `code:${normalizeLogin(login)}` }, this.resetIpKey(ctx)];
    const gate = await this.throttle().attempt(keys, 'reset', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', data: { flow: 'code' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }

    this.work().defer(() => this.sendLoginCode(login, ctx));
    return { status: 'accepted' };
  }

  /** Counts first; an identity that cannot get a code gets no mail and the same answer. */
  public async challengeCode(id: IdentityRef, ctx: AuthnContext): Promise<CodeRequestResult> {
    const gate = await this.throttle().attempt([codeKey(id)], 'reset', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', identity: id, reason: 'throttled', data: { flow: 'code' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }
    await this.sendCode(id, ctx, 'mfa');
    return { status: 'accepted' };
  }

  /** Every refusal answers `invalid`; the reason goes to audit only. */
  public async redeemVerification(secret: string, ctx: AuthnContext): Promise<AddressVerificationResult> {
    const verifier = this.verifier();
    const parsed = parseVerifySecret(secret);
    if (!parsed) {
      await (await this.secrets()).redeem(throwaway(), 'verify', '');
      await this.audit(ctx, { type: 'address.verify', outcome: 'failure', reason: 'malformed' });
      return INVALID;
    }
    const status = await (await this.identities()).status(parsed.id);
    const target = eligible(status) ? parsed.id : null;
    // Always one redeem, on a throwaway ref where no real one is due: otherwise the time tells a forged identity part apart.
    const redeemed = await (await this.secrets()).redeem(target ?? throwaway(), 'verify', parsed.raw);

    if (!target || !redeemed) {
      const reason = !status.exists ? 'unknown_identity' : !target ? 'status' : 'secret';
      await this.audit(ctx, { type: 'address.verify', outcome: 'failure', ...(status.exists ? { identity: parsed.id } : {}), reason });
      return INVALID;
    }
    await verifier.markVerified(target, ctx.now);
    await this.audit(ctx, { type: 'address.verify', outcome: 'success', identity: target });
    return { status: 'verified' };
  }

  /** Dispatched without a secret: the mail points at the reset page. An identity that cannot sign in gets none. */
  public async notifyAccountExists(id: IdentityRef, _ctx: AuthnContext): Promise<void> {
    if (eligible(await (await this.identities()).status(id))) {
      await this.dispatchMail(id, 'account-exists', this.resetTtlSeconds());
    }
  }

  /** D15. `admin` revokes tokens under reset.revokeTokens and mails only with `sendReset`; `aged` keeps tokens (H32) and mails. */
  public async expire(id: IdentityRef, opts: PasswordExpiry, ctx: AuthnContext): Promise<void> {
    const sessions = this.sessions();
    // The job skips marked identities, so for `aged` the marker goes after the revoke: a failed revoke leaves the identity
    // unmarked for the next run. An admin sees the error and retries, so there the password dies first.
    if (opts.cause === 'aged') {
      await sessions.revokeAll(id, { includeImpersonations: true });
      await (await this.passwords()).set(id, EXPIRED_PASSWORD_MARKER);
    } else {
      await (await this.passwords()).set(id, EXPIRED_PASSWORD_MARKER);
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
      if (eligible(await (await this.identities()).status(id))) {
        await this.dispatchMail(id, 'reset', this.resetTtlSeconds());
      }
    } catch (err) {
      this.log().warn({ identityType: id.type, identityId: id.id, errorName: (err as Error)?.name ?? typeof err }, 'The reset mail after the password expiry of ${identityType} ${identityId} failed: ${errorName}');
    }
  }

  protected async sendReset(login: string, ctx: AuthnContext): Promise<void> {
    const identities = await this.identities();
    const id = await identities.findByLogin(login);
    if (!id) {
      await this.audit(ctx, { type: 'password.reset.request', outcome: 'failure', reason: 'unknown_login' });
      return;
    }
    if (!eligible(await identities.status(id))) {
      await this.audit(ctx, { type: 'password.reset.request', outcome: 'failure', identity: id, reason: 'status' });
      return;
    }
    const sent = await this.dispatchMail(id, 'reset', this.resetTtlSeconds());
    await this.audit(ctx, { type: 'password.reset.request', outcome: sent ? 'success' : 'failure', identity: id, ...(sent ? {} : { reason: 'no_mailer' }) });
  }

  protected async sendLoginCode(login: string, ctx: AuthnContext): Promise<void> {
    const id = await (await this.identities()).findByLogin(login);
    if (!id) {
      await this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'unknown_login', data: { via: 'login' } });
      return;
    }
    await this.sendCode(id, ctx, 'login');
  }

  protected async sendCode(id: IdentityRef, ctx: AuthnContext, via: 'login' | 'mfa'): Promise<void> {
    const refused = codeRefusal(await (await this.identities()).status(id));
    if (refused) {
      await this.audit(ctx, { type: 'code.request', outcome: 'failure', identity: id, reason: refused, data: { via } });
      return;
    }
    const sent = await this.dispatchMail(id, 'code', this.emailCodeTtlSeconds());
    await this.audit(ctx, { type: 'code.request', outcome: sent ? 'success' : 'failure', identity: id, ...(sent ? {} : { reason: 'no_mailer' }), data: { via } });
  }

  /** Hands the request on without a secret (SR-09): `deliver` issues it. Without a mailer nothing is dispatched. */
  protected async dispatchMail(id: IdentityRef, purpose: AuthnMailPurpose, ttlSeconds: number): Promise<boolean> {
    if (!(await this.mailer())) {
      this.warnNoMailer(id, purpose);
      return false;
    }
    // The real clock, not ctx.now: deliver() measures the age of the request against it.
    await this.dispatcher().dispatch({ identity: id, purpose, ttlSeconds, requestedAt: new Date() });
    return true;
  }

  protected warnNoMailer(id: IdentityRef, purpose: AuthnMailPurpose): void {
    this.log().warn({ purpose, identityType: id.type, identityId: id.id }, 'No PasswordMailer is registered: the ${purpose} mail for ${identityType} ${identityId} was not sent');
  }

  /**
   * Issues the secret, resolves the address and sends through the PasswordMailer at once. False when there is no mailer, no
   * address, or the request is older than its ttl.
   */
  public async deliver(request: AuthnMailRequest): Promise<boolean> {
    const { identity: id, purpose, ttlSeconds } = request;
    const log = { purpose, identityType: id.type, identityId: id.id };
    const requestedAt = request.requestedAt.getTime();
    // A link issued now would already be past the lifetime the request asked for.
    if (!Number.isFinite(requestedAt) || Date.now() > requestedAt + ttlSeconds * 1000) {
      this.log().warn(log, 'The ${purpose} mail for ${identityType} ${identityId} was requested longer ago than its lifetime and is dropped');
      return false;
    }
    const mailer = await this.mailer();
    if (!mailer) {
      this.warnNoMailer(id, purpose);
      return false;
    }
    const to = await (await this.identities()).display(id);
    if (!to.email) {
      this.log().warn(log, 'The ${purpose} mail for ${identityType} ${identityId} was not sent: the identity has no email address');
      return false;
    }
    await mailer.send({ identity: id, purpose, to, ...(await this.issueFor(id, purpose, ttlSeconds)), ttlSeconds, ...(request.lang ? { lang: request.lang } : {}) });
    return true;
  }

  /** The secret to mail for `purpose` with the page that redeems it; a code has no page, an account-exists mail no secret. */
  protected async issueFor(id: IdentityRef, purpose: AuthnMailPurpose, ttlSeconds: number): Promise<{ secret: string; url: string; code?: string }> {
    if (purpose === 'code') {
      const code = await new EmailCodes(await this.secrets()).issue(id, ttlSeconds);
      return { secret: code, code, url: '' };
    }
    if (purpose === 'account-exists') return { secret: '', url: this.resetUrl() };
    const raw = await (await this.secrets()).issue(id, purpose, ttlSeconds);
    return purpose === 'verify' ? { secret: verifySecretOf(id, raw), url: this.verifyUrl() } : { secret: raw, url: this.resetUrl() };
  }

  /**
   * The stored hash `password` matches, or null. One argon2 verify on every path, like the login strategy: the fixed login bound,
   * then the stored hash or the dummy.
   */
  protected async verifiedHash(id: IdentityRef, password: string): Promise<string | null> {
    const hasher = await this.hasher();
    if (!isLoginLength(password)) {
      await hasher.verify(null, '');
      return null;
    }
    const stored = await (await this.passwords()).get(id);
    return (await hasher.verify(stored, password)) ? stored : null;
  }

  /** What the similarity rule compares a new password with: `login` as typed, and what the store shows for `id`. */
  protected async policyContext(id: IdentityRef, login?: string): Promise<PasswordPolicyContext> {
    const shown = await (await this.identities()).display(id);
    return { ...(login !== undefined ? { login } : {}), ...(shown.email ? { email: shown.email } : {}), ...(shown.name ? { name: shown.name } : {}) };
  }

  /** With `expected`, writes only over that stored hash and answers whether it wrote; without it, writes unconditionally. */
  protected async storePassword(id: IdentityRef, password: string, expected?: string): Promise<boolean> {
    const hasher = await this.hasher();
    const hash = await hasher.hash(password);
    return (await this.passwords()).set(id, hash, expected);
  }

  protected async revokeTokensOf(id: IdentityRef, ctx: AuthnContext, actor?: PrincipalRef): Promise<void> {
    // Only an explicit false switches revocation off: a missing or malformed value must not leave a reset's tokens alive.
    const enabled = this.Deps ? (this.Deps.revokeTokens ?? AUTHN_LOCAL_DEFAULTS.reset.revokeTokens) : this.RevokeTokens !== false;
    const tokens = enabled ? await this.tokens() : null;
    if (tokens) {
      await tokens.revokeAllFor(id, ctx, actor ? { actor } : undefined);
    }
  }

  protected async audit(ctx: AuthnContext, e: AuthnEventBody): Promise<void> {
    await this.auditor().publishIn(ctx, e);
  }

  protected work(): DeferredWork {
    return (this._work ??= new DeferredWork(this.log()));
  }

  protected dispatcher(): AuthnMailDispatcher {
    return (this._dispatcher ??= (this.Deps ? this.Deps.dispatcher : this.Dispatcher) ?? new InlineAuthnMailDispatcher((r) => this.deliver(r), this.log()));
  }

  protected resetTtlSeconds(): number {
    return this.Deps ? (this.Deps.resetTtlSeconds ?? AUTHN_LOCAL_DEFAULTS.reset.ttlSeconds) : this.ResetTtlSeconds;
  }

  protected inviteTtlSeconds(): number {
    return this.Deps ? (this.Deps.inviteTtlSeconds ?? AUTHN_LOCAL_DEFAULTS.invite.ttlSeconds) : this.InviteTtlSeconds;
  }

  protected verifyTtlSeconds(): number {
    return this.Deps ? (this.Deps.verifyTtlSeconds ?? AUTHN_LOCAL_DEFAULTS.verify.ttlSeconds) : this.VerifyTtlSeconds;
  }

  protected emailCodeTtlSeconds(): number {
    return this.Deps ? (this.Deps.emailCodeTtlSeconds ?? AUTHN_LOCAL_DEFAULTS.emailCode.ttlSeconds) : this.EmailCodeTtlSeconds;
  }

  protected verifyUrl(): string {
    return this.Deps ? (this.Deps.verifyUrl ?? AUTHN_LOCAL_DEFAULTS.verify.url) : this.VerifyUrl;
  }

  protected verifier(): IdentityAddressVerifier {
    const verifier = (this.Deps ? this.Deps.verifier : this.Verifier) ?? null;
    if (!verifier) {
      throw new InvalidOperation(this.Deps ? 'LocalPasswordService was built without an IdentityAddressVerifier' : 'Address verification needs an IdentityAddressVerifier, and none is registered');
    }
    return verifier;
  }

  protected resetUrl(): string {
    return this.Deps ? (this.Deps.resetUrl ?? AUTHN_LOCAL_DEFAULTS.reset.url) : this.ResetUrl;
  }

  protected async identities(): Promise<IdentityStore> {
    return this.Deps ? this.Deps.identities : this.Identities;
  }

  protected async secrets(): Promise<SecretStore> {
    const secrets = this.Deps ? this.Deps.secrets : this.Secrets;
    if (!secrets) {
      throw new InvalidOperation(this.Deps ? 'LocalPasswordService was built without a SecretStore' : 'The reset and invite flows need a SecretStore, and none is registered');
    }
    return secrets;
  }

  protected async mailer(): Promise<PasswordMailer | null> {
    return (this.Deps ? this.Deps.mailer : this.Mailer) ?? null;
  }

  protected policyComponent(): LocalPasswordPolicy {
    return this.Deps ? this.Deps.policy : this.Policy;
  }

  protected sessions(): SessionIssuer {
    return this.Deps ? this.Deps.sessions : this.Sessions;
  }

  protected throttle(): AuthnThrottle {
    return this.Deps ? this.Deps.throttle : this.Throttle;
  }

  protected get ipv6Prefix(): number {
    return this.Deps ? (this.Deps.ipv6Prefix ?? DEFAULT_IPV6_PREFIX) : ipv6PrefixOf(this.ThrottleIpv6Prefix);
  }

  /**
   * The reset flow's ip key. Callers without `ctx.ip` share one bucket rather than going unthrottled, so one caller's requests can
   * throttle every other caller that also omits it: HTTP callers must pass the trusted-proxy ip.
   */
  protected resetIpKey(ctx: AuthnContext): ThrottleKey {
    return ipKey(ctx, this.ipv6Prefix) ?? { kind: 'ip', value: 'unknown' };
  }

  protected async passwords(): Promise<PasswordCredentialStore> {
    return this.Deps ? this.Deps.passwords : this.Passwords;
  }

  protected async hasher(): Promise<PasswordHasher> {
    return this.Deps ? this.Deps.hasher : this.Hasher;
  }

  protected async tokens(): Promise<TokenService | null> {
    return (this.Deps ? this.Deps.tokens : this.Tokens) ?? null;
  }

  protected auditor(): AuthnAuditor {
    return this.Deps ? (this._auditor ??= AuthnAudit.over(this.Deps.sinks, { log: this.log() })) : this.Audit;
  }

  protected log(): AuditLog {
    return this.Deps ? (this.Deps.log ?? { warn: () => undefined }) : this.Log;
  }
}
