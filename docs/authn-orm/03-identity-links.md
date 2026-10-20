# Identity links

`DbIdentityLinkStore` is the `IdentityLinkStore` of `@spinajs/authn`. It maps an external subject, such as an OIDC `sub` or a JWT issuer's subject, to one identity of the app. One identity can have many links; one `(provider, subject)` pair belongs to one identity.

## Where it runs in the authn flow

Callers resolve the `IdentityLinkStore` port of `@spinajs/authn`; this package registers `DbIdentityLinkStore` under it.

| Caller | Methods | When it calls |
| --- | --- | --- |
| `DefaultAuthnService` ([`@spinajs/authn`](../authn/01-authentication-flow.md)) | `find`, `link` | Login step 4: a strategy answered an external subject. `find` maps it to an identity; a login by verified email or JIT provisioning then calls `link`. `reauthenticate` also maps an external subject through `find`. |
| `AccountLinkService` ([`@spinajs/authn`](../authn/README.md)) | `find`, `link`, `list`, `unlink` | A signed-in user links or unlinks an external account. |
| `OidcStrategy` and `OidcController` ([`@spinajs/authn-oidc`](../authn-oidc/README.md)) | `find`, `list` | Login step 3: the OIDC callback checks with `find` whether the subject is linked before it answers it. `DELETE /auth/oidc/:provider/link` lists the identity's links to pick the one `AccountLinkService` removes. |
| `JwtBearerStrategy` ([`@spinajs/authn-token`](../authn-token/README.md)) | none directly | It answers the token's subject as an external subject; `DefaultAuthnService` maps it in step 4. |

`DefaultAuthnService` takes the store as optional: without a registered `IdentityLinkStore`, an external subject maps to no identity and the login fails as `not_linked`.

## How it works

### Find, `find(provider, subject)`

1. The store awaits `ormReady()` and selects the `authn_identity` rows with that `provider` and `subject`.
2. It keeps only the row whose `provider` and `subject` equal the input exactly in Node.
3. It resolves with an `IdentityLink`, or `null`.

### List, `list(identity)`

1. The store checks the identity: a type of 1 to 16 characters without `:`, and an id of 1 to 64 characters. A bad one throws `InvalidArgument`.
2. It selects the rows with that `identity_type` and `identity_id`, ordered by `linked_at`, and keeps the exact matches.

### Link, `link(identity, external)`

1. The store checks the identity as in `list`, then `external.provider` (1 to 128 characters), `external.subject` (1 to 255) and `external.email` (0 to 255, optional). A bad value throws `InvalidArgument`; nothing is truncated.
2. It takes "now" from the Node clock and awaits `ormReady()`.
3. `AuthnIdentity.insert()` writes a row with a random UUID `id`, `email_verified` = `external.emailVerified === true`, `attributes` `NULL` and `linked_at` = now.
4. A duplicate `(provider, subject)` makes the unique index refuse the insert (`UniqueViolation`); the store rejects with `ResourceDuplicated`.
5. It resolves with the new `IdentityLink`.

### Unlink, `unlink(id)`, and touch, `touch(id, at?)`

1. `unlink(id)` deletes the row with that link id. It does not check whether the identity keeps another way to sign in; `AccountLinkService` does that before it calls the store.
2. `touch(id, at = new Date())` sets `last_used_at` and resolves `true` when a row with that id exists. `touch` is not part of the `IdentityLinkStore` contract, and no shipped package calls it: `last_used_at` stays `NULL` unless your code calls `touch`.

## Configuration

