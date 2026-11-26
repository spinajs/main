---
"@spinajs/authz-verify": minor
---

An assertion that names a permission the policy IR does not have (`implies`, `separated`, `onlyVia`, `never`), or a `never` glob that matches no permission, is reported as `AZV006`, an error, with an `unknown` verdict, so `spinajs authz:verify` exits 1. Before, every engine answered `holds (exact)` for it, so a misspelt permission showed a proof. Names are matched case-sensitively, and only `never` takes a glob: `implies('invoice:*', …)` names no permission. `VerifyCode` and `Verdict.code` gain `AZV006`.
