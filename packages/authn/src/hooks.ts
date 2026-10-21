import type { AuthenticationResult, AuthnContext, Credentials, ExternalSubject, IdentityRef } from './contracts/credentials.js';
import type { SessionHandle } from './contracts/session.js';
import type { ImpersonationStart } from './impersonation/impersonation-service.js';
import type { LinkResult } from './link/account-link-service.js';
import { ActionHookFailed, ActionRefused } from '@spinajs/hooks';
import type { ActionName } from '@spinajs/hooks';

/**
 * `authn.login`: `AuthnService.authenticate` of a login (not of a per-request credential), before the throttle
 * and every strategy. A hook here must not branch on whether the account exists: its refusal is fast, so the timing
 * would tell. Rules that need the account belong in `authn.login.identified`.
 */
export interface AuthnLoginInput {
  credentials: Credentials;
  readonly ctx: AuthnContext;
}

/** `authn.login.identified`: an interactive login whose identity is known and whose status allows it, before MFA and the session. */
export interface AuthnLoginIdentifiedInput {
  readonly identity: IdentityRef;
  /** The strategy's configured name, e.g. `local` or `oidc:<provider>`. */
  readonly strategy: string;
  readonly method: string;
  /** The mapped subject of an external login (OIDC), its claims included. */
  readonly external?: ExternalSubject;
  /** The strategy's attributes; they reach PrincipalFactory as `extra.attributes`, where a PrincipalAttributeProvider key wins. */
  attributes: Readonly<Record<string, unknown>>;
  readonly ctx: AuthnContext;
}

export interface AuthnMfaVerifyInput {
  readonly pending: SessionHandle;
  readonly step: string;
  readonly response: string;
  readonly ctx: AuthnContext;
}

export interface AuthnReauthInput {
  readonly session: SessionHandle;
  readonly credentials: Credentials;
  readonly ctx: AuthnContext;
}

export interface AuthnStepUpInput {
  readonly session: SessionHandle;
  readonly step: string;
  readonly response: string;
  readonly ctx: AuthnContext;
}

export interface AuthnImpersonationStartInput {
  readonly session: SessionHandle;
  readonly target: IdentityRef;
  readonly ctx: AuthnContext;
}

export interface AuthnImpersonationStopInput {
  readonly session: SessionHandle;
  readonly ctx: AuthnContext;
}

export interface AuthnLinkInput {
  readonly session: SessionHandle;
  readonly external: ExternalSubject;
  readonly ctx: AuthnContext;
}

export interface AuthnUnlinkInput {
  readonly session: SessionHandle;
  readonly linkId: string;
  readonly ctx: AuthnContext;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'authn.login': { input: AuthnLoginInput; output: AuthenticationResult };
    'authn.login.identified': { input: AuthnLoginIdentifiedInput; output: AuthenticationResult };
    'authn.mfa.verify': { input: AuthnMfaVerifyInput; output: AuthenticationResult };
    'authn.reauth': { input: AuthnReauthInput; output: boolean };
    'authn.session.stepUp': { input: AuthnStepUpInput; output: AuthenticationResult };
    'authn.impersonation.start': { input: AuthnImpersonationStartInput; output: ImpersonationStart };
    'authn.impersonation.stop': { input: AuthnImpersonationStopInput; output: SessionHandle | null };
    'authn.link': { input: AuthnLinkInput; output: LinkResult };
    'authn.unlink': { input: AuthnUnlinkInput; output: { ok: boolean } };
  }
}

/** What a refused or failed action hook audits: `hook:<code>` for a refusal, `hook_error` (with the hook class and why) for a hook that failed. */
export interface HookRefusal {
  readonly reason: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** The audit reason of an error `Hooks.run(action, ...)` threw for its own hooks, or null for any other error, which the caller handles as before. */
export function hookRefusalOf(err: unknown, action: ActionName): HookRefusal | null {
  // A nested action's refusal is that action's to answer; one escaping it is not this action's refusal.
  if (err instanceof ActionRefused && err.action === action) return { reason: `hook:${err.code}` };
  if (err instanceof ActionHookFailed && err.action === action) return { reason: 'hook_error', data: { hook: err.hook, failure: err.reason } };
  return null;
}

function deepFreeze<T>(value: T): T {
  // A typed array with elements cannot be frozen; its bytes are a copy anyway.
  if (value === null || typeof value !== 'object' || Object.isFrozen(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
  return value;
}

/** A deep copy of `value`, or null when structuredClone refuses it (a function or a class with private state inside). */
function deepCopy<T>(value: T): T | null {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

const shallowCopy = <T>(value: T): T => (Array.isArray(value) ? [...value] : { ...value }) as T;

/** A copy of `value`, so a hook that changes it in place cannot reach the action's own data; shallow when it cannot be cloned. */
export function hookCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return deepCopy(value) ?? shallowCopy(value);
}

/**
 * What a hook gets for a key it may not change: a deep copy, frozen, so a write in place fails in the hook. A value
 * that cannot be cloned is copied and frozen at the top level only: freezing deeper would freeze the caller's own
 * nested objects, which the shallow copy still shares, and break the action's later writes to them.
 */
export function hookView<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const deep = deepCopy(value);
  return deep !== null ? deepFreeze(deep) : Object.freeze(shallowCopy(value));
}
