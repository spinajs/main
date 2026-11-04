---
"@spinajs/compiler": patch
---

Schema derivation skips symbol-keyed members (`[Symbol.metadata]`, unique-symbol keys) instead of publishing TypeScript's internal `__@name@<id>` key, whose id comes from a process-wide counter and changed between builds. Fragments that carried such a key (`@spinajs/configuration-db-source` and everything that inherits its schema) get a new fragment hash, which is now stable.
