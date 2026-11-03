---
"@spinajs/configuration": minor
"@spinajs/telemetry": minor
"@spinajs/cli": minor
---

`GET /telemetry/health` reports the manifest the app booted from as `manifest: { mode, hash }`. `hash` is the loaded manifest's `hash`, the value `hashManifest`, `spinajs build` and `spinajs manifest:diff` show, so a deployed app can be checked against the manifest diff of its pull request; it is `null` when the app booted without a manifest (`off`, or `prefer` with a missing or stale file). The field is added; the existing fields are unchanged. `@spinajs/configuration` exports `bootedManifestOf(container)`, which reads what `ManifestConfigurationSource` registered and never throws. `spinajs build` ends its summary with a `hash` row. The `@spinajs/telemetry` manifest fragment changes (a `Container` property inject on `TelemetryController` and the `HealthResponse.manifest` schema), so an app that depends on `@spinajs/telemetry` gets a new manifest hash when it rebuilds its manifest.
