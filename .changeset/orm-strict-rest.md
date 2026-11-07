---
"@spinajs/users": patch
"@spinajs/users-http": patch
"@spinajs/teams": patch
"@spinajs/authn-token": patch
---

`User.query().whereUser(email)` looks up the trimmed email. It validated and trimmed the argument, then queried the untrimmed one, so `' a@b.c '` found no user.

`users-http`, `teams` and `authn-token` compile with strict query typing. Their queries are unchanged: sort columns, requested relations and the `deleteExpired`/`touch` cutoffs are passed in the form the typed builder expects.
