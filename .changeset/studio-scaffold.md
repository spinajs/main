---
"@spinajs/studio": minor
---

New package `@spinajs/studio`: Spina Studio's server. Off by default (`studio.enabled`), never mounted in production unless `studio.allowProduction`, and every endpoint is guarded by a `studio.auth.policies.<endpoint>` slot (default: `studio:read` in `studio.auth.domain`). `GET /_studio/api/capabilities` reports the version, the manifest, the tracing owner, the features this app can show and the Studio permissions the caller holds. Import `@spinajs/studio` once in the app (or build a manifest): its controllers are handed to http by `StudioControllerSource`.
