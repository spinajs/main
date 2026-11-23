---
"@spinajs/orm": minor
---

Observers of the write capture can tell that rows are missing: `CapturedWrite.keylessRows` counts the rows a statement reached or wrote whose primary key value has no key text (bytes, a date, a number that is not a safe integer). Such rows are still left out of `rows`, but no longer without a sign. The count is `0` when every row has a key with text and when `unknownKeys` is true. With `db.WriteCapture.MaxRows` set, the rows of an update or delete whose key has no key text count towards the limit, as those of an insert already did.
