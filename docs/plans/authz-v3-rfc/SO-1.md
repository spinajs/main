# RFC SO-1: `SessionIssuer.restore` returns a `Session`

Status: APPLIED on feat/authz-v3 (plan docs/superpowers/plans/2026-10-16-session-object.md).

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

A restore result that is not a `Session`, such as a plain object from a JS issuer, is wrapped in one where it enters: the
authn middleware, the socket session source, and the impersonation service. Without that wrapping it would lose the role
narrowing.

`ACTIVE_ROLE_KEY`, `IMPERSONATION_BLOCK` and `SESSION_IP_KEY` / `SESSION_USER_AGENT_KEY` / `SESSION_PENDING_STEPS_KEY`
now come from `SessionKeys.*.name` and are typed `string`, no longer as string literals. Their values are unchanged.

Not in the snapshot, but a public signature: `activeRoleCeiling(session: Pick<Session, 'activeRole'>)` in
`@spinajs/authn` replaces `activeRoleCeiling(data: ReadonlyMap<string, unknown>)`.

Readers of `.handle`, `.identity`, `.facts` and `.data` keep compiling. Implementations of `SessionIssuer` and object
literals typed as the restored session must construct a `Session`.

One behaviour change: `GET auth/active-role` answers `ActiveRole: ''` instead of `null` for a stored value no role switch
writes, which matches the principal (narrowed to no role).

`GET auth/impersonate` `StartedAt` is serialised again from the decoded Date. Values written by impersonation start are
byte-identical.

## Affected lanes

- authn-session (`DefaultSessionIssuer`), authn-testing (`MemorySessionIssuer`): construct `Session`.
- Any app or lane implementing `SessionIssuer` or stubbing `req.storage.AuthnSession` with a literal. A literal handed
  back by `restore` is wrapped at the three entry points above, so role narrowing holds; type it as `Session` anyway.
- authn-http (middleware, socket session source) and authn (impersonation service): wrap a non-`Session` restore result.
