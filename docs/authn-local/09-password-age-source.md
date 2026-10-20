# Password age source

`PasswordAgeSource` tells the [expiry job](08-password-expiry.md) which passwords were set before a cutoff. authn-local stores no dates, so the identity system answers: `@spinajs/users` ships `UserPasswordAgeSource`. Without a source, the job does nothing.

## How it works

1. `PasswordExpirationJob` injects `PasswordAgeSource` with `@Autoinject(PasswordAgeSource, { optional: true })`.
2. `run(now)` computes `cutoff = now − maxAgeDays` and calls `passwordsSetBefore(cutoff)`.
3. The source answers the `IdentityRef`s whose password was set before `cutoff`.
4. The job reads each stored value and skips identities with no password or the `!expired` marker, so a source may list them.

With no source registered, `run()` logs a warning and answers `{ idle: 'no_source', expired: 0, skipped: 0, failed: 0 }`.

## Configuration

The source reads no `authn.local` key. The cutoff comes from `authn.local.expiration.maxAgeDays`; see [Password expiry](08-password-expiry.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Age source | `PasswordAgeSource`, singleton, optional; injected into `PasswordExpirationJob` | none in this package; `UserPasswordAgeSource` when `@spinajs/users` is imported | your `PasswordAgeSource` | `DI.register(MySource).as(PasswordAgeSource)`, or subclass `UserPasswordAgeSource` and filter its answer. Register before the job is first resolved. |

`UserPasswordAgeSource` reads `users.PasswordSetAt`; see [Identity and password stores](../users/07-identity-and-password-stores.md).

### Age source: custom implementation

An app without `@spinajs/users` keeps password dates in its own account service.

```ts sample
import { DI } from '@spinajs/di';
import type { IdentityRef } from '@spinajs/authn';
import { PasswordAgeSource } from '@spinajs/authn-local';

interface AccountDirectory {
  /** Account ids whose password changed before `cutoff`, or never had a recorded change. */
  idsWithPasswordSetBefore(cutoff: Date): Promise<string[]>;
}

export class DirectoryPasswordAgeSource extends PasswordAgeSource {
  constructor(private readonly directory: AccountDirectory) {
    super();
  }

  public async passwordsSetBefore(cutoff: Date): Promise<readonly IdentityRef[]> {
    const ids = await this.directory.idsWithPasswordSetBefore(cutoff);
    return ids.map((id) => ({ type: 'user', id }));
  }
}

export function useDirectoryAges(directory: AccountDirectory): void {
  DI.register(() => new DirectoryPasswordAgeSource(directory)).as(PasswordAgeSource);
}
```

## Important behaviour

- **Optional.** No source means no expiry: the job answers `idle: 'no_source'` and logs a warning.
- **The source decides who is old.** The job expires every identity it lists that still holds a password hash.
- **Listing too many is safe for password-less identities only.** An identity without a password, or already expired, is skipped. Any other listed identity is expired and mailed.

## Best practices

- Treat an unknown set date as old, as `UserPasswordAgeSource` does: a lost write must not exempt a password from expiry.
- Leave out deleted accounts in the source, so the job does not touch them.
- Exclude accounts that must never expire (service or kiosk users) in the source, not in the job.

## Patterns and antipatterns

```ts
// Don't: listing every user expires every password that is not already expired.
public async passwordsSetBefore(): Promise<readonly IdentityRef[]> {
  return (await directory.allIds()).map((id) => ({ type: 'user', id }));
}

// Do: honour the cutoff.
public async passwordsSetBefore(cutoff: Date): Promise<readonly IdentityRef[]> {
  return (await directory.idsWithPasswordSetBefore(cutoff)).map((id) => ({ type: 'user', id }));
}
```

## Related

- [Password expiry](08-password-expiry.md): the job that calls the source.
- [`@spinajs/users`](../users/07-identity-and-password-stores.md): `UserPasswordAgeSource` and a subclass that never expires service accounts.
