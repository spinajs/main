---
"@spinajs/http-socket": major
"@spinajs/http-socket-example": patch
---

**Upgrade first: socket commands and events without a policy are denied.** A command or event that no enabled `@SocketAccess` or `@SocketPolicy` guards, on itself or on its class, now fails with `AccessDenied` (reason `no_policy`, wire code `forbidden`) before idempotency, ordering, policies and argument hydration run; an unguarded event is dropped. Add `@SocketAccess` or `@SocketPolicy` to every command and event before upgrading, or set `http.socket.access.default: 'allow'` to keep the old behaviour while migrating. The `'allow'` escape hatch is removed in 5.0. The socket server logs every unguarded command and event when it registers its handlers (`SocketHandlerRegistry.unguarded()`), as authz-http's `UnguardedRoutesReport` does for routes.

The example's notes and blob controllers require a signed-in user with a class-level `@SocketPolicy(SignedIn)`.
