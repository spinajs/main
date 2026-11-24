---
"@spinajs/orm-sql": patch
---

`SqlTimeValueConverter.toDB()` writes the milliseconds of a time span: `00:01:23.456` is written as `00:01:23.456`, no longer as `00:01:23`. A span without milliseconds is written as before, `HH:MM:SS`. A column without fractional precision rounds them to the second: MySQL `TIME`, which `time()` creates on MySQL, stores `00:00:01.600` as `00:00:02` where it used to store `00:00:01`, and so do PostgreSQL and MSSQL `time(0)`. Use `TIME(3)` on MySQL to keep the milliseconds.

`toJSON()` and `dehydrate()` emit the same text, so a time column whose span has milliseconds now serializes as `HH:MM:SS.fff`.
