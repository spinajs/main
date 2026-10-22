# Action hooks

`@spinajs/authn` runs its critical actions through the [`@spinajs/hooks`](../hooks/README.md) runner. An `ActionHook` registered for one of them can change the inputs the action declares mutable, refuse the action, or observe its result and its errors. Use one to add an application rule to a login (a group sync, a sign-in window, an allow-list) without replacing the service.

## How it works

1. The action runs its own security checks first: the session state, the throttle, the identity status.
2. It calls `Hooks.run(action, input, impl, { mutable, refusable })`. With no matching hook (`Hooks.has(action)` is false) the action runs as is: no input, no copies, no runner call.
3. The `before` hooks run. They may change the mutable keys or refuse with `ctx.refuse(code)`.
4. The action runs with the merged input. A change to any other key is dropped.
   The values under the keys a hook may not change (the identity, the target, the session handles, the external subject, `ctx`) reach it as deep, frozen copies (`hookView`): a write in place throws in the hook, and the action only ever reads the values it held before the hooks ran. A mutable key (`credentials`, `attributes`) is a copy the hook may change (`hookCopy`).
   A value `structuredClone` cannot copy (a function, or a class instance such as an ORM model holding its container) is copied as far as it is plain data: plain objects, arrays, `Date`s, `Map`s and `Set`s become frozen copies (`ceiling.roles` included), and only the leaves that cannot be cloned are shared by reference, unfrozen. Such a leaf (for example `principal.identity`, the users `User` model) is the caller's object: a hook must not change it.
   A copy loses the getters of its class: a `Session` copied for a hook is plain data, without `state`, `impersonator` or `activeRole`. Read those from the session handle and facts in the input.
5. The `after` hooks see the input and the result, failure results included. The `failed` hooks see an error the action threw.
6. A refusal, or a `before` hook that throws or times out, never reaches the caller as an error. The action answers what it answers today for a refusal, and audits the real reason: `hook:<code>` for a refusal, `hook_error` for a hook that failed (its data names the hook class and `failure`: `error`, `timeout` or `depth`).

See [Writing a hook](../hooks/01-writing-a-hook.md) for the hook contract, ordering, timeouts and the depth limit.

## The authn actions

| Action | Entry point | Input | Mutable | Refusable | Refused answer |
| --- | --- | --- | --- | --- | --- |
| `authn.login` | `DefaultAuthnService.authenticate`, before the throttle and every strategy; not for `ctx.purpose: 'request'` | `credentials`, `ctx` | `credentials` | yes | `failure` `invalid_credentials`; `login` audited with `hook:<code>`; nothing counted, nothing verified |
| `authn.login.identified` | `authenticate`, after the identity and its status are known, before the MFA policy; interactive strategies only | `identity`, `strategy`, `method`, `external?`, `attributes`, `ctx` | `attributes` | yes | `failure` `invalid_credentials`; the throttle already counted; no session |
| `authn.mfa.verify` | `DefaultAuthnService.completeMfa`, after the throttle | `pending`, `step`, `response`, `ctx` | none | yes | The answer of a wrong code: `invalid_credentials`, the session stays pending; `mfa.verify` audited |
| `authn.reauth` | `DefaultAuthnService.reauthenticate`, after the throttle | `session`, `credentials`, `ctx` | none | yes | `false`; `reauth` audited |
| `authn.session.start` | `DefaultAuthnService.authenticate` (an interactive login) and `completeMfa`, once the active session is issued, before the success is audited; a pending login, a step-up and a re-authentication run none | `kind` (`login` or `mfa`), `session`, `principal`, `ctx`, `ceiling?` | `ceiling` | yes | `failure` `invalid_credentials`; the session is ended; `login` audited |
| `authn.session.stepUp` | `DefaultAuthnService.stepUp`, after the throttle | `session`, `step`, `response`, `ctx` | none | yes | The answer of a wrong code; no reissue; `mfa.verify` audited |
| `authn.impersonation.start` | `AuthnImpersonationService.start`, after every other check; it is the start check (no hook: every start is refused, `no_guard`) | `session`, `target`, `actor`, `ctx` | none | yes | `{ ok: false }`; `impersonation.start` audited |
| `authn.impersonation.stop` | `AuthnImpersonationService.stop` | `session`, `ctx` | none | no | none: a refusal is logged and the impersonation ends |
| `authn.link` | `AccountLinkService.link`, after the session and freshness checks | `session`, `external`, `ctx` | none | yes | `{ ok: false }`; `identity.link` audited; the link store is not touched |
| `authn.unlink` | `AccountLinkService.unlink`, after the session and freshness checks | `session`, `linkId`, `ctx` | none | yes | `{ ok: false }`; `identity.unlink` audited; the link store is not touched |
| `authn.logout.backchannel` | `@spinajs/authn-oidc`, `POST /auth/oidc/:provider/backchannel-logout`, after the logout token is validated | `provider`, `sid?`, `ctx` | none | no | none: a refusal is logged and the sessions are revoked |

