---
"@spinajs/http": minor
---

New `@Idempotent()` route decorator (`required`, `ttl`, `fingerprint`, `maxReplyBytes`) and `parseIdempotencyKey()`. The decorator checks its options when the class is declared and records them on the route as `IRoute.Idempotency`; it does not change request handling yet. New `ResponseCapture` seam: `attachResponseCapture(res, capture)` lets a component see each JSON reply `jsonResponse` sends (status, `Content-Type`/`Location`/`ETag`, and the exact JSON text), so a reply can be replayed later. Replies that do not pass `jsonResponse` (files, buffers, redirects, templates, SSE) are not captured.
