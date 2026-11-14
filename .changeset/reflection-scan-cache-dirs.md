---
'@spinajs/reflection': patch
---

A file scan is cached per scanned directories as well: a later app in the same process that sets other `system.dirs` entries scans them instead of reusing the first app's classes.