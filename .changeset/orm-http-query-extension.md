---
"@spinajs/orm-http": minor
---

`filter()` is installed by `FilterQueryExtension`, a `SelectQueryExtension`, when the Orm resolves, instead of being assigned to `SelectQueryBuilder.prototype` at import. Behaviour change: the method exists only after `Orm.resolve()`, and wrapping `SelectQueryBuilder.prototype.filter` no longer works. New exports: `FilterQueryExtension` and `filterQuery`. To change `filter()`, register a subclass of `FilterQueryExtension` with `@Injectable(SelectQueryExtension)`.
