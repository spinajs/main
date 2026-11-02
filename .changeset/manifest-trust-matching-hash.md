---
"@spinajs/manifest": minor
"@spinajs/cli": minor
---

`loadRuntimeManifest` no longer checks a manifest against its JSON Schema when the file's hash matches: the hash proves the file is what `spinajs build` wrote. The version and hash checks stay, and an edited or stale file is still checked against the schema before the hash mismatch is reported, so a broken one throws `ManifestValidationError` as before. Faster boot: the manifest schema is not compiled, and a large manifest is not walked. The new `validate` option, or `SPINAJS_MANIFEST_VALIDATE=1`, checks every file. `assertManifestVersion` is exported.

`spinajs build` checks the manifest it wrote against the schema; a manifest that fails is removed, and the build reports `CLI002` and exits 1.
