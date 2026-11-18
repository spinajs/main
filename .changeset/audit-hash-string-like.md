---
"@spinajs/audit": patch
---

A `hash` path that reaches a value whose JSON is one string (a `Date`, a Luxon `DateTime`, a `URL`, a `String` object) hashes that string, so it correlates with the same text stored as a string; it used to hash the quoted JSON literal.
