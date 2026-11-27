---
"@spinajs/authz-verify": patch
---

Security-relevant fix of a false proof: the bounded engine of `authz:verify` searched principals only of the types the policy IR declares. A compiled RBAC policy names `user` in `allowed` lists only, so a non-monotone assertion over it (a relation grant, a deny) was reported "verified up to k" without a single user searched. Principal types are now every direct subject type a relation names, and a bounded query with nothing to search answers `unknown` (`AZV003`) instead of `holds`. An assertion that held by that accident now reports `violated` with a counterexample, or `unknown`.
