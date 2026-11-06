---
"@spinajs/orm": minor
---

`ModelBase.where` checks its column and value like the builder's `where`, and its object overload accepts the model's relations (`PickRelations` was computed over the class, which has none). The builder passed to the `first`, `last`, `newest`, `oldest` and `count` callbacks is typed with the model instance; it was typed with the model class, so its object form `where({ ... })` checked the wrong properties.
