# RFC SO-2: the session class resolves through DI

Status: APPLIED on feat/authz-v3 (plan docs/superpowers/plans/2026-10-16-session-di.md).

## Problem

SO-1 made `restore` return a `Session`, built with `new Session(...)` in each issuer and entry point. An app could
not add typed reads of its own data keys without wrapping every session it reads.

## Change

- `Session` is `@NewInstance()`; the contracts still register nothing at load.
- New `resolveSession(container, value)`: `value` when it is a `Session`, else the class registered as `Session` in
  `container` (`Session` itself when none is), built with `value`. It throws when that class resolves to a non-Session
  (an AsyncService dependency) or hands back a shared instance (no `@NewInstance()`).
- `DefaultSessionIssuer`, `MemorySessionIssuer` (new option `container`, default the root container), the authn
  middleware, the socket session source and the impersonation service build sessions through it.

## Affected lanes

- Apps: `container.register(AppSession).as(Session)`; subclass rules in `packages/authn-session/README.md`.
- Third-party `SessionIssuer` implementations should build through `resolveSession` so a registered class applies.
