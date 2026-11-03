---
"@spinajs/http-socket-example": patch
---

The bundle is now two files: `main.mjs`, a launcher that turns on Node's compile cache in a per-user dir (`@spinajs/util/compile-cache`) and writes it once the app listens, and `app.mjs`, the app with every dependency inlined. Copy both `main.mjs` and `app.mjs` when you deploy it. `node main.mjs` starts it as before; `NODE_DISABLE_COMPILE_CACHE=1` starts it without the cache.
