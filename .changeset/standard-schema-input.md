---
"@spinajs/validation": minor
"@spinajs/compiler": minor
---

`@Schema` accepts a Standard Schema v1 object (zod 4, valibot, arktype). Validation routes it through `~standard.validate` and maps issues to the Ajv error shape. The compiler reads an exported `const <Name>JsonSchema` literal for zod 4 or reports `SCH004`.
