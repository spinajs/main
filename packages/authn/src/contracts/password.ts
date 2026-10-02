import type { AuthnContext, IdentityRef } from './credentials.js';
import type { PrincipalRef } from './principal.js';
import type { SessionHandle } from './session.js';

/** What a client may show before a password is submitted (2.x IPasswordPolicy). */
export interface PasswordPolicy {
  readonly minLength: number;
  readonly maxLength: number;
  /** ECMAScript regular expression source, when the configured rule has one. */
  readonly pattern?: string;
  /** Copy to show next to the field; never validated against. */
  readonly description?: string;
}

/** A policy violation says nothing about the account, so the caller may show it. */
export type PasswordViolation = 'too_short' | 'too_long' | 'rule' | 'blocklisted';

/**
 * 'invalid' is the one answer for an unknown or inactive account, a wrong password, and a missing, expired, used or wrong secret
 * (A02, A11, SR-17); the real reason goes to audit only.
 */
export type PasswordRefusal = { readonly status: 'invalid' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number } | { readonly status: 'rejected'; readonly violations: readonly PasswordViolation[] };

export type PasswordChangeResult =
  | {
      readonly status: 'changed';
      /** The rotated current session. */
      readonly session: SessionHandle;
    }
  | PasswordRefusal;

export type PasswordResetRequestResult = { readonly status: 'accepted' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number };

export type PasswordResetResult = { readonly status: 'reset'; readonly purpose: 'reset' | 'invite' } | PasswordRefusal;

export type PasswordSetResult = { readonly status: 'set' } | { readonly status: 'rejected'; readonly violations: readonly PasswordViolation[] };

/** Why a password stops working. */
export type PasswordExpiry =
  | {
      /**
       * Admin /authn/admin/users/:uuid/password-reset and the 2.x "expire password" action (A25): revokes every session, incl. those
       * where it is the impersonator, and with authn.local.reset.revokeTokens every token (A30). The caller never receives a secret
       * (A10, SR-10) and applies the target guard.
       */
      readonly cause: 'admin';
      readonly actor: PrincipalRef;
      /** Has a reset link mailed to the owner. */
      readonly sendReset?: boolean;
    }
  | {
      /**
       * The authn.local.expiration job: revokes every session, incl. those where it is the impersonator, so the expiry takes effect;
       * keeps every API and agent token (H32); has a reset link mailed to the owner.
       */
      readonly cause: 'aged';
    };

/** Implemented by @spinajs/authn-local. Passwords are never trimmed and must be 8–128 characters wherever they are set (A04, SR-14). */
export abstract class PasswordService {
  /**
   * PATCH /user/password. Checks the policy, then counts the attempt in the 'reauth' throttle and verifies oldPassword inline
   * as fresh auth (A13, SR-20). `session` is the caller's session and must be an active session of `id`; otherwise 'invalid' (fails closed).
   * Revokes every other session of `id`, incl. those where it is the impersonator, rotates `session`
   * and keeps every API and agent token (A30, H32).
   */
  abstract change(id: IdentityRef, oldPassword: string, newPassword: string, session: SessionHandle, ctx: AuthnContext): Promise<PasswordChangeResult>;
  /**
   * POST /auth/password/reset-request. Counts the attempt in the 'reset' flow (IP and account keys) before anything else, then answers
   * at once with the same result whether or not the account exists (A11, SR-04). Returns no secret: it is issued and rendered when the
   * mail is sent (SR-09).
   */
  abstract requestReset(login: string, ctx: AuthnContext): Promise<PasswordResetRequestResult>;
  /**
   * POST /auth/password/reset. Counts the attempt against the 'reset' flow's IP key only (the account key would refuse a link redeemed
   * soon after its request), then checks the policy, then the secret, so a violation tells nothing about the account and does not use
   * up the secret. Single use; takes the same time for an unknown login (A02). Accepts purpose 'reset', or 'invite' while the identity
   * has a pending invite (A32). Revokes every session of the identity, incl. those where it is the impersonator, and with
   * authn.local.reset.revokeTokens every token (A11, A30).
   */
  abstract redeemReset(login: string, secret: string, newPassword: string, ctx: AuthnContext): Promise<PasswordResetResult>;
  /** Issues a secret of purpose 'invite' and has it mailed; returns no secret (SR-09). users marks the identity invite-pending. */
  abstract invite(id: IdentityRef, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<void>;
  /** GET /auth/password/policy. */
  abstract policy(): PasswordPolicy;
  /** Length, rule and blocklist, as every method that sets a password applies them (A04); empty: acceptable. Lets users check before it creates an identity. */
  abstract check(password: string): Promise<readonly PasswordViolation[]>;
  /**
   * Sets a password without the old one: users' create and the CLI. Applies `check` (A04). Not a voluntary change: revokes every session
   * of `id`, incl. those where it is the impersonator, and with authn.local.reset.revokeTokens every token (A30).
   */
  abstract set(id: IdentityRef, newPassword: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<PasswordSetResult>;
  /** Makes the current password unusable; the rest depends on the cause. */
  abstract expire(id: IdentityRef, opts: PasswordExpiry, ctx: AuthnContext): Promise<void>;
}
