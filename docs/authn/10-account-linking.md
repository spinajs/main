# Account linking

An identity can hold several external subjects: an OIDC account, a JWT issuer's subject. Each is an `IdentityLink` in an `IdentityLinkStore`. A link appears in two ways: at login, under the `authn.linking` switches, or on purpose, through `AccountLinkService`.

## How it works

### Linking at login

When a strategy answers an `external` subject, `DefaultAuthnService` resolves it:

1. `IdentityLinkStore.find(provider, subject)`: an existing link logs in as its identity. No switch is asked.
2. **By verified email**, when `authn.linking.byVerifiedEmail` is on **and** the strategy's own switch for that provider is on **and** the subject's `emailVerified` is `true`. `IdentityStore.findByLogin(email)` finds a candidate, and `IdentityStore.display(id).email` must equal the email, ASCII letters compared without case. A login name that happens to match is not enough.
3. **JIT provisioning**, when `authn.linking.jit` is on **and** the strategy's own `jit` switch is on **and** the `IdentityStore` implements `provision`. A provisioned identity is linked at once, even when its status then refuses the login, so a retry does not provision again.
4. Otherwise the login fails with `not_linked`. Without an `IdentityLinkStore` every external login is `not_linked`.

A link by verified email is written only after the status check and the `authn.login.identified` [action hooks](14-action-hooks.md) pass. Each new link audits `identity.link`.

The strategy's own switches come from `linkingFor(external)` (`ExternalLinkingStrategy`), read by `linkingSwitchesOf(strategy, external)`. A strategy without `linkingFor`, or one that throws or answers non-booleans, has both switches off. Turning JIT on for one provider never opens another.

### Linking on purpose: `AccountLinkService`

`link(session, external, ctx, reauth?)` and `unlink(session, linkId, ctx, reauth?)` both:

1. Restore the session. It must be `active` and not an impersonation.
2. Require `ctx.purpose === 'link'`.
3. Check the holder's status as at login.
4. Require fresh authentication through `FreshAuthCheck`, or a successful `reauth`.

Then the `authn.link` or `authn.unlink` [action hooks](14-action-hooks.md) run around the rest. A refusal, or a hook that fails, answers `{ ok: false }` with reason `hook:<code>` or `hook_error`, before the link store is asked anything.

`link` checks that `external` has a provider and a subject and is not linked yet, and writes the link. The store's unique `(provider, subject)` index decides a race between two links of one subject.

`unlink` finds the link among the holder's own links, never by id alone. It refuses to remove the last usable credential: another link, a password hash (when a `PasswordCredentialStore` is registered) or a key that is neither revoked nor expired (when a `KeyRegistry` is registered). Unlinks of one identity run one at a time within a process.

Refusals answer `{ ok: false }` only, so the answer never tells whether a subject is linked to someone else. The reason goes to the `identity.link` or `identity.unlink` event:

| Reason | Meaning |
| --- | --- |
| `not_active` | No such session, or it is not `active` |
| `wrong_purpose` | `ctx.purpose` is not `'link'` |
| `impersonating` | The session is an impersonation |
| `unknown_identity`, `deleted`, `banned`, `inactive` | The holder may not log in |
| `not_fresh` | The session is stale and `reauth` is missing or fails |
| `invalid_subject` | `external` has no provider or subject |
| `already_linked`, `linked_elsewhere` | The subject is linked to this identity, or to another |
| `unknown_link` | `linkId` is not among the holder's links |
| `last_credential` | Unlinking would leave no way to sign in |
| `store_error` | A store threw; `data.error` holds the error class |
| `hook:<code>`, `hook_error` | An `authn.link` or `authn.unlink` hook refused or failed |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.linking.jit` | `boolean` | `false` | | A login with no link may provision a new identity |
| `authn.linking.byVerifiedEmail` | `boolean` | `false` | | A login with no link may attach to the identity with the same verified email |

```ts
authn: { linking: { jit: false, byVerifiedEmail: true } }
```

These keys do not touch `AccountLinkService`. The core reads them when it decides, and takes only `true` as on.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `IdentityLinkStore` | `IdentityLinkStore`; optional for login, required by `AccountLinkService` | None in the core | `DbIdentityLinkStore` ([`@spinajs/authn-orm`](../authn-orm/README.md)) | `@Injectable(IdentityLinkStore)`; keep `(provider, subject)` unique |
| `AccountLinkService` | Class token, per child container | `AccountLinkService` | None | Not meant to be replaced |
| `ExternalLinkingStrategy` | Interface on a strategy | None | `OidcStrategy`, `JwtBearerStrategy` | Implement `linkingFor(external)` on your strategy |

Across processes, the link store must guard the check and the delete of an unlink itself.

## Important behaviour

- `AccountLinkService` cannot check that the caller controls `external`. Pass only a subject from a verified external login, such as the OIDC callback.
- Usable means present: a link whose provider is no longer configured, or a password with no listed strategy for it, still counts as a credential.
- An impersonator can neither link nor unlink.

## Best practices

- Turn on `byVerifiedEmail` only for providers that verify emails, and only on those providers' own switch.
- Keep `jit` off unless the `IdentityStore` creates accounts the way your sign-up does.

## Examples

### Link an OIDC account to the signed-in user

```ts sample
import type { AccountLinkService, AuthnContext, Credentials, ExternalSubject, IdentityLink, SessionHandle } from '@spinajs/authn';

export async function linkProvider(links: AccountLinkService, session: SessionHandle, external: ExternalSubject, ctx: AuthnContext, reauth?: Credentials): Promise<IdentityLink | null> {
  const linked = await links.link(session, external, { ...ctx, purpose: 'link' }, reauth);
  return linked.ok ? linked.link : null;
}
```

## Related

- [`@spinajs/authn-oidc`](../authn-oidc/README.md): the link routes and the per-provider switches.
- [`@spinajs/authn-token`](../authn-token/README.md): JWT issuers and their `linking.jit` switch.
- [Fresh authentication](09-fresh-authentication.md): what `not_fresh` means.
