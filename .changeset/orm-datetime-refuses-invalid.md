---
"@spinajs/orm": major
"@spinajs/orm-sql": patch
---

A datetime column (`@DateTime()`, `@CreatedAt()`, `@UpdatedAt()`, `@SoftDelete()`, `@Archived()`) refuses a value that is no valid instant: an invalid luxon `DateTime` (`DateTime.fromISO('garbage')` gives one), a JS `Invalid Date`, `NaN`, `Infinity` and `-Infinity` now throw `InvalidArgument` naming the column (`parameter` for a raw `executeOnDb` parameter), on every dialect.

What breaks: a write (`insert()`, `update()`, `save()`, an upsert, static `update(data)`), a filter (`where()`, `whereIn()`, BETWEEN), a raw parameter or a `toJSON()` that silently stored, compared or printed NULL for such a value now throws. Before, a nullable `ExpiresAt` written that way read as "never expires", and a `where()` compared with NULL and matched no row. `null`, `undefined` and `''` still mean NULL; values read from the database are unchanged.

The fix in an application, where NULL is meant: `model.ExpiresAt = value?.isValid ? value : null`.
