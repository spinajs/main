---
"@spinajs/manifest": minor
---

Opt-in `SPINAJS_PACKAGE_ROOTS`: a JSON map of package name to a directory under the app root, consulted first by `packageRootOf` for apps that ship without `node_modules` (a bundle). A package outside the map or with a missing directory resolves as before; a mapped directory that leaves the app root is refused.
