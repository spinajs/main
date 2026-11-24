---
"@spinajs/orm-sql": minor
---

`SqlBooleanValueConverter` extends `BooleanValueConverter` and `SqlSetConverter` extends `SetValueConverter`; both only implemented their base before. A column that declares a subclass of either is now converted through that subclass on write and on read, where `Orm` skipped it and the driver converted the value by its class. Behaviour and the driver registrations of both classes are unchanged. The declared return type of `SqlBooleanValueConverter.toDB()` and `SqlSetConverter.toDB()` is now `unknown`, so a subclass chooses its own database form, such as `'Y'` / `'N'`; `SqlSetConverter.fromDB()` is declared `string[] | null`.

Upgrade: rows written before through such a column keep the driver's form, `1` / `0` or comma-joined text, and are now read by the subclass's `fromDB()`. Rewrite them in the subclass's form.
