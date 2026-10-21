import type { AuthnContext, AuthnFailure, IdentityRef } from './credentials.js';
import type { Ceiling, PrincipalRef, ResourceRef } from './principal.js';

export type TokenKind = 'pat' | 'agent' | 'service';

/**
 * The Scope column: the ceiling limits a token sets beyond its roles. Roles have their own option, the expiry is the token's own,
 * and an agent token's ceiling reason is always 'out_of_scope' (A15), so none of them lives here.
 */
export interface TokenScope {
  readonly permissions?: readonly string[];
  readonly resources?: readonly ResourceRef[];
  /** True exactly when kind is 'agent'. */
  readonly agent?: boolean;
}

export type TokenCreateOptions = {
  readonly name: string;
  /** Mandatory; at most authn.token.maxTtlDays ahead, for an agent token at most authn.token.agentMaxTtlMinutes (A14, A15). */
  readonly expiresAt: Date;
} & (
  | {
      readonly kind: 'pat' | 'service';
      /** Become ceiling.roles. */
      readonly roles?: readonly string[];
      /** A role name to pin the token to; authn-token checks it against the profiles the owner may pin a token to. */
      readonly profile?: string;
      readonly scope?: TokenScope & { readonly agent?: false };
    }
  | {
      readonly kind: 'agent';
      /** An agent acts with its owner's rights narrowed by its scope: roles and a profile are refused (invalid_scope). */
      readonly roles?: never;
      readonly profile?: never;
      readonly scope: TokenScope & { readonly agent: true };
    }
);

/** Never holds the plaintext or its hash. */
export interface TokenRecord {
  /** rbac_access_tokens.Uuid, never the row id. */
  readonly id: string;
  /** For an agent token, the identity it acts for. */
  readonly owner: IdentityRef;
  readonly name: string;
  readonly kind: TokenKind;
  readonly roles?: readonly string[];
  /** The one role the token is pinned to (§18.3(e)); a profile never widens. */
  readonly profile?: string;
  readonly scope?: TokenScope;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt?: Date;
  readonly lastUsedIp?: string;
}

export type TokenCreateResult =
  | {
      readonly ok: true;
      /** Returned once; never stored or logged (A14, SR-08). */
      readonly plaintext: string;
      readonly record: TokenRecord;
    }
  | { readonly ok: false; readonly code: 'invalid_expiry' | 'invalid_scope' };

export type TokenRotateResult =
  | {
      readonly ok: true;
      /** The new secret, returned once; never stored or logged (SR-08). */
      readonly plaintext: string;
      readonly token: TokenRecord;
    }
  | { readonly ok: false; readonly reason: 'not_found' };

/** The fields `update` can change; each can only narrow the token. */
export interface TokenUpdate {
  readonly name?: string;
  /** A subset of the token's roles; for a token without roles, roles its owner holds. */
  readonly roles?: readonly string[];
  /** Not after the current expiry, and after ctx.now. */
  readonly expiresAt?: Date;
}

export type TokenUpdateResult =
  | { readonly ok: true; readonly token: TokenRecord }
  | { readonly ok: false; readonly reason: 'not_found' | 'invalid_scope' | 'invalid_expiry' };

/**
 * A StrategyOutcome; TokenStrategy returns it with `profile` copied to attributes.profile. ceiling.roles are the token's roles. An agent token yields identity
 * { type: 'agent', id: token id }, delegation 'inherit' on behalf of the owner and a ceiling with reason 'out_of_scope' and no roles (A15).
 */
export type TokenValidation =
  | {
      readonly ok: true;
      readonly identity: IdentityRef;
      readonly method: 'token';
      readonly ceiling?: Ceiling;
      readonly delegation?: never;
      /** token.profile; reaches the principal as attributes.profile through StrategyOutcome.attributes and principalOf (§18.3(e)). */
      readonly profile?: string;
      readonly token: TokenRecord;
    }
  | {
      readonly ok: true;
      readonly identity: { readonly type: 'agent'; readonly id: string };
      readonly method: 'token';
      readonly ceiling: Ceiling & { readonly roles?: never; readonly reason: 'out_of_scope' };
      readonly delegation: { readonly onBehalfOf: IdentityRef; readonly mode: 'inherit' };
      readonly profile?: never;
      readonly token: TokenRecord;
    }
  | { readonly ok: false; readonly reason: AuthnFailure };

/** Implemented by @spinajs/authn-token over rbac_access_tokens; tokens are stored as SHA-256 only. */
export abstract class TokenService {
  /**
   * POST /user/tokens; the route requires fresh auth (A13). 'invalid_scope': kind 'agent' without scope.agent, or the reverse, or an
   * agent token with roles or a profile; invalid_expiry: not after ctx.now, or beyond the cap.
   */
  abstract create(owner: IdentityRef, opts: TokenCreateOptions, ctx: AuthnContext): Promise<TokenCreateResult>;
  /** GET /user/tokens: live and expired tokens; revoked ones are left out. */
  abstract list(owner: IdentityRef): Promise<readonly TokenRecord[]>;
  /**
   * DELETE /user/tokens/:uuid. Owner-bound: false unless a live token with that id has an owner of the same type and id as `owner`
   * (no IDOR). The admin route passes the target as owner.
   */
  abstract revoke(owner: IdentityRef, id: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean>;
  /**
   * POST /user/tokens/:uuid/rotate; the route requires fresh auth. Replaces the secret of a live token of `owner` and keeps its id, name,
   * roles, scope and expiry. The old secret stops working at once, or after `graceSeconds` (default 0, whole seconds, at most
   * 604800, else InvalidArgument) so a deployment can swap it. Owner-bound: not_found for a token that is
   * revoked, expired, unknown or someone else's (no IDOR).
   */
  abstract rotate(owner: IdentityRef, id: string, ctx: AuthnContext, opts?: { readonly graceSeconds?: number }): Promise<TokenRotateResult>;
  /**
   * PATCH /user/tokens/:uuid. Only narrows: adding a role is invalid_scope (so is roles on an agent token or an empty list), an expiry
   * past the current one, or not after ctx.now, is invalid_expiry. Owner-bound like revoke; not_found for a revoked token.
   */
  abstract update(owner: IdentityRef, id: string, change: TokenUpdate, ctx: AuthnContext): Promise<TokenUpdateResult>;
  /** Password reset and admin credential reset (A11, A25); agent tokens acting for `owner` included. Returns the count. */
  abstract revokeAllFor(owner: IdentityRef, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<number>;
  /**
   * POST /auth/tokens/revoke (RFC 7009): the holder of a secret ends its token without a session. True when this call revoked a live token;
   * false for an unknown, malformed, already revoked or out-of-grace secret, and never thrown, so the route answers the same in every case.
   * The previous secret of a rotation counts only until its grace ends. Audited as `token.revoke` with reason 'self'.
   */
  abstract revokeByPlaintext(raw: string, ctx: AuthnContext): Promise<boolean>;
  /** Hash lookup; checks revocation, expiry and the owner's status on every use (A14, A15). Bad tokens yield a failure; they are never thrown. */
  abstract validate(raw: string, ctx: AuthnContext): Promise<TokenValidation>;
}
