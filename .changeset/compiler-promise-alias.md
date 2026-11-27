---
"@spinajs/compiler": patch
---

A type alias of `Promise` is unwrapped to its payload. `type AsyncOk<T> = Promise<Ok<T>>` documents `User` for `AsyncOk<User>`, and `type PromiseList<T> = Promise<T[]>` documents `User[]` (both documented the alias name with no schema). `Promise`, `ModelData` and `ModelDataWithRelationData` are wrappers only when they are the global `Promise` and the `@spinajs/orm` aliases: an application type of the same name is described by its own schema instead of being unwrapped to its type argument.
