# `@spinajs/session-provider-redis`

Redis session store (`RedisSessionStore`) for `@spinajs/authn-session`, built on ioredis.

```sh
npm install @spinajs/session-provider-redis @spinajs/authn-session ioredis
```

Select it with `authn.session.service: 'RedisSessionStore'` and configure the connection under `authn.session.redis`.

## Documentation

- [Package overview](../../docs/session-provider-redis/README.md)
- [Redis session store](../../docs/session-provider-redis/01-redis-session-store.md)
- [Extending the Redis store](../../docs/session-provider-redis/03-extending-the-redis-store.md)
