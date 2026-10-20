# `@spinajs/session-provider-dynamodb`

A session store for `@spinajs/authn-session` that keeps one DynamoDB item per session, through the AWS SDK v3 client.

It only stores sessions. It does **not** issue, hash or rotate session ids, pick expiration times or set cookies: `SessionIssuer` and the expiration strategy in `@spinajs/authn-session` do that.

## Install

```sh
npm install @spinajs/session-provider-dynamodb
```

## Features

| Feature | What it does |
| --- | --- |
| [DynamoDB session store](01-dynamodb-session-store.md) | `DynamoDbSessionProvider`: config, item layout, every store operation, how to select, replace or subclass it. |
| [Client and table provisioning](02-client-and-table-provisioning.md) | Builds the `DynamoDBClient`, creates the table with TTL on boot and turns TTL on for an existing table; the `createClient` and table hooks you override. |
| [Subject lookup](03-subject-lookup.md) | How `listBySubject` and `deleteBySubject` find a user's sessions with a consistent `Scan`, and how to swap it for an index `Query`. |

## Quick start

Select the store and name the table in your configuration:

```ts
authn: {
  session: {
    service: 'DynamoDbSessionProvider',
    aws: {
      table: 'app_sessions',
      config: { region: 'eu-central-1' },
    },
  },
}
```

Import the package once so its `@Injectable` registers the store, then use sessions through `SessionIssuer`:

```ts sample
import '@spinajs/session-provider-dynamodb';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';

// Sign a user out on every device, including sessions where they impersonate someone.
export async function signOutEverywhere(userUuid: string): Promise<number> {
  const issuer = await DI.resolve(SessionIssuer);
  return issuer.revokeAll({ type: 'user', id: userUuid }, { includeImpersonations: true });
}
```

## Related packages

- [`@spinajs/authn-session`](../authn-session/README.md): session ids, states, expiration strategies and the `authn.session.*` keys this store shares.
- [`@spinajs/authn`](../authn/README.md): the `SessionIssuer` contract the issuer implements on top of this store.
- `@spinajs/session-provider-db` and `@spinajs/session-provider-redis`: the other shipped `SessionProvider` stores (SQL and Redis).
- [`@spinajs/configuration`](../configuration/08-config-selected-services.md): `@AutoinjectService`, which selects the store by name from `authn.session.service`.
- [`@spinajs/di`](../di/04-lifetimes.md): the singleton lifetime the store gets from `@Injectable`.
