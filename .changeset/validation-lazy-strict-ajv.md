---
"@spinajs/validation": minor
---

`DataValidator` boots with one Ajv instance instead of two. `StrictValidator`, the `coerceTypes: false` instance for strict schema ids (`authn.`, `authz.` by default), is built the first time it is used, with every schema added before; it is now a protected getter and setter. `ajv-merge-patch` and `ajv-keywords` are installed on an instance when the first schema that names one of their keywords reaches it. A schema from a schema source is checked against the meta-schema once instead of three times, and a manifest schema once per instance instead of twice; a schema that fails is refused as before. Validation results do not change.
