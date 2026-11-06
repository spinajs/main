---
"@spinajs/compiler": minor
---

A controller that extends a base from a dependency (for example `@spinajs/upload`'s `UploadController`) now lists the inherited routes in the app manifest, read from the dependency's manifest fragment, with the subclass's path, guards and bound types. A base from a package without a fragment is reported as `CMP009` info.
