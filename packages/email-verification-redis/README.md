# `@spinajs/email-verification-redis`

Redis (or Valkey) store for `@spinajs/email-verification`, built on ioredis. Select it with
`emailVerification.store: 'RedisEmailVerificationStore'` and pass ioredis options under `emailVerification.redis`
(`keyPrefix` defaults to `ev:`).
