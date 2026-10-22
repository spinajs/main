# `@spinajs/email-verification`

Refuses email addresses whose domain cannot receive mail, is on a block list, or was registered a few days ago. `EmailVerification.check(email)` runs an ordered chain of domain verifiers and returns one verdict.

It checks the **domain only**. It does **not** probe the mailbox over SMTP, call a vendor mailbox API or detect catch-all servers, and the full address never leaves the process. It ships no HTTP admin API for the lists; use the [CLI](05-cli.md).

## Install

```sh
npm install @spinajs/email-verification
```

Add a store package when the verdict cache and the lists must be shared between processes: [`-orm`](../email-verification-orm/README.md), [`-redis`](../email-verification-redis/README.md) or [`-dynamodb`](../email-verification-dynamodb/README.md). The built-in `MemoryEmailVerificationStore` keeps everything in one process.

## Features

| Feature | What it does |
| --- | --- |
| [Checking an email](01-checking-an-email.md) | `EmailVerification.check()` and `explain()`: the flow, the result shape, caching, timeouts, `onError` |
| [Configuration](02-configuration.md) | Every `emailVerification.*` key with its type and default |
| [Verifiers](03-verifiers.md) | `ListVerifier`, `DnsVerifier`, `RdapVerifier` and `HttpDomainVerifier`: what each answers and how long it caches |
| [Domain lists and sync](04-domain-lists-and-sync.md) | List kinds, sources, `DomainListSync`, its safety checks, the scheduled sync and the trust note |
| [CLI](05-cli.md) | The `email-verification:*` commands |
| [Choosing a store](06-choosing-a-store.md) | Memory, ORM, Redis or DynamoDB |
| [Custom verifiers and stores](07-custom-verifiers-and-stores.md) | Write a `DomainVerifier` or an `EmailVerificationStore` and run `storeContract` |

## Quick start

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { EmailVerification } from '@spinajs/email-verification';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      emailVerification: {
        enabled: true,
        verifiers: [{ service: 'ListVerifier' }, { service: 'DnsVerifier' }, { service: 'RdapVerifier' }],
      },
    });
  }
}

/** Returns the client-safe error code, or null when the address may register. */
export async function registrationRefusal(email: string): Promise<string | null> {
  const verification = await DI.resolve(EmailVerification);
  const result = await verification.check(email);
  return result.allowed ? null : result.code;
}
```

`enabled` defaults to `false`: `check()` then allows everything. Importing `@spinajs/email-verification` registers its configuration schema, the four verifiers and the in-memory store.

## Related packages

- [`@spinajs/email-verification-orm`](../email-verification-orm/README.md), [`-redis`](../email-verification-redis/README.md), [`-dynamodb`](../email-verification-dynamodb/README.md): shared stores.
- [`@spinajs/configuration`](../configuration/08-config-selected-services.md): how `@AutoinjectService` picks the store and the verifiers by class name.
- [`@spinajs/cli`](../cli/README.md): hosts the `email-verification:*` commands.
