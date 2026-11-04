---
"@spinajs/client": patch
---

The generated `client.ts` no longer fails to type-check for schema ids that json-schema-to-typescript re-cases (dotted ids, snake_case, a lowercase first letter). Type names are now PascalCase letters and digits, and two ids that case to the same name get distinct names.
