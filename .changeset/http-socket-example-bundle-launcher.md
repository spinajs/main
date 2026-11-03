---
"@spinajs/http-socket-example": patch
---

The single-file bundle is now `main.mjs`, a launcher that turns on Node's compile cache and writes it once the app listens, and `app.mjs`, the app with every dependency inlined. `node main.mjs` starts it as before; `NODE_DISABLE_COMPILE_CACHE=1` starts it without the cache.
