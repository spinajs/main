# SO-1: `SessionIssuer.restore` returns a `Session`

Status: proposed (2026-10-16). Plan: `docs/superpowers/plans/2026-10-16-session-object.md`.

## Problem

`restore` returned an anonymous `{ handle; identity; facts; data: ReadonlyMap<string, unknown> }`. Every reader of
session data repeated its own key constant and shape check (`ActiveRole` in `activeRoleCeiling` and the active-role
controller, the impersonation block in the service and a duplicate key in its controller, pending steps in the
routes), and `req.storage.AuthnSession` was typed through `ReturnType<SessionIssuer['restore']>`.

## Change

New file in the frozen contracts entry, `packages/authn/src/contracts/session-state.ts`:

- `SessionKey<T>` (`name`, `decode`) and `sessionKey(name, decode)`: apps define their own typed keys.
- `SessionKeys`: `ActiveRole`, `Impersonation`, `Ip`, `UserAgent`, `PendingSteps` (`authn:pendingSteps`). Stored
  names and value shapes are unchanged.
- `ImpersonationBlock`, `SessionInit`.
- `class Session`: the own fields `handle`, `identity`, `facts`, `data` (as before), the getters `state`,
  `impersonator`, `activeRole`, `impersonation`, `ip`, `userAgent`, `pendingSteps`, and `get(key)` / `has(key)`.

`SessionIssuer.restore(rawId)` returns `Promise<Session | null>`. In `@spinajs/authn-http`,
`IActionLocalStoregeContext.AuthnSession` is `Session | null`.

Not in the snapshot, but a public signature: `activeRoleCeiling(session: Pick<Session, 'activeRole'>)` in
`@spinajs/authn` replaces `activeRoleCeiling(data: ReadonlyMap<string, unknown>)`.

Readers of `.handle`, `.identity`, `.facts` and `.data` keep compiling. Implementations of `SessionIssuer` and object
literals typed as the restored session must construct a `Session`.

One behaviour change: `GET auth/active-role` answers `ActiveRole: ''` instead of `null` for a stored value no role switch
writes, which matches the principal (narrowed to no role).

## Affected lanes

- authn-session (`DefaultSessionIssuer`), authn-testing (`MemorySessionIssuer`): construct `Session`.
- Any app or lane implementing `SessionIssuer` or stubbing `req.storage.AuthnSession` with a literal.
