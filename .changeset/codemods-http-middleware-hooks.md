---
"@spinajs/codemods": minor
---

New 4.0 transform `http-middleware-hooks` (in `V4_TRANSFORMS`, run by `spinajs upgrade --to 4`): a `// TODO(spinajs-4)` above `before()`/`after()` of `ServerMiddleware`, `NotFoundMiddleware` and `ErrorHandlerMiddleware` subclasses, and above `onResponse` and positional `onBefore`/`onAfter` of `RouteMiddleware` subclasses, linking the migration sections of the route and server middleware docs. A note only, no rewrite. The notes of this transform and of `problem-json-note` go above a member's JSDoc and keep the line ending most of the file uses (CRLF files were rewritten to LF).
