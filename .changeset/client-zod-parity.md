---
"@spinajs/client": patch
---

A differential parity suite now checks the generated zod schemas against the server's `ManifestValidator`: for the app-basic and schema-corpus manifests and five hand-written sets, in the classic and the mini flavor, on the `Schema`, `Coerced` and `Reply` variants, with seeded fast-check inputs. A schema stricter than the server fails the suite, and one looser fails it unless the keyword a diagnostic names explains it, or a pin on a dedicated schema does. The suite also checks that every schema is compared, and that the server accepts enough of its inputs. A second, seeded suite builds random schemas around Ajv's in-place coercions and compares their `Coerced` variant with the server the same way. Tests only: the published package does not change.
