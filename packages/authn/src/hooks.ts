import type { AuthenticationResult, AuthnContext, Credentials, ExternalSubject, IdentityRef } from './contracts/credentials.js';
import type { CredentialAdminAction } from './contracts/hooks.js';
import type { Principal } from './contracts/principal.js';
import type { SessionHandle } from './contracts/session.js';
import type { ImpersonationStart } from './impersonation/impersonation-service.js';
import type { LinkResult } from './link/account-link-service.js';
import { isConstructor } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ActionHook, ActionHookFailed, ActionRefused } from '@spinajs/hooks';
import type { ActionName, ActionPattern, BeforeContext, Hooks, InputOf, OutputOf, RunOptions } from '@spinajs/hooks';

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
  /** The code a refused action answers with: the hook's, or `hook_error` for a hook that failed. */
  readonly code: string;
  readonly reason: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** The audit reason of an error `Hooks.run(action, ...)` threw for its own hooks, or null for any other error, which the caller handles as before. */
export function hookRefusalOf(err: unknown, action: ActionName): HookRefusal | null {
  // A nested action's refusal is that action's to answer; one escaping it is not this action's refusal.
  if (err instanceof ActionRefused && err.action === action) return { code: err.code, reason: `hook:${err.code}` };
  if (err instanceof ActionHookFailed && err.action === action) return { code: 'hook_error', reason: 'hook_error', data: { hook: err.hook, failure: err.reason } };
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

const isPlainObject = (v: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * The copy of a value structuredClone refused: plain objects, arrays, Dates, Maps, Sets and typed arrays are copied
 * depth-first (frozen when `freeze`); a class instance (an ORM model holding its container) or a function is passed
 * through as is and never frozen, because it is the caller's. `seen` keeps a cycle through plain data one copy.
 */
function partialCopy(value: unknown, freeze: boolean, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return finish(new Date(value.getTime()), freeze);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return deepCopy(value) ?? value;
  if (value instanceof Map || value instanceof Set || Array.isArray(value)) return copyCollection(value, freeze, seen);
  if (!isPlainObject(value)) return value;
  const out = Object.create(Object.getPrototypeOf(value) as object | null) as object;
  seen.set(value, out);
  Object.assign(out, Object.fromEntries(Object.entries(value).map(([k, v]) => [k, partialCopy(v, freeze, seen)])));
  return finish(out, freeze);
}

const finish = <V>(copy: V, freeze: boolean): V => (freeze ? Object.freeze(copy) : copy);

function copyCollection(value: Map<unknown, unknown> | Set<unknown> | unknown[], freeze: boolean, seen: Map<object, unknown>): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const v of value) out.push(partialCopy(v, freeze, seen));
    return finish(out, freeze);
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    seen.set(value, out);
    for (const [k, v] of value) out.set(k, partialCopy(v, freeze, seen));
    return finish(out, freeze);
  }
  const out = new Set<unknown>();
  seen.set(value, out);
  for (const v of value) out.add(partialCopy(v, freeze, seen));
  return finish(out, freeze);
}

/**
 * A copy of `value`, so a hook that changes it in place cannot reach the action's own data. A value structuredClone
 * refuses is copied as far as it is plain data; its class instances and functions are the caller's, shared.
 */
export function hookCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return deepCopy(value) ?? (partialCopy(value, false, new Map()) as T);
}

/**
 * What a hook gets for a key it may not change: a deep copy, frozen, so a write in place fails in the hook. A value
 * structuredClone refuses keeps its plain data as frozen copies; only the leaves that cannot be cloned (a class
 * instance such as an ORM model, a function) are passed through, unfrozen: they are the caller's, and must not be
 * changed by a hook.
 */
export function hookView<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const deep = deepCopy(value);
  return deep !== null ? deepFreeze(deep) : (partialCopy(value, true, new Map()) as T);
}

/**
 * Runs `action` through `hooks` on copies: each input key is a hookView for the hooks, a hookCopy when the action
 * declares it mutable, and the after hooks get a hookView of `output(result)`. `impl` gets the merged input and the
 * caller its own result. Without a matching hook, `impl` runs on `input` and nothing is copied. `impl` reads the keys
 * it does not declare mutable from its own captured values, never from the merged input.
 */
export async function runHookedAction<A extends ActionName, R>(hooks: Hooks, action: A, input: InputOf<A>, impl: (input: InputOf<A>) => Promise<R>, opts: RunOptions<A> & { readonly output?: (result: R) => OutputOf<A> }): Promise<R> {
  if (!hooks.has(action)) return impl(input);
  const mutable = new Set<PropertyKey>(opts.mutable as readonly PropertyKey[]);
  const copies = Object.fromEntries(Object.entries(input as object).map(([k, v]) => [k, mutable.has(k) ? hookCopy(v) : hookView(v)])) as InputOf<A>;
  let result: R | undefined;
  await hooks.run(
    action,
    copies,
    async (merged) => {
      const r = await impl(merged);
      result = r;
      return hookView(opts.output ? opts.output(r) : (r as unknown as OutputOf<A>));
    },
    opts,
  );
  return result as R;
}

