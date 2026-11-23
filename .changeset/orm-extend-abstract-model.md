---
"@spinajs/orm": minor
---

`extendModel` and `unextendModel` take an abstract model class too: the member they install on it is inherited by its concrete subclasses and their rows. They take the new exported type `ModelBaseClass<T extends ModelBase = ModelBase>` (`abstract new (...args: never[]) => T`), a model class abstract or not whatever its constructor takes; a plain function, an arrow function or a value typed `Function` is refused at compile time.
