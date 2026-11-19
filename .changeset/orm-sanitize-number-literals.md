---
"@spinajs/orm": patch
---

`sanitizeSql` replaces exponent and hex number literals (`1e10`, `1.5e3`, `1e-7`, `0xDEADBEEF`) whole; they no longer reach `db.query.text` in part or in full.
