# `@spinajs/email-verification-redis`

A Redis (or Valkey) store for [`@spinajs/email-verification`](../email-verification/README.md), built on [ioredis](https://github.com/redis/ioredis). `RedisEmailVerificationStore` keeps cached verdicts, domain lists and sync state in Redis keys.

It runs against one Redis server or a Sentinel group. Redis **Cluster is not supported**: the store uses multi-key transactions and `RENAME`, which Cluster rejects across slots.

## Install

```sh
npm install @spinajs/email-verification @spinajs/email-verification-redis ioredis
```

## Features

| Feature | What it does |
| --- | --- |
| [Redis store](01-redis-store.md) | Selection and connection config, the key layout, verdict TTLs, atomic list replace, shutdown |

## Quick start

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/email-verification-redis';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      emailVerification: {
        enabled: true,
        store: 'RedisEmailVerificationStore',
        redis: { host: '10.0.0.12', port: 6379, password: process.env.REDIS_PASSWORD, keyPrefix: 'shop:ev:' },
      },
    });
  }
}
```

The `spinajs` CLI does not load your app's entry module, so it never uses this class, and the `email-verification:*` commands would not see the store. To use them, import the package and set these keys in a config module instead: see [The store package in the CLI process](../email-verification/05-cli.md#the-store-package-in-the-cli-process).

## Related packages

- [`@spinajs/email-verification`](../email-verification/README.md): the service, verifiers and the store contract.
- [`@spinajs/email-verification-orm`](../email-verification-orm/README.md), [`@spinajs/email-verification-dynamodb`](../email-verification-dynamodb/README.md): the other shared stores.
- [`@spinajs/session-provider-redis`](../session-provider-redis/README.md): the same ioredis setup for sessions.
