---
"@spinajs/orm-history": minor
---

`@History()`, `registerHistory` and `historyOf` take an abstract model class too. A mark on an abstract base covers its concrete subclasses, each tracked with the base's options under its own table; the mark still needs the merged row interface and the `declare static history` line.

Since a marked abstract base is listed, `historyModels()` returns `Class<ModelBase>` of `@spinajs/di` (abstract or not) instead of `Constructor<ModelBase>`; `HistorySpec.model`, `lineageOf`, `ruleFor`, `historySpecOf` and the `of` methods of `HistorySpecs` and `ModelHistorySource` take or hold that type as well.
