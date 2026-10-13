# Account linking

An identity can hold several external subjects (an OIDC account, a JWT
issuer's subject), stored as links in `authn_identity`. There are two ways a
link appears:

- **At login.** `DefaultAuthnService` links or provisions when an external
  login arrives, under the switches below.
- **Explicitly.** A signed-in user attaches or removes a link on purpose.
  `AccountLinkService` owns this path and is what this README describes.

## What it provides

- `AccountLinkService.link(session, external, ctx, reauth?)` resolves to a
  `LinkResult`: `{ ok: true, link }` or `{ ok: false }`.
- `AccountLinkService.unlink(session, linkId, ctx, reauth?)` resolves to
  `{ ok: boolean }`.
- `IdentityLinkStore` (`contracts/link.ts`): `find(provider, subject)`,
  `list(identity)`, `link(identity, external)` and `unlink(id)`. The pair
  `(provider, subject)` is unique. authn-orm's `DbIdentityLinkStore` keeps
  them in `authn_identity`.
- `linkingSwitchesOf(strategy, external)` and the `ExternalLinkingStrategy`
  interface: the per-provider login switches described below.

Refusals answer `{ ok: false }` only, so the answer never tells whether a
subject is linked to someone else. The reason goes to the audit event
(`identity.link` or `identity.unlink`, outcome `failure`, `reason`):

| Reason | Meaning |
| --- | --- |
| `not_active` | No such session, or it is not `active` (a pending session cannot link). |
| `wrong_purpose` | `ctx.purpose` is not `'link'`. |
| `impersonating` | The session is an impersonation: an impersonator must not attach a login of their own. |
| `unknown_identity`, `deleted`, `banned`, `inactive` | The holder may not log in. |
| `not_fresh` | The session is stale and `reauth` is missing or fails. |
| `invalid_subject` | `external` has no provider or subject. |
| `already_linked`, `linked_elsewhere` | The subject is linked to this identity, or to another. |
| `unknown_link` | `linkId` is not among the holder's own links. |
| `last_credential` | Unlinking would leave no way to sign in. |
| `store_error` | A store threw; `data.error` holds the error class. |

## DI registration

`AccountLinkService` is a `@PerChildInstance()` `AsyncService`, one per
container. Neighbours resolved at start:

| Neighbour | How | If missing |
| --- | --- | --- |
| `IdentityLinkStore`, `SessionIssuer`, `IdentityStore` | `resolve(T, true)` | boot fails |
| `FreshAuthCheck`, `AuthnAudit` | `resolve(T)` | in `@spinajs/authn` itself |
| `PasswordCredentialStore` | `resolveOptional(T)` | a password is not counted as a credential |
| `KeyRegistry` | `resolveOptional(T)` | keys are not counted as credentials |

## Flow

Both calls need the identity's own active session. An impersonation does not
qualify, and the context must say `purpose: 'link'`. The holder's status is
checked as at login. The session must be fresh within
`authn.freshAuth.maxAgeSeconds`, or `reauth` must re-authenticate it (see
[fresh authentication](../freshauth/README.md)); a successful `reauth` counts
for this call only.

`link` then checks the subject and that it is not linked yet, and writes the
link. The store's unique index decides a race between two links of one
subject. `external` must come from a verified external login (the OIDC
callback does that): this service cannot check that the caller controls the
subject.

`unlink` finds the link among the holder's own links, never by id alone, and
refuses to remove the last usable credential. Another link counts, as does a
password hash (when a `PasswordCredentialStore` is registered) and a key that
is neither revoked nor expired (when a `KeyRegistry` is). "Usable" means
present: a link whose provider is no longer configured still counts. Unlinks
of one identity in a process run one at a time; across processes the link
store must guard the check and the delete.

```ts
import type { AccountLinkService, AuthnContext, Credentials, ExternalSubject, IdentityLink, SessionHandle } from '@spinajs/authn';

async function linkProvider(links: AccountLinkService, session: SessionHandle, external: ExternalSubject, ctx: AuthnContext, reauth?: Credentials): Promise<IdentityLink | null> {
  const linked = await links.link(session, external, { ...ctx, purpose: 'link' }, reauth);
  return linked.ok ? linked.link : null;
}
```

## HTTP

`@spinajs/authn-http` has no link routes. `@spinajs/authn-oidc` serves them
through `OidcController`, and delegates to this service through
`OidcAccountLinks` (default `CoreOidcAccountLinks`):

- `POST auth/oidc/:provider/link` starts a link flow bound to the current
  session; the provider's callback finishes it with `link(...)`.
- `DELETE auth/oidc/:provider/link` unlinks the provider (`?subject=` names
  one when there are several): 204, 401 without a session, 404 when nothing is
  linked, 409 when several match, 403 when the service refuses.

Without an `OidcAccountLinks` registration these routes answer 404. See
[oidc.md](../../../../docs/authn/oidc.md).

## Configuration

`authn.linking.*` does not touch explicit linking. It governs what an
external login may do on its own:

| Key | Default | Meaning |
| --- | --- | --- |
| `authn.linking.jit` | `false` | A login with no link may provision a new identity through `IdentityStore.provision`. |
| `authn.linking.byVerifiedEmail` | `false` | A login with no link may attach to the identity with the same verified email. |

A login links only when this global switch and the strategy's own switch for
that provider are both on (an OIDC provider's `linking`, a JWT issuer's
`linking.jit`). A strategy exposes its switches with `linkingFor(external)`
(`ExternalLinkingStrategy`); `linkingSwitchesOf` reads it and answers off for
a strategy that has none, answers anything but booleans or throws. Turning
JIT on for one provider never opens another.
