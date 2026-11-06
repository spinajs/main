---
"@spinajs/authz-ir": minor
---

`writeOpenFga(ir, { strict? })` exports the policy IR as an OpenFGA model (schema 1.1) with its conditions; `$global` is the type `global`, relation sources, permission bindings and what OpenFGA cannot express ride in `# spina:` comments. `defineAuthzSchema(namespaces, { permissions })` types an `authz.rebac` schema so a misspelt relation is a compile error, and returns the plain config value.
