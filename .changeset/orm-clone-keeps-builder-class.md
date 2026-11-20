---
"@spinajs/orm": minor
---

`SelectQueryBuilder.clone()` resolves the copy from the builder's container instead of constructing the base class, so a subclass registered for `SelectQueryBuilder` survives a clone, including the clones the ORM makes itself. An override of `clone()` that restored the prototype by hand keeps working and no longer needs that line; it is still the place to copy the fields a subclass adds.
