---
"@spinajs/authz-http": minor
"@spinajs/telemetry": major
"@spinajs/studio": patch
---

`@spinajs/authz-http` exports `SlotAccessPolicy` and `SlotAccessContributor`: one endpoint guarded by a configuration slot `<module>.auth.policies.<endpoint>` (`'AccessPolicy'` checks `<module>.auth.permissions.<endpoint>`, any other value names a registered policy) with the opt-in development skip, plus `skipsAuthInDevelopment`, `isExplicitDevelopment`, `configuredEnvOf` and the types `DevelopmentSkipSettings`, `EnvLike`, `SlotSettings`. `TelemetryAccessPolicy` and `StudioAccessPolicy` are built on it with unchanged names, configuration and answers.

**Breaking, `@spinajs/telemetry`:** the development-skip helpers are no longer exported by `@spinajs/telemetry`. Import them from `@spinajs/authz-http`:

- `telemetrySkipsAuth` → `skipsAuthInDevelopment` (same arguments, same answer)
- `TelemetrySkipSettings` → `DevelopmentSkipSettings`
- `isExplicitDevelopment`, `configuredEnvOf`, `EnvLike` → the same names from `@spinajs/authz-http`

A subclass of `TelemetryAccessPolicy` is affected too: the protected `read()` and `guard` are now inherited from `SlotAccessPolicy`, and the guard they return for an `'AccessPolicy'` slot carries `permissions` and `domain` where it carried `holder`.

See "Telemetry: the development-skip helpers moved to `@spinajs/authz-http`" in `docs/upgrading/4.0.md`.
