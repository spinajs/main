---
"@spinajs/audit": patch
---

When the `audit-pipeline` logger cannot be built, each fallback process warning writes the logger's failure and any `Error` among the line's fields (such as the store's error) by name and message, without their stacks.
