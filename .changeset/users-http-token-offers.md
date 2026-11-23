---
"@spinajs/users-http": minor
---

`GET /user/tokens/permissions` lists the permissions a new token of the caller may be narrowed to with `scope.permissions`: what a token carrying the offered roles (and the optional `profile`) is allowed at GLOBAL, less the globs in `users.http.tokens.hiddenPermissions`. A value of that key that is not a list of permission globs fails closed with 500.
