---
"@spinajs/authz-abac": patch
---

`DbPolicyStore` refuses to load (`AuthzConfigError`) when an `authz_policy` row's `expires_at` holds a value no converter reads as a datetime. Before, that policy loaded as one that never expires. Decision replay, `scope.forget` and the change-log images refuse such a row the same way, as for a JSON column that does not parse. A PostgreSQL `'infinity'` is refused too: write NULL for no expiry. Rows the store wrote always hold a valid value.
