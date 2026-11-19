---
"@spinajs/compiler": minor
---

Adds `FlowTracer`, a query tracer that follows builders across calls. A builder-typed parameter is a pending builder. A call that hands a builder back unexecuted is that builder, scoped as the callee and the argument left it. A choice between builders (`?:`, `??`, `||`, `&&`) is one builder, and a builder the tracer cannot follow to a model class is read from its type. With it come the authz effect types (`AuthzEffect`, `FunctionSummary`), `builderOf`, `staticKind`, `runsQuery`, `isSystemRunAs`, `memberMarker` and `scopeOf`. They name no builder, member or package: a builder is a type marked `@spinajs query`, scoping and copying are members marked `@spinajs authz-scope` and `@spinajs copy`, a system run is a member marked `@spinajs run-as` called with a principal marked `@spinajs system-principal`, and a call runs the query when its result is no builder and can be awaited or iterated asynchronously.
