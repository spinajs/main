---
"@spinajs/workflow": minor
"@spinajs/tracing": minor
---

Each activation runs under a root span `workflow <name>` linked to the context `start()` ran in (kept in the `__workflow.TraceParent` column); every executed step attempt gets a `step <name>` span; steps served from the journal get none. A failed step and a failed instance are recorded by their error class or the word `failed`, never an error message. `SpinaAttr` gains the `Workflow*` keys.
