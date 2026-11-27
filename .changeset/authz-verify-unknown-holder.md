---
"@spinajs/authz-verify": patch
---

A holder that names nothing in the policy IR is reported as `AZV005`, an error, with an `unknown` verdict, so `spinajs authz:verify` exits 1. This covers the holder of `never`, the holders of `onlyVia` and the `except` list of `isolated`: a role that does not exist (`role:clrek`), a role on a type it is not granted on (`role:accountant@nosuch`), a type or stored relation that does not exist (`nosuch#rel`, `org#auditor`), a permission written as a holder (`org#can_invoice_read`), an anyone term that does not exist, another letter case (`Role:accountant`), and the empty string. Before, `never` of such a holder answered `holds (exact)`, so a misspelt holder passed CI as a proof. `VerifyCode` and `Verdict.code` gain `AZV005`.
