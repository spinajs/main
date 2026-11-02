---
"@spinajs/manifest": minor
---

The manifest runtime locates each package root and the app root once per loaded manifest instead of once per entry, and takes the real path of a directory once instead of the real path of every file: `manifestFileFor` now costs one `lstat` per entry. The containment checks are unchanged: every entry is still resolved through its real directory, a link is still resolved in full, and a different manifest object, app root, `SPINAJS_MANIFEST_ROOT` or `SPINAJS_PACKAGE_ROOTS` never reuses a lookup. A package that was not found is looked up again. `realpathOf`, `existingRealpathOf` and `realDirectory` are exported for callers that resolve many files in the same directories.
