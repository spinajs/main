---
"@spinajs/http": minor
---

`ManifestControllerSource` lists the controllers in `app.manifest.json` when the effective manifest mode is not `off`. `FilesystemControllerSource` returns nothing in `require` mode, so the manifest is the only file-backed source. The list is in the directory scan's order.
