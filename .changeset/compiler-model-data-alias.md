---
"@spinajs/compiler": patch
---

A type alias of the `@spinajs/orm` `ModelData` or `ModelDataWithRelationData` is unwrapped to the model, as the alias it names is. A route returning `DataOf<User>` (`type DataOf<T> = ModelData<T>`), `UserData` (`type UserData = ModelData<User>`), `Promise<DataOf<User>>` or `Ok<UserData>` now documents `User` with its schema, where it documented the alias name with no schema; a nested `DataOf<User>` (an array item, a member) now derives as a `$ref` to the model's schema, as `ModelData<User>` does, where it was an inline object of the columns. A chain of up to 15 aliases is followed. A route returning `ModelData<User> | null` or `DataOf<User> | null` now documents `User` or `null`, where it documented the bare type name with no schema. An alias of an application type named `ModelData` keeps its own schema.
