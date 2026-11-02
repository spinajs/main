---
"@spinajs/manifest": patch
"@spinajs/orm": patch
---

A `.mts` or `.cts` migration is applied in `require` and `prefer`, as `spinajs build` lists it, and the directory scan finds it too. The boot filter used to reject the source name, so the migration was neither run nor reported.
