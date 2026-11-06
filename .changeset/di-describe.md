---
"@spinajs/di": minor
---

`Registry.entries()` enumerates a registry's own registrations, and `container.describe()` reports what a container registered: every key with its implementations (class, factory or value), each class's lifetime, whether an instance is cached, whether it is an `AsyncService`, and its constructor, property and lazy injections (optional and mapped ones flagged), plus the keys whose resolution is in flight. `IToInject` gains the `lazy` and `optional` markers `@LazyInject` and `@Autoinject(T, { optional: true })` now set. Additive; used by Spina Studio's DI graph.
