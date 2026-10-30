---
"@spinajs/orm": minor
"@spinajs/reflection": minor
---

`ManifestMigrationSource` lists the migrations in `app.manifest.json` when the effective manifest mode is not `off`, skipping files tagged for another environment before importing them. `FilesystemMigrationSource` returns nothing in `require` mode. `listFromManifest` takes an optional `include` filter that drops entries before their file is imported. `@spinajs/orm` now depends on `@spinajs/configuration` and `@spinajs/reflection`.
