# Model factories

```ts
import { defineFactory, factory } from '@spinajs/testing-orm';

export const users = defineFactory(User, ({ seq }) => ({ Login: `user${seq}`, Email: `user${seq}@test.dev` }));
export const posts = defineFactory(Post, ({ seq }) => ({ Title: `post ${seq}` }));

const draft = users.build({ Login: 'admin' });     // unsaved
const saved = await users.create();                // saved through the unit of work ( save() )
const three = await users.createMany(3);

// every post belongs to one user, created once
const written = await posts.for('Author', users).createMany(3);
// or to an existing one
await posts.for('Author', saved).create();

factory(User) === users;                          // the registered definition
```

- `seq` counts the models a factory made, from 1. `createTestDatabase()` starts every count over, so a new database
  sees `user1` again, and forgets every owner a `for()` factory created: a module-scope `posts.for('Author', users)`
  creates a fresh author in each test database.
- `for(relation, owner)` takes a belongs-to relation (`@BelongsTo`) and sets its foreign key from the owner's key.
  A factory owner is created on the first `create()` and shared by every model of that factory until the next
  `createTestDatabase()`; `build()` only sets the key of an owner that is already saved.
- Overrides win over owner keys, and owner keys over the definition: a key column set in `overrides` replaces
  the owner's.
- Models are saved one by one, so sequence numbers and generated keys follow the same order.
