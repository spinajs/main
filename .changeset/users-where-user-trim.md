---
"@spinajs/users": patch
---

`User.query().whereUser(email)` looks up the trimmed email. It validated and trimmed the argument, then queried the untrimmed one, so `' a@b.c '` found no user.
