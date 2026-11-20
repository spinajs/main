---
"@spinajs/audit": patch
---

When the `audit-pipeline` logger cannot be built, each fallback process warning names the logger's failure by its message instead of repeating its stack.
