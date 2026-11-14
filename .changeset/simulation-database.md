---
"@spinajs/simulation": minor
---

`SimEnv.boot()` runs each seed on one sqlite file behind one shared driver: dead incarnations cannot write or commit, pauses inside a transaction wait for it to end, and migrated databases are reused as templates.
