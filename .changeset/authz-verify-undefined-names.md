---
"@spinajs/authz-verify": patch
---

Security-relevant fix of a false proof: a rewrite that names a relation or a permission the policy IR does not define (what `validateIR` reports as `IR001` or `IR005`) was read by both engines of `authz:verify` as "nobody", so an assertion only such a name could break was reported as holding. Such a name is now a part the verifier cannot see, like an opaque term: the exact engine lists it under `opaque` and leaves the permission to the bounded engine, which answers `unknown` with the name. A compiled RBAC policy with a relation grant on the file ACL is such a policy until the IR declares those relations.
