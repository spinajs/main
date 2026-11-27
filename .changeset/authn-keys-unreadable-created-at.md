---
"@spinajs/authn-keys": patch
"@spinajs/authn-http": patch
---

A key whose `created_at` holds a value no datetime converter reads is now read as unusable (`isUsableKey` refuses an invalid `createdAt`, so the strategies answer 401 `expired`) with a warning naming the kid. Before, reading it threw a `TypeError`: authentication failed with an exception and `GET /user/keys` and `authn:key-list` failed for its owner. The listing shows it with `"createdAt": null` (the `AuthnKeyEntry` schema now allows it) and the CLI with `created unreadable`.
