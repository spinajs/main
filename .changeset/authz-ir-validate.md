---
"@spinajs/authz-ir": minor
---

`validateIR(ir)` checks what the JSON Schema cannot: `IR001` unknown relation, `IR002` subject type not allowed, `IR003` rewrite cycle with no stored base, `IR004` caveat parameter type mismatch (caveat parameters are keyed by the attribute path the condition reads), `IR005` permission bound to a missing relation.
