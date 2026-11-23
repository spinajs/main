---
"@spinajs/orm": patch
---

`redactPlan` also replaces a bare `true`, `false` or `NULL` in a plan's `detail` with `?`: postgres and MySQL print bound booleans and NULL that way (`= true`, `<=> NULL`, `IS DISTINCT FROM NULL::text`). `IS [NOT] NULL`, `IS [NOT] TRUE` and `IS [NOT] FALSE` stay, and so do quoted names. `sanitizeSql`, `record.sql` and fingerprints are unchanged.
