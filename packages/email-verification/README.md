# `@spinajs/email-verification`

Refuses email addresses whose domain cannot receive mail, is disposable, or is suspiciously new.

```sh
npm install @spinajs/email-verification
```

Enable it with `emailVerification.enabled: true` and call `EmailVerification.check(email)`. Pick a store with
`emailVerification.store`: `MemoryEmailVerificationStore` (default), or one of `@spinajs/email-verification-orm`,
`-redis` and `-dynamodb`.

## Documentation

- [Package overview](../../docs/email-verification/README.md)
