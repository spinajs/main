---
"@spinajs/compiler": patch
---

The manifest records only the guards a transport mounts. http's `@Access` and `@Policy` on a socket controller or handler are no longer recorded as guards (`@spinajs/http-socket` mounts `@SocketAccess` and `@SocketPolicy` only, so such a handler was denied, or ran unguarded under `http.socket.access.default: 'allow'`, while the manifest said it was guarded), and the build warns `AUTHZ013` at each of them; `@SocketPolicy` on an http route or controller is no longer recorded either (`@spinajs/http` never mounts it, so such a route ran unguarded). `spinajs doctor` now reports such a socket handler (`AUTHZ003`) or route (`HTTP002`) when nothing else guards it.
