---
"@spinajs/compiler": patch
---

A type alias of an http reply is unwrapped to the type argument it passes to the reply. `type MissingUser = NotFound<User>` documents `User` (it documented the type parameter `T` with no schema), and `type OkList<T> = Ok<T[]>` documents `User[]` for `OkList<User>` (it documented one `User`).
