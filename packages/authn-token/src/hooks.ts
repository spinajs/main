// The augmentation below resolves '@spinajs/hooks' only when this file imports it.
import '@spinajs/hooks';
import type { AuthnContext, IdentityRef, PrincipalRef, TokenCreateOptions, TokenCreateResult, TokenRotateResult, TokenUpdate, TokenUpdateResult } from '@spinajs/authn/contracts';

/** `opts` is mutable; the service checks the TTL cap again and refuses a scope wider than the caller asked for. */
export interface TokenCreateInput {
  readonly owner: IdentityRef;
  opts: TokenCreateOptions;
  readonly ctx: AuthnContext;
}

/** No output carries a plaintext token. */
export type TokenCreateOutput = Exclude<TokenCreateResult, { ok: true }> | { readonly ok: true; readonly record: Extract<TokenCreateResult, { ok: true }>['record'] };

export type TokenRotateOutput = Exclude<TokenRotateResult, { ok: true }> | { readonly ok: true; readonly token: Extract<TokenRotateResult, { ok: true }>['token'] };

export interface TokenRevokeInput {
  readonly owner: IdentityRef;
  readonly id: string;
  readonly actor?: PrincipalRef;
  readonly ctx: AuthnContext;
}

export interface TokenRotateInput {
  readonly owner: IdentityRef;
  readonly id: string;
  readonly opts?: { readonly graceSeconds?: number };
  readonly ctx: AuthnContext;
}

/** `opts` is mutable; the service checks again that the change only narrows the token. */
export interface TokenUpdateInput {
  readonly owner: IdentityRef;
  readonly id: string;
  opts: TokenUpdate;
  readonly ctx: AuthnContext;
}

/** Runs before the plaintext is looked up, so it names no token. */
export interface TokenSelfRevokeInput {
  readonly ctx: AuthnContext;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'authn.token.create': { input: TokenCreateInput; output: TokenCreateOutput };
    'authn.token.revoke': { input: TokenRevokeInput; output: boolean };
    'authn.token.rotate': { input: TokenRotateInput; output: TokenRotateOutput };
    'authn.token.update': { input: TokenUpdateInput; output: TokenUpdateResult };
    /** Not refusable. */
    'authn.token.selfRevoke': { input: TokenSelfRevokeInput; output: boolean };
  }
}