The input and output types are exported from `@spinajs/authn` (`AuthnLoginInput`, `AuthnLoginIdentifiedInput`, and so on) and from `@spinajs/authn-oidc` (`AuthnLogoutBackchannelInput`).

## The `authn.login` timing rule

`authn.login` runs before the throttle and before the password hash is verified. A refusal there is fast, so its timing would tell an attacker what the hook decided. A hook on `authn.login` must therefore never branch on whether the account exists:

- Do: normalise the login name, refuse a credential kind, refuse outside a maintenance window.
- Don't: look the account up and refuse unknown or suspended ones. Put rules that need the account in `authn.login.identified`, which runs after the strategy verified the credentials, so a refusal there costs the same as a wrong password.

`authn.login` input carries the credentials and the context, never an identity. Per-request credentials (`ctx.purpose: 'request'`, a token or a key on every request) run neither `authn.login` nor `authn.login.identified`.

## `authn.login.identified`

This is where application login rules live:

- `identity`, `strategy` (the configured name, such as `local` or `oidc:corp`) and `method` describe the verified login.
- `external` is set for an external login (OIDC): the mapped subject with its claims, groups included.
- `attributes` are the strategy's principal attributes. A hook may replace them; they reach `PrincipalFactory` as `extra.attributes`, where a `PrincipalAttributeProvider` key still wins.
- A change to `identity`, `strategy`, `method`, `external` or `ctx` is dropped.

A refusal answers `invalid_credentials` and issues no session, not even a pending one. The throttle counted the attempt and gives nothing back. A login matched by verified email is linked only after the hooks pass. Hooks that ran before a refusing one keep their effects, so write hooks that are safe to run twice.

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import type { IdentityRef } from '@spinajs/authn';

export abstract class TeamDirectory {
  abstract syncGroups(user: IdentityRef, groups: readonly string[]): Promise<void>;
}

/** Syncs the IdP groups of every OIDC login, and refuses users the IdP suspended. */
@Injectable(ActionHook)
export class IdentityProviderGroups extends ActionHook<'authn.login.identified'> {
  readonly actions: readonly ActionPattern[] = ['authn.login.identified'];

  @Autoinject(TeamDirectory)
  protected Teams: TeamDirectory;

  async before(ctx: BeforeContext<'authn.login.identified'>): Promise<void> {
    const groups = ctx.input.external?.claims?.groups;
    if (!Array.isArray(groups)) return;
    if (groups.includes('suspended')) ctx.refuse('suspended_at_idp');
    // Replaces the whole set, so a retried login gives the same result.
    await this.Teams.syncGroups(ctx.input.identity, groups.filter((g): g is string => typeof g === 'string'));
  }
}
```

## `authn.session.start`

A login route (password, key, email code, passkey), the OIDC callback and an MFA completion all issue the active session through `DefaultAuthnService`, which runs `authn.session.start` on it before the login counts as a success. It replaces the `SessionStartHook` of 3.0.2, which authn-http asked only on its own routes, so the OIDC callback now starts narrowed too.

- `kind` is `login` or `mfa`; `session` is the new active session; `principal` is the principal the login answers with.
- A hook may set `ceiling` to `{ roles: [role] }`, or `{ roles: [] }` for no role. The session stores it as its `ActiveRole`, the key a role switch writes, so `GET /auth/active-role` shows it and every later request is narrowed by it. A later hook may overwrite what an earlier one set; check `ctx.input.ceiling` to keep the first choice, as `OrderedActiveRoleHook` of `@spinajs/users` does.
- A refusal, a hook that throws or times out, or a ceiling an `ActiveRole` cannot hold (two roles, an empty name, any field but `roles`) ends the session, and the login fails as a wrong password does: `invalid_credentials` over HTTP, the one failure answer in the OIDC callback. The `login` event carries `hook:<code>`, or `hook_error` (with `failure: 'ceiling'` for a ceiling it cannot hold).
- The output, which `after` hooks see, is the ceiling the session started with.

```ts sample
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import '@spinajs/authn';

/** Support staff start every session as `support`, whatever else they hold. */
@Injectable(ActionHook)
export class SupportFirst extends ActionHook<'authn.session.start'> {
  readonly actions: readonly ActionPattern[] = ['authn.session.start'];
  readonly order = -10;

