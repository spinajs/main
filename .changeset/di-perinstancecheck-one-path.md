---
"@spinajs/di": patch
---

A `@PerInstanceCheck()` class resolved alone and as an `Array.ofType(T)` element at the same time is built once; an instance a list builds is cached under its class; a synchronous self-dependency reports `Circular dependency detected` instead of overflowing the stack. A resolve whose options are all `undefined`, as an injected dependency (`@Autoinject`, `@Inject`) passes them, shares a creation in flight with a resolve without options instead of building a second instance. A `@PerInstanceCheck()` element emits `di.resolved.<Base>` once when it newly joins an `Array.ofType(Base)` list, including an instance a single resolve cached before the list was built.
