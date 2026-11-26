---
"@spinajs/orm": minor
---

`db.WriteCapture.Required` lists tables whose model writes need a `WriteObserver`: an insert, update or delete of a listed table that no registered observer takes is refused before it runs, with the new `WriteCaptureRequired` (an `InvalidOperation`) naming the model, the table and the key. The default is an empty list, which refuses nothing, so an application that does not set the key sees no change. Builders without a model and the other writes the capture does not see are not covered. The section `db.WriteCapture` now accepts only its two keys, `MaxRows` and `Required`: another key under it, such as a misspelt one, fails the configuration check.
