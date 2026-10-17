# `@spinajs/session-provider-redis`

A Redis session store for `@spinajs/authn-session`. `RedisSessionStore` implements `SessionProvider` over [ioredis](https://github.com/redis/ioredis): one JSON string key per session, plus one set per subject and per impersonator for revocation.

It does **not** issue, hash or rotate session ids, and it does not set cookies: `DefaultSessionIssuer` in `@spinajs/authn-session` does that and calls this store for storage. It runs against one Redis server or a Sentinel group; Redis Cluster is **not** supported.

## Install

```sh
npm install @spinajs/session-provider-redis @spinajs/authn-session ioredis
```

## Features

| Feature | What it does |
| --- | --- |
| [Redis session store](01-redis-session-store.md) | `RedisSessionStore`: selection by `authn.session.service`, the connection config, the key layout, save, restore, the compare-and-set touch, revocation by subject, truncate |
| [2.x sessions and the boot sweep](02-legacy-session-sweep.md) | `sweepLegacy()`: indexes rows written by 2.x so a ban or password reset reaches them, and the rolling-upgrade window |
| [Extending the Redis store](03-extending-the-redis-store.md) | Every extension point: the `SessionProvider` token, subclassing `RedisSessionStore`, the `createClient()` hook, the key layout hooks, the expiration strategy |

## Quick start

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { RedisSessionStore } from '@spinajs/session-provider-redis';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      authn: {
        session: {
          service: 'RedisSessionStore',
          expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 },
          redis: { host: '10.0.0.12', port: 6379, password: process.env.REDIS_PASSWORD, db: 2, keyPrefix: 'shop:' },
        },
      },
    });
  }
}

/** Number of devices a customer is signed in on, for the support panel. */
export async function activeDeviceCount(userUuid: string): Promise<number> {
  const store = await DI.resolve(RedisSessionStore);
  const sessions = await store.listBySubject({ type: 'user', id: userUuid });
  return sessions.length;
}
```

Importing `@spinajs/session-provider-redis` registers `RedisSessionStore`. `authn.session.service: 'RedisSessionStore'` makes the session issuer use it, and `authn.session.redis` goes to `new Redis()` as is.

## Related packages

- [`@spinajs/authn`](../authn/README.md#sessions): the session contract, the issuer, ids, states and revocation this store serves.
- [`@spinajs/session-provider-db`](../session-provider-db/README.md), [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/README.md): the other shipped `SessionProvider` stores.
- [`@spinajs/configuration`](../configuration/08-config-selected-services.md): how `@AutoinjectService` picks the store by name.
- [`@spinajs/log`](../log/README.md): the `redis-session-store` logger the store writes to.
