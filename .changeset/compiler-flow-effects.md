---
"@spinajs/compiler": minor
---

`FlowTracer`: the query tracer across calls. A builder-typed parameter is a pending builder, and a call that hands a builder back unexecuted is that builder, scoped as the callee and the argument left it; a choice between builders (`?:`, `??`, `||`, `&&`) is one builder, and a builder the tracer cannot follow to a model class is read from its type. With it come the authz effect types (`AuthzEffect`, `FunctionSummary`), `builderOf`, `staticKind` and `isSystemRunAs`.
