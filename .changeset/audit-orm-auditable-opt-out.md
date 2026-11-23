---
"@spinajs/audit-orm": minor
---

`registerAuditable(Model, false)` and `@Auditable(false)` take the mark back: they remove the `audit()` members the mark installed on that class and its rows, as `registerHistory(Model, false)` and `@History(false)` do in `@spinajs/orm-history`. On a class that was never marked they do nothing; a subclass of a marked base keeps the member it inherits. `@Auditable(false)` needs neither the merged row interface nor the `declare static audit` line. `auditOf` keeps reading the model.
