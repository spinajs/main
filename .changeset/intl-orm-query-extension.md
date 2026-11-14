---
"@spinajs/intl-orm": minor
---

`translate()` is installed by `IntlQueryExtension`, a `SelectQueryExtension`, when the Orm resolves, instead of being assigned to `SelectQueryBuilder.prototype` at import. Behaviour change: the method exists only after `Orm.resolve()`, and wrapping `SelectQueryBuilder.prototype.translate` no longer works. New exports: `IntlQueryExtension` and `translateQuery`. To change `translate()`, register a subclass of `IntlQueryExtension` with `@Injectable(SelectQueryExtension)`.
