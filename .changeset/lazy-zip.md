---
"@spinajs/fs": patch
---

`fsNative` loads `archiver` the first time it zips and `unzipper` the first time it unzips, not when `@spinajs/fs` is imported. Faster boot; zip and unzip behave as before.
