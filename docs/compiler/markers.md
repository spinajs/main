# Declaration markers

A framework package tells the compiler what one of its declarations is with a JSDoc block tag on that declaration:

    /** Rows of one model. @spinajs query select */
    export interface ISelectQueryBuilder<T> { … }

The compiler resolves the symbol a piece of application code uses (through imports, re-exports and, for a type, its base classes and interfaces) and reads the tag. A user declaration with the same name carries no tag and plays no role, and renaming or moving the declaration keeps its role.

A value is one word. Text after it is comment text. A marker reaches other packages through the `.d.ts`, so the package must build with `removeComments` off (the repository default).

| Role | Value | On | Read by |
|---|---|---|---|
| `query` | `select`, `update`, `delete`, `insert` | an ORM query builder class or interface; subclasses inherit it | the authz flow pass (`builderOf`), which follows `select`, `update` and `delete`. Any other value than these four fails the compile. |
| `copy` | none | a builder method that returns a copy of the builder (`clone()`) | the flow tracer: calls after it change the copy |
| `authz-scope` | `accessible`, `unscoped` | a builder method that scopes the query it is called on | the query tracers |
| `run-as` | none | a method `(principal, reason, fn)` that runs `fn` as `principal` | `isSystemRunAs` |
| `system-principal` | none | the principal constant that means "the system" | `isSystemRunAs` |

Whether a builder call runs the query is not marked: a call on a builder whose result is not a builder and is awaitable or async-iterable runs it (`first()`, `then()`, `stream()`, `paginate()`). A result of type `any` or `unknown` counts as running it.

Add a role only together with the compiler code that reads it, and list it here.
