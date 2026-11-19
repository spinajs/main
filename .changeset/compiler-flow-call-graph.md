---
"@spinajs/compiler": minor
---

`CallGraph`: the call edges of a package, resolved through the type checker: methods and their overrides, injected services (`@Autoinject` / `@Inject` properties), `DI.resolve(T)`, abstract tokens and interfaces to the classes of the package that implement them (across files), getters, constructors, functions passed by name and the receiver of `f.call` / `f.apply` / `f.bind`. A call the program does not determine is reported as opaque, a call into a dependency as external, and so is a function value handed on (`handed`).
