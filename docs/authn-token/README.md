# `@spinajs/authn-token`

API tokens (`spt_…`) and JWT bearer authentication behind the [`@spinajs/authn`](../authn/README.md) contracts. It ships `DbTokenService` (the `TokenService` over the `rbac_access_tokens` table), the `token` and `jwt` strategies, the token CLI and the token migration.

It does **not** serve HTTP routes: the token routes and the header extractors live in [`@spinajs/authn-http`](../authn-http/README.md). It does **not** issue JWTs; it only verifies JWTs from issuers you trust. It does **not** decide what a token may do: [authorization](../authz/README.md) applies the token's ceiling at check time.

## Install

```sh
npm install @spinajs/authn-token
```

Import the package once in the app's bootstrap (`import '@spinajs/authn-token';`). The import registers `SecureRandomTokenProvider`, `DbTokenService`, `TokenStrategy`, `JwtBearerStrategy`, the default hooks, the `AccessToken` model and its migration. The strategies run only when listed in `authn.strategies`.

`DbTokenService` needs an `IdentityStore` (register one, for example by importing [`@spinajs/users`](../users/README.md)); without it the boot fails when the service or `TokenStrategy` is resolved.

## Features

| Feature | What it does |
| --- | --- |
| [Issuing and revoking tokens](01-token-service.md) | `DbTokenService`: create, list, revoke, revoke all, revoke by id and sweep expired tokens; plaintext shown once, SHA-256 stored, audit events. |
| [API token authentication](02-token-authentication.md) | `TokenStrategy`: verifies a `bearer` token per request, checks revocation, expiry and the owner, stamps the last use. |
| [Token roles, scopes and agent tokens](03-token-scopes.md) | How `roles`, `scope`, `profile` and `kind: 'agent'` become a ceiling and a delegation that authz enforces. |
| [JWT bearer](04-jwt-bearer.md) | `JwtBearerStrategy`: verifies JWTs from `authn.jwt.issuers` against a JWKS or fixed keys and maps the subject through identity links. |
| [Token storage and migrations](05-token-storage.md) | The `AccessToken` model, the `rbac_access_tokens` table, and its migration. |
| [CLI commands](06-cli-commands.md) | `authn:token-create`, `authn:token-delete` and `authn:token-delete-expired`. |
| [Token generation](07-token-generation.md) | `AccessTokenGenerationProvider`: the replaceable algorithm that mints and hashes tokens (`authn.token.generation.service`). |
| [Token owner resolver](08-token-owner-resolver.md) | `TokenOwnerResolver`: maps a token owner to `rbac_access_tokens.user_id` and back. |
| [Token profile policy](09-token-profile-policy.md) | `TokenProfilePolicy`: the profiles (role names) an owner may pin a token to. |

## Quick start

```ts sample
import '@spinajs/authn-token';
import '@spinajs/users';
import { TokenService } from '@spinajs/authn/contracts';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      authn: {
        strategies: [{ name: 'token', service: 'TokenStrategy' }],
        token: { maxTtlDays: 90 },
      },
    });
  }
}

const DAY_MS = 86_400_000;

/** Issues a 30-day deploy token for a user; the plaintext is returned once and never stored. */
export async function issueDeployToken(userUuid: string): Promise<string> {
  const tokens = await DI.resolve(TokenService);
  const now = new Date();
  const result = await tokens.create(
    { type: 'user', id: userUuid },
    { name: 'ci deploy', kind: 'service', expiresAt: new Date(now.getTime() + 30 * DAY_MS) },
    { now, purpose: 'request' },
  );
  if (!result.ok) {
    throw new Error(`token refused: ${result.code}`);
  }
  return result.plaintext;
}
```

The `AccessToken` model uses the ORM's `default` connection, and the table comes from the package's migration; see [Token storage and migrations](05-token-storage.md). A client then sends `Authorization: Bearer spt_…` or `x-api-key: spt_…`. `authn-http` turns either header into a `bearer` credential and `TokenStrategy` verifies it.

## Related packages

- [`@spinajs/authn`](../authn/README.md): the `TokenService`, `AuthenticationStrategy` and `IdentityStore` contracts, the [authentication flow](../authn/01-authentication-flow.md), [throttling](../authn/05-throttling.md) and the `authn.*` config schema.
- [`@spinajs/authn-http`](../authn-http/README.md): extracts `bearer` credentials from `Authorization` and `authn.token.headerName`, and serves `GET`, `POST` and `DELETE /user/tokens`.
- [`@spinajs/authn-orm`](../authn-orm/README.md): the [`authn_identity` links](../authn-orm/03-identity-links.md) that map a JWT subject to an identity, the audit sink and the throttle.
- [`@spinajs/authn-keys`](../authn-keys/README.md): client assertions (`typ: spinajs-client+jwt`), which `JwtBearerStrategy` refuses so they never pass as a bearer JWT.
- [`@spinajs/authz`](../authz/README.md): applies the token's ceiling (permission globs, resources, roles) and the agent delegation at check time.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): narrows a token principal's role assignments to `ceiling.roles`, `authz.token.excludedRoles` and the `TokenRolePolicy`.
- [`@spinajs/users`](../users/README.md): the `IdentityStore` and `RoleSource` this package asks on create and on every use.
- [`@spinajs/users-http`](../users-http/03-own-account.md): `GET /user/tokens/roles` and `GET /user/tokens/profiles`, the roles and profiles a new token may carry.
