---
"@spinajs/authz-orm": patch
---

`.withFields(permission)`, and `.accessible(permission)` under a `fields: 'filter-rows'` request, now fail the list with an `Error` when the field set of a group of rows is a `model_error` denial (an engine or adapter fault), instead of returning that group's rows with no readable field; an ordinary denial still gives its rows no field.
