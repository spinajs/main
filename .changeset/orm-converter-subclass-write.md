---
"@spinajs/orm": patch
---

A column that declares a subclass of a shipped converter (`JsonValueConverter`, `UuidConverter`, `DatetimeValueConverter`, `BooleanValueConverter`, `TimeValueConverter`, `SetValueConverter`, `Int64ValueConverter`, `UniversalValueConverter`) is converted through that subclass on write and on read. `Orm` attached a declared converter only when its exact class was registered, so an unregistered subclass was skipped: a subclass of `JsonValueConverter` stored `[object Object]` on SQLite, and a datetime, boolean or time subclass was replaced by the driver's converter. A converter class that neither is registered nor extends a registered class is still skipped.
