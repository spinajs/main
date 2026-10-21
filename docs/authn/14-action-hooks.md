# Action hooks

`@spinajs/authn` runs its critical actions through the [`@spinajs/hooks`](../hooks/README.md) runner. An `ActionHook` registered for one of them can change the inputs the action declares mutable, refuse the action, or observe its result and its errors. Use one to add an application rule to a login (a group sync, a sign-in window, an allow-list) without replacing the service.

## How it works

1. The action runs its own security checks first: the session state, the throttle, the identity status.
2. It calls `Hooks.run(action, input, impl, { mutable, refusable })`. With no matching hook, `impl` runs at once and no context is built.
3. The `before` hooks run. They may change the mutable keys or refuse with `ctx.refuse(code)`.
4. The action runs with the merged input. A change to any other key is dropped.
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
| `authn.session.stepUp` | `DefaultAuthnService.stepUp`, after the throttle | `session`, `step`, `response`, `ctx` | none | yes | The answer of a wrong code; no reissue; `mfa.verify` audited |
| `authn.impersonation.start` | `AuthnImpersonationService.start`, after the guard and every other check | `session`, `target`, `ctx` | none | yes | `{ ok: false }`; `impersonation.start` audited |
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

## Non-refusable actions

`authn.impersonation.stop` and `authn.logout.backchannel` end sessions: an impersonator going back to their own session, an IdP that ended a session. A hook may observe them, but a refusal, a throw or a timeout in `before` is only logged on the `hooks` log, and the action completes.

## Related

- [`@spinajs/hooks`](../hooks/README.md): the runner, the hook contract and its configuration.
- [How a login runs](01-authentication-flow.md): where each action sits in the flow.
- [Integration hooks](12-integration-hooks.md): the provider contracts authn asks, such as `SessionStartHook`.
- [Audit events](06-audit-events.md): the events a refusal writes.
