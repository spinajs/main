---
"@spinajs/workflow": minor
---

A workflow replay reproduces the interleaving of concurrent branches. Each step row records how many results the workflow had received when the step was called (`Meta.after`) and the order its result arrived in (`Meta.order`, taken under the instance row lock, so it is the commit order). A replay hands a result back only once every call that preceded it has been made again, so branches that repeat a step name keep their own results, also across awaited timers or I/O between steps and concurrent transactional steps. A replay fails with `NonDeterminismError` when a call is made at another position or after another number of results than recorded (an inserted or renamed step fails before its body runs), and, through a coarse `leaseTtl` timer on the injected `Clock`, when it waits for a recorded step that is never asked for. Journals written without this metadata keep the previous, lenient check.