/**
 * `authn.admin.credentials`: an administrator acts on another user's credentials, through authn-http's credential admin
 * routes or users-http's admin routes that end a user's sessions or change its login. `actor` is the caller's
 * principal, its authn facts included, so a CredentialAdminRule can judge it.
 */
export interface CredentialAdminInput {
  readonly actor: Principal;
  readonly target: IdentityRef;
  readonly action: CredentialAdminAction;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    /** The output is the route's answer body; `{}` for a route that answers none. */
    'authn.admin.credentials': { input: CredentialAdminInput; output: Readonly<Record<string, unknown>> };
  }
}

/** The codes a CredentialAdminRule refuses with; `not_found` answers 404, the others 403. */
export type CredentialAdminRefusal = 'forbidden' | 'protected_role' | 'escalation' | 'not_found';
export type CredentialAdminVerdict = { readonly ok: true } | { readonly ok: false; readonly code: CredentialAdminRefusal };

export const CREDENTIAL_ADMIN_REFUSALS: ReadonlySet<string> = new Set<CredentialAdminRefusal>(['forbidden', 'protected_role', 'escalation', 'not_found']);

/** A CredentialAdminRule's `order`: before the hooks of the default order, so they only see actions a rule admitted. */
export const CREDENTIAL_ADMIN_RULE_ORDER = -1000;

/** The `target` copies of the runs a rule admitted; the action reads the same copy, so no other run can pass for one. */
const admitted = new WeakSet<object>();

/**
 * Who may administer whose credentials: a before hook on `authn.admin.credentials` that refuses with the code of its
 * verdict; any answer but `ok: true` refuses `forbidden`. users registers AuthzCredentialAdminRule.
 *
 * Fails closed: while no rule is registered the credential admin routes of authn-http are off (404), and an action no
 * rule admitted (none registered, or one registered after the hooks runner was resolved) is refused `forbidden`. The
 * routes find a rule by its class, so register it as a class: `@Injectable(ActionHook)`, not a factory.
 */
export abstract class CredentialAdminRule extends ActionHook<'authn.admin.credentials'> {
  readonly actions: readonly ActionPattern[] = ['authn.admin.credentials'];
  readonly order: number = CREDENTIAL_ADMIN_RULE_ORDER;

  /** `not_found` for a target the rule does not know; it answers 404, as an id that names no user does. */
  abstract allowed(actor: Principal, target: IdentityRef, action: CredentialAdminAction): Promise<CredentialAdminVerdict>;

  public async before(ctx: BeforeContext<'authn.admin.credentials'>): Promise<void> {
    const { actor, target, action } = ctx.input;
    const verdict: unknown = await this.allowed(actor, target, action);
    // A rule written past the types may answer anything; only `ok: true` admits.
    if ((verdict as { ok?: unknown } | null)?.ok !== true) ctx.refuse(credentialAdminRefusalOf(verdict));
    admitted.add(target);
  }
}

function credentialAdminRefusalOf(verdict: unknown): CredentialAdminRefusal {
  const code = (verdict as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CREDENTIAL_ADMIN_REFUSALS.has(code) ? (code as CredentialAdminRefusal) : 'forbidden';
}

/** True while `container` (or an ancestor) registers a CredentialAdminRule class as an ActionHook. */
export function credentialAdminRuleRegistered(container: IContainer): boolean {
  const types = (container.getRegisteredTypes(Array.chainOf(ActionHook)) ?? []) as unknown[];
  return types.some((t) => isConstructor(t) && t.prototype instanceof CredentialAdminRule);
}

const answerOf = (result: unknown): Readonly<Record<string, unknown>> => (result !== null && typeof result === 'object' && isPlainObject(result) ? (result as Readonly<Record<string, unknown>>) : {});

/**
 * Runs `effect` as `authn.admin.credentials` on copies of `input`, once a CredentialAdminRule admitted it. Without
 * one, the run throws `ActionRefused('authn.admin.credentials', 'forbidden')` and `effect` never runs. The after
 * hooks get `output(result)`, by default the result when it is a plain object and `{}` otherwise.
 */
export async function runCredentialAdmin<R>(hooks: Hooks, input: CredentialAdminInput, effect: () => Promise<R>, output: (result: R) => Readonly<Record<string, unknown>> = answerOf): Promise<R> {
  return runHookedAction(
    hooks,
    'authn.admin.credentials',
    input,
    async (merged) => {
      if (!admitted.has(merged.target)) throw new ActionRefused('authn.admin.credentials', 'forbidden', 'no credential admin rule admitted the action');
      return effect();
    },
    { mutable: [], output },
  );
}
