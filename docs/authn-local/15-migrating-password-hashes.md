# Migrating password hashes

`Argon2PasswordHasher` can verify bcrypt and PBKDF2 hashes imported from another system. A user logs in with the old hash, and the login replaces it with argon2id. Both formats are off until you list them in `authn.local.legacyHashes`.

## How it works

1. You import the old hashes into the password store unchanged. The value is the hash string and nothing else; legacy formats carry no pepper tag.
2. `verify(stored, password)` recognises a legacy string by its shape. When its format is listed in `legacyHashes`, the check runs through the hasher's `ConcurrencyLimiter`, like an argon2 verify, so `maxConcurrent` and `maxQueue` bound it and a full queue rejects with `HasherBusy` (a `throttled` login).
3. `needsRehash()` is `true` for every value that is not argon2id, so after a successful verify the login strategy writes `hash(password)`. The write is a compare-and-set over the legacy value: a reset, change or expiry that stored something newer in the meantime wins. See [Password login](01-password-login.md).
4. From then on the account holds a current argon2id hash, peppered when a pepper is set. The legacy value is gone.

A value in a format that is not listed, or a malformed value, never verifies: the hasher spends an argon2 dummy verify and answers `false`. `verify()` never throws on a bad stored value.

### Accepted formats

| Kind | Stored form | Notes |
| --- | --- | --- |
| `bcrypt` | `$2a$`, `$2b$` or `$2y$`, a two-digit cost from 04 to 31, and 53 characters of salt and hash | Verified with `bcryptjs`. bcrypt reads at most 72 bytes of the password, as at the source. |
| `pbkdf2` | `$pbkdf2-sha256$<iterations>$<salt>$<hash>` | HMAC-SHA256. Salt and hash are base64 (standard, URL-safe, or passlib's `.` variant) with optional padding. The key length is the length of the decoded hash, up to 128 bytes. Iterations: 1 to 10,000,000. |

Only SHA-256 PBKDF2 is read. Other digests and bcrypt's `$2x$` are not verified.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.local.legacyHashes` | `string[]` | `[]` | unique members of `bcrypt`, `pbkdf2` | Foreign formats that verify. Empty: only argon2 verifies. |

```ts
// config/authn.ts in your app
export default {
  authn: {
    local: {
      legacyHashes: ['bcrypt'],
    },
  },
};
```

The constructor seam takes the same list: `new Argon2PasswordHasher({ legacyHashes: ['pbkdf2'] })`. The type of a member is `LegacyHashKind`.

## Important behaviour

- **Off by default.** An imported hash cannot be used until the app opts in, so a stray bcrypt string in the store is not a way in.
- **Verify, then rewrite.** Nothing is rewritten without a correct password. Accounts that never log in keep their legacy hash; use [expiry](08-password-expiry.md) to retire them.
- **Cost is not hidden.** A bcrypt or PBKDF2 verify costs what the imported cost parameters say, not an argon2 verify. A login against a legacy account can therefore take a different time than one against an argon2 account. The A02 equal-timing guarantee holds between unknown accounts and wrong passwords of the same kind of hash.
- **The argon2 cost does not change.** Legacy support adds no cost key.
- **Turn the list off when done.** Once no stored hash is legacy, set `legacyHashes: []`; the verify paths then cost nothing.

## Best practices

- Import hashes as they are. Do not wrap or re-encode them.
- Size `maxConcurrent` for the legacy cost too: a bcrypt cost of 12 holds a slot for longer than the default argon2 verify on some hosts.
- Keep the iteration count of imported PBKDF2 hashes at the source's value; the cap of 10,000,000 only guards against corrupt data.

## Example

### Import a bcrypt column and let logins migrate it

```ts sample
import { DI } from '@spinajs/di';
import { PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

/** Copies hashes from the old system as they are; with `legacyHashes: ['bcrypt']` the first login of each user rewrites them. */
export async function importHashes(rows: readonly { readonly identity: IdentityRef; readonly bcryptHash: string }[]): Promise<void> {
  const passwords = await DI.resolve(PasswordCredentialStore);
  for (const row of rows) {
    await passwords.set(row.identity, row.bcryptHash);
  }
}
```

## Related

- [Password hashing](02-password-hashing.md): the hasher, its limiter and the pepper.
- [Password login](01-password-login.md): the rehash after a successful verify.
- [Password expiry](08-password-expiry.md): force the accounts that never log in to set a new password.
