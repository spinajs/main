---
"@spinajs/testing-orm": minor
---

Model factories: `defineFactory(Model, ({ seq }) => data)` returns `build`, `create` (saved through the unit of work), `createMany` and `for(relation, owner)`, which sets a belongs-to foreign key from a saved model or from a factory created once. `factory(Model)` returns the registered definition; `createTestDatabase()` restarts the sequence numbers and forgets the owners `for()` created.
