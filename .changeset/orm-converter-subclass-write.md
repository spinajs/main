---
"@spinajs/orm": minor
"@spinajs/orm-postgres": minor
---

A column that declares a subclass of a shipped converter (`JsonValueConverter`, `UuidConverter`, `DatetimeValueConverter`, `BooleanValueConverter`, `TimeValueConverter`, `SetValueConverter`, `Int64ValueConverter`, `UniversalValueConverter`) is converted through that subclass on write and on read. `Orm` attached a declared converter only when its exact class was registered, so an unregistered subclass was skipped: a subclass of `JsonValueConverter` stored `[object Object]` on SQLite, and a datetime, boolean or time subclass was replaced by the driver's converter. A converter class that neither is registered nor extends a registered class is still skipped.

`JsonValueConverter.fromDB()` returns a string that is not JSON text as it is, which only `PostgresJsonValueConverter` did before; that class now inherits it. A JSON subclass on PostgreSQL and PGlite therefore reads a top-level string value back, and on SQLite, MySQL and MSSQL a read of text that is not JSON returns the text instead of failing the query. A string that is itself JSON text (`123`) reads as its JSON value on every driver, as `@Json()` already did on PostgreSQL.

`ValueConverter.toDB()` and `fromDB()` throw `MethodNotImplemented` with a message that names the converter class.

Upgrade, because existing applications see a changed stored format:

- Rows already stored in the driver's form are now read by the subclass's `fromDB()`. A column declaring a subclass of `UuidConverter` holds 36-character text in old rows and 16 bytes in new ones, and `where()` binds the bytes, so a lookup by key misses an old row. A subclass of the datetime, boolean or time converter finds the driver's ISO text, `1` / `0` or `HH:MM:SS` in old rows. A subclass with a format of its own reads old rows wrongly or throws. Rewrite those rows in the subclass's form. A `JsonValueConverter` subclass column on SQLite holds `[object Object]`, which now reads back as that text; nothing is left to recover, so write the values again or set them to NULL (`UPDATE t SET col = NULL WHERE col = '[object Object]'`).
- An empty subclass of `DatetimeValueConverter`, `BooleanValueConverter`, `TimeValueConverter` or `SetValueConverter` (the token classes of `@spinajs/orm`, which convert nothing themselves) now throws `MethodNotImplemented` on write, on read and in `new Model(data)`; before, the driver converted the value by its class. Extend the driver's implementation instead, or implement both methods.
- A read of a row that a subclass's `fromDB()` cannot parse rejects the whole query.
