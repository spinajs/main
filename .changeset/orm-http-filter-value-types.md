---
"@spinajs/orm-http": minor
---

The schema of a `@Filter` route argument checks each condition's value against its operator group (scalar, text, list, pair, valueless) and the column's type: an explicit `@Filterable({ value })` schema, else the model column's type, else any scalar; a wrong value shape answers 400 instead of the wrong rows or a 500. The top-level list takes at most `MAX_FILTERS` (100, exported) conditions. `@Filterable()` also accepts an options object (`IFilterableOptions`), and `filterColumns()` returns its `value`.
