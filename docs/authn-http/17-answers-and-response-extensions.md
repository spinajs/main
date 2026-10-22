# Answers and response extensions

Every route that authenticates someone answers with the same principal summary, which `AuthnResponseExtension` services can extend (`@spinajs/users` adds `Access`). Every failed authentication answers the same 401 body. The package exports that body and the session cookie helpers so other login routes, such as those of [`@spinajs/authn-oidc`](../authn-oidc/01-login-flow.md#http-routes), answer exactly like `POST /auth/login`.

## How it works

1. A route that authenticated a caller builds the principal summary from `Principal`.
2. It resolves every `AuthnResponseExtension` (`Array.ofType`) and calls `extend(kind, principal, body)` on each, in turn. `kind` names the route: `login`, `mfa`, `role-switch`, `impersonation` or `whoami`.
3. Each extension adds fields to `body`; the result is the 200 answer, with `Cache-Control: no-store` and, when a session was issued, the session cookie.

### The principal summary

```json
{
  "Identity": { "type": "user", "id": "6f1c..." },
  "Authn": {
    "method": "password",
    "strategy": "local",
    "assurance": "aal2",
    "mfa": ["totp"],
    "authenticatedAt": "2026-10-20T08:15:00.000Z",
    "impersonator": { "type": "user", "id": "a91e..." }
  }
}
```

`Authn` is `null` for a principal without authentication facts; `impersonator` appears only while impersonating. The summary never holds a session id, handle or storage key.

### The shared 401 body

`AUTHN_FAILURE_BODY` is defined in `@spinajs/authn/contracts` and re-exported by this package. It is frozen:

```json
{ "error": { "code": "E_AUTH_FAILED", "message": "login or password incorrect" }, "message": "login or password incorrect" }
```

`authnFailureResponse(retryAfterSeconds?, cookies?)` returns an `Unauthorized` response with that body and `Cache-Control: no-store`:

- `retryAfterSeconds` (a finite number) adds `Retry-After`, rounded up, never negative. Pass it only for a throttled login; a re-authentication never sends one.
- `cookies` are set on the answer, for example a cleared session cookie when a failed login ended the session it replaced.

### Session cookie helpers

| Function | Returns |
| --- | --- |
| `authnSessionCookie(config, handle)` | The session cookie for `handle`, for the `Coockies` response option: signed with `http.cookie.secret`, a browser-session cookie with the flags of the app env (an absent env counts as production), named and flagged by `authn.session.cookie`. |
| `authnClearedSessionCookie(config)` | The expired session cookie that clears it in the browser. |

Both build on `sessionCookie()` and `clearSessionCookie()` of [`@spinajs/authn-session`](../authn-session/README.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthnResponseExtension` (abstract, `@spinajs/authn/contracts`) | `Array.ofType`, resolved per answer; every registered one runs | none in this package | `AccessResponseExtension` of `@spinajs/users` adds `Access` | Extend it, implement `extend()`, `DI.register(Mine).as(AuthnResponseExtension)`. |

### `AuthnResponseExtension`: custom implementation

Add fields the client needs right after login, so it does not need a second request. Keep the work small: it runs on every login, MFA completion, role switch, impersonation and `GET /auth`.

```ts sample
import { DI } from '@spinajs/di';
import { AuthnResponseExtension } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authn/contracts';

/** Tells the client to show the new terms of service before anything else. */
export class TermsResponseExtension extends AuthnResponseExtension {
  public async extend(kind: 'login' | 'mfa' | 'role-switch' | 'impersonation' | 'whoami', principal: Principal, body: Record<string, unknown>): Promise<void> {
    if (kind === 'role-switch' || kind === 'impersonation') return;
    body.MustAcceptTerms = principal.attributes.termsVersion !== '2026-10';
  }
}

DI.register(TermsResponseExtension).as(AuthnResponseExtension);
```

## Important behaviour

- Extensions run in turn on the same `body`; a later one sees and may overwrite what an earlier one added.
- An extension that throws fails the request. A session that login already issued is not revoked, but its cookie never reaches the client.
- The 401 body is one for every reason: unknown login, wrong password, wrong code, banned account. Do not add a reason to it.

## Best practices

- Build your own login routes (magic link, SSO) with `authnFailureResponse()`, `authnSessionCookie()` and `authnClearedSessionCookie()`, so clients see one answer format.
- Never put the session id or handle in an extension's fields.

## Examples

### A magic-link login route that answers like `POST /auth/login`

```ts sample
import '@spinajs/authn-http';
import { ClientContext, authnFailureResponse, authnSessionCookie } from '@spinajs/authn-http';
import type { AuthnClientContext } from '@spinajs/authn-http';
import { AuthnService } from '@spinajs/authn/contracts';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, BasePath, Body, OnError, Ok, Post } from '@spinajs/http';
import { Schema, ValidationFailed } from '@spinajs/validation';

const NO_STORE = { Name: 'Cache-Control', Value: 'no-store' };

// An `authn.` id is validated without type coercion.
@Schema({
  $id: 'authn.magicLink.RedeemBody',
  type: 'object',
  required: ['token'],
  additionalProperties: false,
  properties: { token: { type: 'string', minLength: 1, maxLength: 1024 } },
})
export class MagicLinkRedeemBody {
  public token!: string;

  constructor(data: object) {
    Object.assign(this, data);
  }
}

@BasePath('auth/magic-link')
export class MagicLinkController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Post('redeem')
  // A refused body answers like a wrong token.
  @OnError([ValidationFailed, InvalidArgument], () => authnFailureResponse(), { stages: ['arguments'] })
  public async redeem(@Body({ required: true }) body: MagicLinkRedeemBody, @ClientContext() client: AuthnClientContext) {
    const token = body.token;
    const authn = await this.Container.resolve(AuthnService);
    const ip = client.ip;
    const result = await authn.authenticate({ kind: 'external', provider: 'magic-link', payload: { token } }, { ...(ip ? { ip } : {}), now: new Date(), purpose: 'login' });
    if (result.status === 'failure') return authnFailureResponse(result.reason === 'throttled' ? result.retryAfterSeconds : undefined);
    if (result.status === 'mfa_required') {
      return new Ok({ MfaRequired: [...result.steps] }, { Coockies: [authnSessionCookie(this._cfg, result.pending)], Headers: [NO_STORE] });
    }
    if (!result.session) return authnFailureResponse();
    const principal = await authn.principalOf(result);
    return new Ok({ Identity: { type: principal.type, id: principal.id } }, { Coockies: [authnSessionCookie(this._cfg, result.session)], Headers: [NO_STORE] });
  }
}
```

A strategy that accepts `{ kind: 'external', provider: 'magic-link' }` credentials must be listed in `authn.strategies`; see [`@spinajs/authn`: strategies](../authn/03-strategies.md).

## Related

- [Login, logout and MFA routes](08-login-logout-and-mfa-routes.md): the routes that use these answers.
- [`@spinajs/users`: role switch and access response](../users/14-role-switch-and-access-response.md): `AccessResponseExtension`.
- [`@spinajs/authn-oidc`](../authn-oidc/README.md): OIDC routes built on the same helpers.
- [Responses in `@spinajs/http`](../http/10-responses.md): `Ok`, `Unauthorized` and the `Coockies` option.
