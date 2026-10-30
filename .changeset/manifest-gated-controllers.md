---
"@spinajs/http": patch
"@spinajs/authz-http": patch
---

The manifest no longer mounts a controller that a dedicated `ControllerSource` gates. `ManifestControllerSource` skips classes with `static readonly mountedBySource = true`; `ExplainController` sets it, so in `require` and `prefer` mode `GET /authz/explain` answers 404 unless `ExplainControllerSource` mounts it (`authz.http.explainRoute.enabled`, never in production), as in `off` mode.
