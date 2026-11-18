---
"@spinajs/orm": patch
---

An `orWhere()` inside a belongs-to `populate()` callback no longer escapes into the owner's WHERE: the callback's conditions are merged as one parenthesized group when they contain an OR, so `where('Id', 1)` with a populate filtering `Name = 'a' OR Name = 'b'` returns only row 1. Conditions of a nested populate are joined to that group with AND, and a clone of the query keeps both. The target conditions of a many-to-many populate are grouped the same way in its junction query, which no longer reads rows of other owners.

Behaviour change: a callback that starts with `orWhere()` used to OR its first condition against the owner's conditions (`x OR a`); it is now part of the group (`x AND ( a )`). Write the OR on the owner query if that is what you meant.
