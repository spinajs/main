---
"@spinajs/authz-testing": patch
---

`runModelConformance` reads its default number of runs from `AUTHZ_CONFORMANCE_RUNS` (default 25), as `irAgreement` reads `AUTHZ_IR_AGREEMENT_RUNS`. An explicit `numRuns` still wins.
