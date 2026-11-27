---
"@spinajs/orm": major
"@spinajs/orm-sql": patch
---

A datetime column (`@DateTime()`, `@CreatedAt()`, `@UpdatedAt()`, `@SoftDelete()`, `@Archived()`) refuses a value that is no valid instant: an invalid luxon `DateTime` (`DateTime.fromISO('garbage')` gives one), a JS `Invalid Date`, `NaN`, `Infinity` and `-Infinity`, and a number outside the range a `DateTime` holds (beyond ±8.64e12 unix seconds, ±8.64e15 under `unit: 'milliseconds'`) now throw `InvalidArgument` naming the column, on every dialect. A raw `executeOnDb` parameter that is a `Date` or `DateTime` is refused too (`parameter: …`); a raw number is bound as given, since nothing says it is a datetime.

What breaks: a write (`insert()`, `update()`, `save()`, an upsert, static `update(data)`), a filter (`where()`, `whereIn()`, BETWEEN), a raw `Date` / `DateTime` parameter or a `toJSON()` that silently stored, compared or printed NULL for such a value now throws. Before, a nullable `ExpiresAt` written that way read as "never expires", and a `where()` compared with NULL and matched no row. `null`, `undefined` and `''` still mean NULL (on PostgreSQL `undefined` writes the column DEFAULT); values read from the database are unchanged.

Where NULL is meant for a value that may be invalid, decide it before the write, by the value's type:
- a luxon `DateTime`: `dt?.isValid ? dt : null`
- a JS `Date`: `d && !Number.isNaN(d.getTime()) ? d : null`
- a number: `Number.isFinite(n) ? n : null` (a finite number outside the `DateTime` range is refused too)
