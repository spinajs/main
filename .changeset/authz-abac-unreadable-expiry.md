---
"@spinajs/authz-abac": patch
---

`DbPolicyStore` refuses to load (`AuthzConfigError`) when an `authz_policy` row's `expires_at` holds a value no converter reads as a datetime. Before, that policy loaded as one that never expires. Rows the store wrote always hold a valid value.
