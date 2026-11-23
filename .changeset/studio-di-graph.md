---
"@spinajs/studio": minor
---

Spina Studio answers `GET /_studio/api/di/graph` (`package`, `focus`, `depth`, `limit`) and `GET /_studio/api/di/services/:id`: the DI graph of the manifest and the root container, merged when a manifest is loaded (manifest-only classes marked not instantiated, runtime-only ones marked unknown to the manifest, imperative resolves kept), else the runtime graph alone.
