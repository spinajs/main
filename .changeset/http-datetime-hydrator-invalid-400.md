---
"@spinajs/http": patch
---
A `DateTime` route argument whose value does not parse now answers 400 instead of reaching the action. Before, `DateTimeHydrator` handed the action an invalid luxon `DateTime` for `?at=garbage`, `?at=1e20`, `x-at: Date: garbage`, a JSON body `{"at": 1e20}`, a repeated query key or an object, and a filter or a write then ran with a date that is not a date. It now throws `BadRequest` with "Argument '<name>' is not a valid date" (the value is not echoed), for query, url, header, cookie, form field and body values alike. Valid values give the same instant and zone as before. An absent argument (no query key, no header) still reaches the action unchanged, as the invalid `DateTime` it was before; a `null` or empty value is still the epoch.
