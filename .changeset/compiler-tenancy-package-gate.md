---
"@spinajs/compiler": patch
---

The tenancy section no longer skips a tenancy package whose declarations sit under a nameless nested `package.json` (a `{ "type": "module" }` marker): the check that the program holds the package walks past such a file, as the checks it guards do.
