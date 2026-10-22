# Session management routes

`AuthnSessionsController` lets a signed-in user list their own sessions, end one, or end all others ("log out everywhere else"). It is always on. Rows carry the issuer's one-way session handle, never a session id or storage key.

## How it works

1. The controller policy `[Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` admits a session principal that is not impersonating. A token or key caller gets 403 `session_required`, an impersonator 403 `impersonating`, an anonymous caller or a pending session 401.
2. The route takes the active session from `req.storage.AuthnSession`; without one, 403 `session_required`.
3. It calls `SessionIssuer.list()`, `revokeHandle()` or `revokeAll()` for the session's identity.
4. Revocations are audited as `session.revoke` with reason `owner` or `owner_others`. `SessionIssuer` audits nothing itself.

## Routes

### `GET /user/sessions`

| | |
| --- | --- |
| 200 | `[{ "Handle": string, "Created": ISO, "LastSeen": ISO, "Ip"?: string, "UserAgent"?: string, "Current": boolean }]`, newest first, `Cache-Control: no-store` |

`Current` marks the session making the request. Sessions in which someone impersonates the caller are listed too, with the impersonator's ip and user agent.

### `DELETE /user/sessions/:handle`

| | |
| --- | --- |
| 200 | No data. Ending the current session also clears its cookie. |
| 404 | `{ "error": "session_not_found", "message": "No such session" }` for any handle that is not one of the caller's sessions |

### `DELETE /user/sessions`

| | |
| --- | --- |
| 200 | `{ "Revoked": number }`: every session of the caller ended except the current one |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SessionIssuer` | autoinjected | `DefaultSessionIssuer` (`@spinajs/authn-session`) | | `list()`, `revokeHandle()` and `revokeAll()` come from the issuer; see [`@spinajs/authn-session`](../authn-session/README.md). |

## Important behaviour

- **Impersonators cannot see or end the target's sessions.** The route refuses while impersonating; the target sees the impersonation session in its own list.
- **One 404 for every foreign handle.** A handle of another user answers like an unknown one.
- **Per-request credentials are refused.** An API token has no session to manage.
- `Ip` and `UserAgent` are the values stored at password login, key login, and impersonation start and stop; MFA completion keeps those of the pending session. They are absent when the client sent none.

## Best practices

- Offer "log out everywhere else" through `DELETE /user/sessions` after a password change on another device; a password change through [`PATCH /user/password`](12-password-routes.md) already ends the other sessions.

## Related

- [Action hooks](23-action-hooks.md): both `DELETE` routes run `authn.sessions.revoke`; a refusal answers 403 `{ error: 'action_refused', code }` and ends no session.
- [Login, logout and MFA routes](08-login-logout-and-mfa-routes.md): where sessions start and the client is stored.
- [Credential admin routes](16-credential-admin-routes.md): an admin ends another user's sessions.
- [`@spinajs/authn-session`](../authn-session/README.md): handles, expiry and session storage.
