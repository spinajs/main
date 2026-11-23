---
"@spinajs/orm-history": patch
---

History masks a `@Hidden()` column whichever model class of the table declares it: the masked columns of a tracked model are the `@Hidden()` columns of every model the ORM loaded on the same table and connection, so a write built on a base class no longer stores in clear a column that only a subclass hides. `hidden: 'record'` and a column listed in `columns` are recorded as before.
