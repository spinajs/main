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
      /** 2.x Profile; authn-token checks it against the profiles the owner may pin a token to. */
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
  /** 2.x Profile: the one role the token is pinned to (§18.3(e)); a profile never widens. */
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

/**
 * A StrategyOutcome, so TokenStrategy returns it as is. ceiling.roles are the token's roles. An agent token yields identity
 * { type: 'agent', id: token id }, delegation 'inherit' on behalf of the owner and a ceiling with reason 'out_of_scope' and no roles (A15).
 */
export type TokenValidation =
  | {
      readonly ok: true;
      readonly identity: IdentityRef;
      readonly method: 'token';
      readonly ceiling?: Ceiling;
      readonly delegation?: never;
      /** token.profile; authn-http's token resolver sets the principal's attributes.profile from it (§18.3(e)). */
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
  /** Password reset and admin credential reset (A11, A25); agent tokens acting for `owner` included. Returns the count. */
  abstract revokeAllFor(owner: IdentityRef, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<number>;
  /** Hash lookup; checks revocation, expiry and the owner's status on every use (A14, A15). Bad tokens yield a failure; they are never thrown. */
  abstract validate(raw: string, ctx: AuthnContext): Promise<TokenValidation>;
}
