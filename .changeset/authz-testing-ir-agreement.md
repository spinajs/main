---
"@spinajs/authz-testing": minor
"@spinajs/authz-rebac": minor
---

`irAgreement(arbitrary, build, options)` is the differential conformance kit of the policy IR: for every generated world the engine and `IREvaluator.check` must give the same allow/deny/unknown on every request, and a disagreement fails with fast-check's shrunk counterexample and seed (`AUTHZ_IR_AGREEMENT_RUNS`, default 300). `voteTruth(vote)` reads a vote three-valued, an indeterminate one (`model_error`) as unknown. `rebacTupleSource(store)` is the IR evaluator's view of a ReBAC tuple store; ReBAC is checked against the IR on random namespaces, tuples and requests.
