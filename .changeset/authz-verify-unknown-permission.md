---
"@spinajs/authz-verify": minor
---

An assertion that names a permission the policy IR does not have (`implies`, `separated`, `onlyVia`, `never`), a `never` glob that matches no permission, or an `isolated` type the IR does not have, is reported as `AZV006`, an error, with an `unknown` verdict, so `spinajs authz:verify` exits 1. Before, every engine answered `holds (exact)` for an unknown permission, so a misspelt permission showed a proof, and an unknown `isolated` type was an `AZV003` warning that passed the default `--fail-on error`. Names are matched case-sensitively, and only `never` takes a glob: `implies('invoice:*', …)` names no permission. A name that is empty or has blanks around it is printed in quotes. `VerifyCode` and `Verdict.code` gain `AZV006`. Holder names are not checked yet: a `never` holder that selects no holder of the policy still answers `holds`.
