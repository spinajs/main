# Login hooks

An `ActionHook` on `authn.login.identified` runs your code on every successful OIDC login, with the local identity and the mapped claims. Use it to sync IdP groups into authorization data, update a profile, or refuse a login on a claim. The action belongs to `@spinajs/authn` (see [Action hooks](../authn/14-action-hooks.md)) and the hook contract to [`@spinajs/hooks`](../hooks/README.md); this page covers what an OIDC login hands it, and the `authn.logout.backchannel` action this package adds.

## How it works

1. `OidcStrategy.verify()` answers the mapped `OidcExternalSubject` (see [Claims mapping](04-claims-mapping.md)).
2. `DefaultAuthnService` resolves the identity (see [Identity linking](05-identity-linking.md)) and checks its status.
3. It runs `authn.login.identified` through the `Hooks` runner. The input carries `identity`, `strategy` (`oidc:<name>`), `method`, `external` (the `OidcExternalSubject`), `attributes` and `ctx`.
4. The `before` hooks run in ascending `order`. A refusal (`ctx.refuse(code)`), a throw or a timeout stops the run: the login fails with the opaque answer, no session is issued, and the core audits one `login` failure with reason `hook:<code>` or `hook_error`.
5. When every hook passes, the core writes a pending email link, asks the `MfaPolicy` and issues the session. The `after` hooks then see the result.

The same action runs for every interactive login, a password login included; `input.external` is set only for an external one. Check `external?.provider` before you read OIDC claims.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Login hook | `ActionHook` (`@spinajs/hooks`), the type list read when `Hooks` boots | none | your hooks | `@Injectable(ActionHook)` on a subclass with `actions = ['authn.login.identified']`, or `DI.register(MyHook).as(ActionHook)`, before the app boots. Every matching registration runs. |
| Back-channel logout hook | `ActionHook` with `actions = ['authn.logout.backchannel']` | none | your hooks | As above. Observes a validated logout token; it cannot keep the sessions. |

For an OIDC login, `ctx.input.external` is an `OidcExternalSubject`: `provider` is `oidc:<name>`, and `claims` holds `name`, `groups` and `raw`.

### Login hook: custom implementation

```ts sample
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import type { ExternalSubject } from '@spinajs/authn';
import type { OidcExternalSubject } from '@spinajs/authn-oidc';

const isOidc = (e: ExternalSubject | undefined): e is OidcExternalSubject => e !== undefined && e.provider.startsWith('oidc:');

/** Refuses a sign-in from a user the IdP placed in the "suspended" group. */
@Injectable(ActionHook)
export class SuspendedGroupGuard extends ActionHook<'authn.login.identified'> {
  public readonly actions: readonly ActionPattern[] = ['authn.login.identified'];

  public before(ctx: BeforeContext<'authn.login.identified'>): void {
    const external = ctx.input.external;
    if (isOidc(external) && external.claims.groups?.includes('suspended')) {
      ctx.refuse('suspended_at_idp');
    }
  }
}
```

### `authn.logout.backchannel`

`POST /auth/oidc/:provider/backchannel-logout` runs it once the logout token is valid and its `jti` claimed, around the revocation (see [Back-channel logout](11-backchannel-logout.md)):

| Input | Meaning |
| --- | --- |
| `provider` | The strategy name the sessions carry, `oidc:<name>` |
| `sid` | The IdP session id; absent when the token names only `sub`, whose identity then loses every session |
| `ctx` | The request context: `now`, the client ip and user agent, `purpose: 'request'` |

It is not refusable: the IdP already ended the session. A refusal, a throw or a timeout in `before` is logged on the `hooks` log, and the sessions are revoked anyway. Use `after` to observe the logout, or `failed` to observe a revocation that threw.

## Important behaviour

- **Before MFA and the session.** A hook sees a login that passed every check, but no session exists yet.
- **A refusal fails the login.** The client gets the same answer as for a wrong password; the audit records `hook:<code>`, or `hook_error` for a hook that threw or timed out.
- **No rollback.** Hooks that ran before the refusing one keep their effects. An identity that JIT created for this login stays, with its link. A login matched by verified email is not linked when a hook refuses.
- **Hooks are read at boot.** Register them before the app boots; one registered later is not used.
- **`groups` absent is not `[]`.** An unmapped or missing groups claim leaves `claims.groups` out; treat that as "unknown", not "no groups".
- **`raw` holds the validated ID token claims and the userinfo claims it lacks**, never a token.
- **`authn` never imports `authz`.** Group sync to authorization is your hook's job.

## Best practices

- Make hooks idempotent: a later hook may refuse the login after yours ran, and the user retries.
- Check `external?.provider` before you read OIDC claims: password logins and other external strategies run the same action.
- Keep hooks fast: the user waits on the callback while they run, and `hooks.timeoutMs` bounds each call.
- Refuse with `ctx.refuse(code)`, not a throw: the audit then names your reason.

## Patterns and antipatterns

```ts
// Don't: an unmapped or missing claim reads as "no groups" and removes every membership
const groups = (ctx.input.external as OidcExternalSubject).claims.groups ?? [];
await syncMemberships(ctx.input.identity, groups);

// Do: leave memberships alone when the IdP said nothing
const groups = (ctx.input.external as OidcExternalSubject | undefined)?.claims.groups;
if (groups !== undefined) await syncMemberships(ctx.input.identity, groups);
```

## Examples

### Keep the display name in step with the IdP

```ts sample
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, AfterContext } from '@spinajs/hooks';
import type { OidcExternalSubject } from '@spinajs/authn-oidc';

/** Stand-in for your profile repository. */
const displayNames = new Map<string, string>();

/** After a successful OIDC login only: a refused or failed one changes nothing. */
@Injectable(ActionHook)
export class DisplayNameSync extends ActionHook<'authn.login.identified'> {
  public readonly actions: readonly ActionPattern[] = ['authn.login.identified'];

  public after(ctx: AfterContext<'authn.login.identified'>): void {
    const { identity, external } = ctx.input;
    if (ctx.output.status === 'failure' || !external?.provider.startsWith('oidc:')) return;
    const name = (external as OidcExternalSubject).claims.name;
    if (name !== undefined && displayNames.get(identity.id) !== name) {
      displayNames.set(identity.id, name);
    }
  }
}
```

## Related

- [`@spinajs/authn`, Action hooks](../authn/14-action-hooks.md): every authn action, its input and its refused answer.
- [`@spinajs/hooks`](../hooks/README.md): the hook contract, ordering, timeouts.
- [`@spinajs/authn`, How a login runs](../authn/01-authentication-flow.md): where the hooks sit in the core flow.
- [Claims mapping](04-claims-mapping.md): what `external.claims` holds.
- [Identity linking](05-identity-linking.md): which identity the hook receives.
- [Back-channel logout](11-backchannel-logout.md): the route that runs `authn.logout.backchannel`.