`DbIdentityLinkStore` reads no key. The core decides when a login may create a link:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.linking.jit` | `boolean` | `false` | | Lets a login provision and link an unknown external subject. Read by `DefaultAuthnService`. |
| `authn.linking.byVerifiedEmail` | `boolean` | `false` | | Lets a login link a subject by a verified email the identity store holds. Read by `DefaultAuthnService`. |

A login links only when the strategy's own switch is on too; see [`@spinajs/authn` Config](../authn/13-configuration-and-boot-checks.md).

## Schema

### `authn_identity`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key | Random UUID; the link id `unlink` and `touch` take. |
| `identity_type` | `varchar(16)` | `IdentityRef.type`, for example `user`. |
| `identity_id` | `varchar(64)` | `IdentityRef.id`, for example `users.Uuid`. |
| `provider` | `varchar(128)` | The external provider, for example `jwt:<issuer>`. |
| `subject` | `varchar(255)` | The subject at that provider. |
| `email` | `varchar(255)`, nullable | Email the provider reported at link time. |
| `email_verified` | `boolean`, default `0` | The provider's verified flag at link time. Not returned in `IdentityLink`. |
| `attributes` | `text`, nullable | Written `NULL`; `external.claims` is not stored. |
| `linked_at` | `datetime` | Time of `link`. |
| `last_used_at` | `datetime`, nullable | Set by `touch`. |

Unique index `authn_identity_subject` covers `(provider, subject)`; index `authn_identity_owner` covers `(identity_type, identity_id)`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Link store | `IdentityLinkStore`, per child container; also registered as `DbIdentityLinkStore` | `DbIdentityLinkStore` | none shipped | Register your class under `IdentityLinkStore` after this package is imported: a single resolve takes the last registration. Subclass `DbIdentityLinkStore` to keep the storage. |

### Link store: custom implementation

Subclass `DbIdentityLinkStore`, override the contract methods you need, and register the subclass with `@Injectable(IdentityLinkStore)`.

```ts sample
import { DbIdentityLinkStore } from '@spinajs/authn-orm';
import { IdentityLinkStore } from '@spinajs/authn/contracts';
import type { IdentityLink } from '@spinajs/authn/contracts';
import { Injectable, PerChildInstance } from '@spinajs/di';

/** Stamps last_used_at whenever a login finds a link, for the "last used" column of the account page. */
@PerChildInstance()
@Injectable(IdentityLinkStore)
export class LastUsedLinkStore extends DbIdentityLinkStore {
  public override async find(provider: string, subject: string): Promise<IdentityLink | null> {
    const link = await super.find(provider, subject);
    if (link) {
      await this.touch(link.id);
    }
    return link;
  }
}
```

## Important behaviour

- `(provider, subject)` is unique: of parallel `link` calls for one pair, one succeeds and the others reject with `ResourceDuplicated`.
- On MySQL and MSSQL the default collations ignore case, accents and trailing spaces. `find` and `list` therefore check every value for exact equality in Node, so a subject differing only that way never signs in as another account. The unique index still follows the collation, so such a subject cannot be linked either.
- `find` checks no lengths: a value longer than its column finds nothing.
- `IdentityLink.email` and `lastUsedAt` are present only when the row has them. `emailVerified` and the claims are not returned.
- `link` and `touch` take their time from Node; a `Date` outside the years 1000 to 9999 throws `InvalidArgument`.

## Best practices

- Unlink through `AccountLinkService`, not the store: the store removes the last credential of an identity without asking.
- Use a stable `provider` name per issuer (`jwt:<issuer>` is the JWT default): renaming it orphans every existing link.

## Patterns and antipatterns

```ts
// Don't: the store answers by exact value, so a lower-cased subject is another subject
const link = await links.find('oidc:google', subject.toLowerCase());

// Do: pass the subject exactly as the provider issued it
const link = await links.find('oidc:google', subject);
```

## Examples

### List the linked sign-in providers on an account page

```ts sample
import { IdentityLinkStore } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';

export async function linkedProviders(userUuid: string): Promise<string[]> {
  const links = await DI.resolve(IdentityLinkStore);
  const rows = await links.list({ type: 'user', id: userUuid });
  return rows.map((l) => `${l.provider} since ${l.linkedAt.toISOString()}`);
}
```

### Link a service account to a CI issuer's subject

```ts sample
import { IdentityLinkStore } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';
import { ResourceDuplicated } from '@spinajs/exceptions';

/** Lets the CI pipeline's JWT sign in as service `deployer`; a second run is a no-op. */
export async function linkDeployPipeline(issuer: string, subject: string): Promise<boolean> {
  const links = await DI.resolve(IdentityLinkStore);
  try {
    await links.link({ type: 'service', id: 'deployer' }, { provider: `jwt:${issuer}`, subject });
    return true;
  } catch (err) {
    if (err instanceof ResourceDuplicated) return false;
    throw err;
  }
}
```

## Related

- [`@spinajs/authn` How a login runs](../authn/01-authentication-flow.md): step 4 maps an external subject through this store.
- [`@spinajs/authn-oidc`](../authn-oidc/README.md): links OIDC subjects and reads them on login.
- [`@spinajs/authn-token`](../authn-token/README.md): JWT bearer subjects that the core maps through this store.
- [Models and schema](07-models-and-schema.md#authn_identity): the `AuthnIdentity` model.
