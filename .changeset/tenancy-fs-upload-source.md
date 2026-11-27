---
"@spinajs/tenancy": patch
---

`@spinajs/tenancy/fs`: inside a tenant, an `upload()` into any provider (also one that is not listed, or `fs-temp`) whose local source lies in another tenant's files or in a listed provider's shared files is refused with `InvalidArgument`, and so is a folder that holds such files and a source that is not a path string. The source is compared by file identity, so a link, a `..` climb, a short name, a `\\?\` or UNC spelling, or a file that does not exist does not get around it.
