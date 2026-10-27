# @spinajs/manifest

Versioned types, JSON Schema and helpers for the SpinaJS application manifest.

- `types.ts`: the `Manifest` and `ManifestFragment` contract (`manifestVersion: 1`). Later changes are additive; readers ignore unknown fields.
- `readManifest(path)` / `readFragment(path)`: parse and validate against the bundled schema with Ajv (strict mode). A different `manifestVersion` throws `ManifestVersionError`, a structural problem throws `ManifestValidationError` with JSON paths.
- `hashManifest(manifest)` / `canonicalize(value)`: sha256 over canonical JSON (sorted keys) with `hash` and `generatedAt` blanked.
- `mergeFragments(app, deps, meta)`: combines per-package fragments into a `Manifest`. Prefixes ids with the package name, fills in `fullPath` when missing, copies `schemas` (including config module schemas) and reports `duplicate-registration` (info) and `schema-id-collision` (error) diagnostics.

## Schema

`src/schema.json` and `src/schema.ts` are generated from `src/types.ts`. After changing the types run `npm run schema` and commit both files; a test fails when they drift.