  before(ctx: BeforeContext<'authn.session.start'>): void {
    if (ctx.input.ceiling === undefined && ctx.input.principal.attributes.team === 'support') ctx.input.ceiling = { roles: ['support'] };
  }
}
```

## `authn.impersonation.start`: the start check

`AuthnImpersonationService.start` no longer asks the `ImpersonationGuard`: the before hooks on `authn.impersonation.start` decide, after every other check (no nesting, fresh authentication, MFA, the status of both identities). Their input carries `actor`, the principal the guard used to judge: the actor's own facts through this session, narrowed by its role switch. With no hook on the action, every start is refused with `no_guard`. `@spinajs/users` registers `ImpersonationGuardStartHook`, which asks the registered `ImpersonationGuard` and refuses with its code (`hook:forbidden`, `hook:protected_role`, `hook:escalation`). The guard is still asked on every request of the impersonation session and ends it when it refuses.

## Non-refusable actions

`authn.impersonation.stop` and `authn.logout.backchannel` end sessions: an impersonator going back to their own session, an IdP that ended a session. A hook may observe them, but a refusal, a throw or a timeout in `before` is only logged on the `hooks` log, and the action completes.

## Running an action from another package

The helpers the core uses to run its actions are exported from `@spinajs/authn` and from the `@spinajs/authn/hooks` subpath. `@spinajs/authn-oidc` runs `authn.logout.backchannel` with them; use them when your package runs an action of its own the same way.

| Export | What it does |
| --- | --- |
| `hookView(value)` | A deep, frozen copy for a key hooks may not change. For a value `structuredClone` refuses, its plain data is copied and frozen and only the uncloneable leaves (class instances, functions) are shared, unfrozen. A primitive is returned as is. |
| `hookCopy(value)` | A deep copy for a mutable key; for a value `structuredClone` refuses, its plain data is copied and the uncloneable leaves are shared. A hook's in-place change to the plain data never reaches the caller's object. |
| `hookRefusalOf(err, action)` | Maps an error `Hooks.run(action, ...)` threw to an audit reason: `{ reason: 'hook:<code>' }` for an `ActionRefused`, `{ reason: 'hook_error', data: { hook, failure } }` for an `ActionHookFailed`. Returns `null` for any other error, and for a refusal or failure of another action (a nested run). |
| `HookRefusal` | The `{ reason, data? }` type `hookRefusalOf` returns. |
| `AuthnLoginInput`, `AuthnLoginIdentifiedInput`, `AuthnMfaVerifyInput`, `AuthnReauthInput`, `AuthnStepUpInput`, `AuthnSessionStartInput`, `AuthnImpersonationStartInput`, `AuthnImpersonationStopInput`, `AuthnLinkInput`, `AuthnUnlinkInput` | The input types of the authn actions. Importing the module also brings their `HookActions` declaration. |

The core follows the same steps for every action:

1. Ask `Hooks.has(action)`. With no matching hook, run the body directly: no input, no copies, no runner call.
2. Build the input from `hookView` copies of the fixed keys and `hookCopy` copies of the mutable keys.
3. Call `Hooks.run`. The body reads its fixed values from what it held before the run, and only the mutable keys from the merged input.
4. Catch the error and pass it to `hookRefusalOf`. A non-null answer is this action's refusal: audit its `reason` and `data`, and answer the action's refused answer. Rethrow or handle any other error as before.

```ts sample
import type { AuthnContext, IdentityRef } from '@spinajs/authn/contracts';
import { hookCopy, hookRefusalOf, hookView } from '@spinajs/authn/hooks';
import type { Hooks } from '@spinajs/hooks';

export interface DeviceTrustInput {
  readonly identity: IdentityRef;
  labels: Readonly<Record<string, string>>;
  readonly ctx: AuthnContext;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'devices.trust': { input: DeviceTrustInput; output: { ok: boolean } };
  }
}

export abstract class TrustedDevices {
  abstract trust(identity: IdentityRef, labels: Readonly<Record<string, string>>): Promise<void>;
}

/** Trusts a device for an identity; hooks may relabel it or refuse. */
export class DeviceTrust {
  constructor(
    private readonly hooks: Hooks,
    private readonly devices: TrustedDevices,
    private readonly audit: (reason: string, data?: Readonly<Record<string, unknown>>) => Promise<void>,
  ) {}

  async trust(identity: IdentityRef, labels: Record<string, string>, ctx: AuthnContext): Promise<{ ok: boolean }> {
    // The identity comes from the closure, never from the hooks' input.
    const body = async (input: DeviceTrustInput) => {
      await this.devices.trust(identity, input.labels);
      return { ok: true };
    };
    if (!this.hooks.has('devices.trust')) return body({ identity, labels, ctx });
    try {
      return await this.hooks.run('devices.trust', { identity: hookView(identity), labels: hookCopy(labels), ctx: hookView(ctx) }, body, { mutable: ['labels'] });
    } catch (err) {
      const refusal = hookRefusalOf(err, 'devices.trust');
      if (!refusal) throw err;
      await this.audit(refusal.reason, refusal.data);
      return { ok: false };
    }
  }
}
```

`@spinajs/authn/hooks` imports the `@spinajs/hooks` root, which registers `DefaultHooks` as `Hooks` and the `hooks.*` configuration schema.

## Related

- [`@spinajs/hooks`](../hooks/README.md): the runner, the hook contract and its configuration.
- [How a login runs](01-authentication-flow.md): where each action sits in the flow.
- [Integration hooks](12-integration-hooks.md): the provider contracts authn asks, such as `RoleSource`.
- [Audit events](06-audit-events.md): the events a refusal writes.
