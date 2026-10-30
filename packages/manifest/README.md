# @spinajs/manifest

Versioned types, JSON Schema and helpers for the SpinaJS application manifest.

- `types.ts`: the `Manifest` and `ManifestFragment` contract (`manifestVersion: 2`). Additive changes keep the version; readers ignore unknown fields. Version 2 changed what existing fields mean: `RouteEntry.fullPath` is the request path the route answers at, and `ParamEntry.kind` is the `ParameterType` the runtime registers the argument under (`AsDbModel`, `FromXmlRouteArgs`, `ArgAsRequest`, ...), so a version 1 fragment is refused instead of being merged.
- `readManifest(path)` / `readFragment(path)`: parse and validate against the bundled schema with Ajv (strict mode). A different `manifestVersion` throws `ManifestVersionError`, a structural problem throws `ManifestValidationError` with JSON paths.
- `hashManifest(manifest)` / `canonicalize(value)`: sha256 over canonical JSON (sorted keys) with `hash` and `generatedAt` blanked.
- `mergeFragments(app, deps, meta)`: combines per-package fragments into a `Manifest`. Prefixes ids with the package name, copies `schemas` (including config module schemas) and reports `duplicate-registration` (info) and `schema-id-collision` (error) diagnostics.
- `routeFullPath` / `controllerMountPath` / `configuredMountPath` / `withRoutePrefix`: the path rules `@spinajs/http` mounts routes with. `servedPath` turns a mounted path into the request path Express answers it at (trailing slashes stripped); `RouteEntry.fullPath` is that request path.

## Schema

`src/schema.json` and `src/schema.ts` are generated from `src/types.ts`. After changing the types run `npm run schema` and commit both files; a test fails when they drift.
