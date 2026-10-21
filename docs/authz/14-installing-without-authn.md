# Installing authz without authn

`@spinajs/authz` does not need `@spinajs/authn`. The principal contracts that every check takes live in their own package, `@spinajs/principal`, which has no dependencies. An app that authenticates its own way (an API gateway header, a host app's session, a job runner) installs authz alone and builds `Principal` objects itself.

## What lives where

| Package | Holds | Depends on authn |
| --- | --- | --- |
| `@spinajs/principal` | `Principal`, `PrincipalRef`, `PrincipalType`, `ResourceRef`, `ResourceType`, `Ceiling`, `AuthnFacts`, `IAuthnPrincipalStorage`, `SYSTEM`, `UNATTENDED`, `principalKey`, `sameRef`, `ceilingHash` | No |
| `@spinajs/authz` | Re-exports the principal contracts (except `sameRef`) next to the engine | No |
| `@spinajs/authn/contracts` | Re-exports every principal name next to the authn contracts | It is authn |
| `@spinajs/authz-http` | Route guards, principal sources, `/user/access`, access events | Optional peer |
| `@spinajs/authz-http/authn` | `SseSessionEndSink`, which ends event streams when authn ends a session | Yes |

The re-exports are the same objects, not copies. `SYSTEM` and `UNATTENDED` are recognised by identity, so `SYSTEM` from `@spinajs/authz`, `@spinajs/authn/contracts` and `@spinajs/principal` is one value, in the ESM build and in the CJS build alike. Existing imports from `@spinajs/authn/contracts` or `@spinajs/authz` keep working.

## Install

```sh
npm install @spinajs/authz @spinajs/authz-http
```

npm does not install `@spinajs/authn` with them. Import the principal types from `@spinajs/authz`, or from `@spinajs/principal` in a package that does not need the engine:

```ts sample
import type { Principal } from '@spinajs/authz';

export function gatewayPrincipal(userId: string, roles: readonly string[]): Principal {
  return { type: 'user', id: userId, authenticated: true, source: 'gateway', attributes: { roles } };
}
```

Hand the principal to authz the way your HTTP layer expects. In `@spinajs/authz-http` that means a principal source: see [principal sources](../authz-http/04-principal-sources.md).

## With authn installed

With `@spinajs/authn` installed, `@spinajs/authz-http` also ends a session's access-event streams when authn reports that the session ended. The root entry registers `AuthzHttpAuthnBootstrapper`. When the app runs its bootstrappers, it loads `@spinajs/authz-http/authn`, which registers `SseSessionEndSink` as an `AuthnEventSink`. Without authn, the bootstrapper does nothing.

A process that does not run the bootstrappers before authn builds its audit (a test harness, a custom boot) imports the subpath itself, before the first authentication event:

```ts sample
import '@spinajs/authz-http/authn';
```

`SseSessionEndSink` is exported only from `@spinajs/authz-http/authn`. The root entry no longer exports it.

## How the boundary is checked

`npm run deps` runs the dependency-cruiser rule `authz-not-to-authn`: no source file of an `authz*` package may import an `authn*` package, except files under `packages/authz-http/src/authn/`. The authz contract tests also check that `@spinajs/authz` lists no `@spinajs/authn` dependency.
