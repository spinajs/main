# Choosing a store

The store holds two things: the cached verdicts of the cacheable verifiers, and the domain lists with their sync state. One store serves both. Select it by class name with `emailVerification.store`.

| Store | Package | Pick it when | Notes |
| --- | --- | --- | --- |
| `MemoryEmailVerificationStore` (default) | `@spinajs/email-verification` | Tests, a single node, a quick start | Lost on restart; not shared between processes, so the CLI cannot edit the app's lists |
| `OrmEmailVerificationStore` | [`@spinajs/email-verification-orm`](../email-verification-orm/README.md) | You already run a SQL database through `@spinajs/orm` | Needs a migration and a connection; clocks of all nodes must agree |
| `RedisEmailVerificationStore` | [`@spinajs/email-verification-redis`](../email-verification-redis/README.md) | You run Redis or Valkey, single node or Sentinel | No Redis Cluster |
| `DynamoDbEmailVerificationStore` | [`@spinajs/email-verification-dynamodb`](../email-verification-dynamodb/README.md) | You run on AWS without a database | Creates its table; lists are chunked items |

Rules of thumb:

- More than one process, or any use of the CLI: use a shared store.
- The ORM store suits apps that already migrate a database at startup.
- Lists reach every process through `listVersion`. `block` and `allow` edits need no cache invalidation because the `list` verifier is never cached. `block-mx` entries act through the cached `dns` verdict, so a new entry reaches an already checked domain only after `dns.ttl.positive` (24 h by default), and a removed one stops refusing after up to `dns.ttl.negative` (1 h by default). The same goes for domains checked before the first sync.

Importing a store package registers it. Import it from a config module, so that the `spinajs` CLI process registers it too ([why](05-cli.md#the-store-package-in-the-cli-process)), and set the class name:

```js
// config/email-verification.js of your app
import '@spinajs/email-verification-orm';

export default {
  emailVerification: {
    enabled: true,
    store: 'OrmEmailVerificationStore',
  },
};
```

`EmailVerification` and the CLI resolve the store with `@AutoinjectService('emailVerification.store', EmailVerificationStore)`, so a class name that no package registered fails at resolve time.

To write your own store, see [Custom verifiers and stores](07-custom-verifiers-and-stores.md#custom-emailverificationstore).

## Related

- [Configuration](02-configuration.md#store-settings): the per-store keys.
- [Checking an email](01-checking-an-email.md): how store errors are handled.
