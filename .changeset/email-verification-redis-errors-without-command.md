---
"@spinajs/email-verification-redis": patch
---

Errors that leave `RedisEmailVerificationStore` no longer carry the command arguments ioredis attaches to them. ioredis copies a failed command's name and arguments onto its error as `err.command`, and onto each queued error of a failed transaction as `err.previousErrors[i].command`: cache keys with the checked domain, stored values such as a list source URL with its token, and, for a refused `AUTH`, the Redis password. The store now removes `command` from every error its methods reject with and from the connection error it logs; class, `name`, `message`, `stack` and `previousErrors` are kept.

Before this fix a refused `AUTH` (wrong Redis password) put the Redis password into the store's own `Redis connection error` log line on the `email-verification` logger. Operators should rotate a Redis password that may be in logs.

An application can no longer read `err.command.name` or `err.command.args`, nor the same on `err.previousErrors` items, from an error thrown by this store.
