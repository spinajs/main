---
"@spinajs/manifest": minor
---

The manifest runtime locates each package root and the app root once per loaded manifest instead of once per entry, and no longer takes the real path of every entry file: `manifestFileFor` `lstat`s each path part from the package root down to the file, on every call, and only when one of them is a link or missing does it take the real paths of the root and the file and compare them, as before. Below a located root, the verdict and the error are the same as before for every path, including a directory swapped for a link after an earlier lookup: nothing below a root is cached. A different manifest object, app root, `SPINAJS_MANIFEST_ROOT` or `SPINAJS_PACKAGE_ROOTS` never reuses a lookup, and a package that was not found is looked up again. `realpathOf`, `existingRealpathOf` and `realDirectory` are exported for callers that resolve many files in the same directories.
