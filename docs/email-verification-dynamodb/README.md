# `@spinajs/email-verification-dynamodb`

A DynamoDB store for [`@spinajs/email-verification`](../email-verification/README.md), built on the AWS SDK v3 (`@aws-sdk/client-dynamodb`). `DynamoDbEmailVerificationStore` keeps cached verdicts, domain lists and sync state in one table, and can create that table for you.

It uses `GetItem`, `PutItem`, `DeleteItem` and conditional writes only: no `Scan`, no transactions.

## Install

```sh
npm install @spinajs/email-verification @spinajs/email-verification-dynamodb
```

## Features

| Feature | What it does |
| --- | --- |
| [DynamoDB store](01-dynamodb-store.md) | Selection and client config, table creation and TTL, the item layout, chunked list generations, the damaged-source error |

## Quick start

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/email-verification-dynamodb';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      emailVerification: {
        enabled: true,
        store: 'DynamoDbEmailVerificationStore',
        dynamodb: { table: 'shop-email-verification', config: { region: 'eu-central-1' } },
      },
    });
  }
}
```

The `spinajs` CLI does not load your app's entry module, so it never uses this class, and the `email-verification:*` commands would not see the store. To use them, import the package and set these keys in a config module instead: see [The store package in the CLI process](../email-verification/05-cli.md#the-store-package-in-the-cli-process).

## Related packages

- [`@spinajs/email-verification`](../email-verification/README.md): the service, verifiers and the store contract.
- [`@spinajs/email-verification-orm`](../email-verification-orm/README.md), [`@spinajs/email-verification-redis`](../email-verification-redis/README.md): the other shared stores.
- [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/README.md): the same table provisioning approach for sessions.
