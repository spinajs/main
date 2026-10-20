# Password hashing

`Argon2PasswordHasher` hashes and verifies every password of this package: login, change, set, reset and the rehash. It uses argon2id at the argon2 library defaults, an optional HMAC-SHA256 pepper that can rotate, and a cap on how many argon2 operations run at once.

## How it works

**Hash** (`hash(password)`):

1. With a current pepper, the argon2 input is `HMAC-SHA256(pepper.secret, password)`, the raw 32 bytes (`pepperInput()`). Without one, it is the password.
2. `argon2.hash()` runs through the hasher's `ConcurrencyLimiter` with no options, so the cost is the library default.
3. `formatStored()` prefixes the pepper version: `$sp<version>$` followed by the argon2 PHC string. Without a pepper the PHC string is stored as is.

**Verify** (`verify(stored, password)`):

1. `parseStored(stored)` reads the optional `$sp<version>$` tag and checks the argon2 PHC shape. It answers `null` for anything else.
2. The pepper is looked up by version: the current one or an entry of `pepper.previous`. No tag means no pepper.
3. When the value cannot match (`null`, the `!expired` marker, a malformed value, an unknown pepper version), the hasher verifies the password against its dummy hash and answers `false`.
4. Otherwise `argon2.verify()` runs through the limiter. When argon2 still refuses the stored string, a dummy verify runs and the answer is `false`.

**Needs rehash** (`needsRehash(stored)`) is `true` when the value does not parse, its pepper version differs from the current one (also unpeppered under a pepper, or peppered without one), it is not argon2id, or `argon2.needsRehash()` says its parameters are not the library defaults. The login strategy calls it after a successful verify; see [Password login](01-password-login.md).

**Boot.** `resolve()` makes the dummy hash once, with the current pepper and the same parameters as a real hash, so a dummy verify costs what a real one costs.

```text
$sp2$$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
└┬─┘ └───────────────── argon2 PHC string ─────────┘
 pepper version 2
```

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.local.hasher.maxConcurrent` | `integer` | `8` | `>= 1` | Argon2 operations at once (hash, verify and dummy verify); the rest wait in FIFO order. Each takes 64 MiB. |
| `authn.local.hasher.service` | `string` | not set | | Accepted by the schema; no code reads it. The hasher is chosen by DI registration. |
| `authn.local.pepper.secret` | `string \| null` | `null` | a non-empty secret reference, or `null` | The current pepper. `null`: no pepper. An empty string is refused. |
| `authn.local.pepper.version` | `integer` | `1` | `1` to `999999999` | Written into every new hash as `$sp<version>$`. |
| `authn.local.pepper.previous` | `{ secret, version }[]` | `[]` | each `version` unique and different from `pepper.version` | Older peppers. Hashes made under them still verify and are rehashed on the next login. |

No key sets the argon2 cost (memory, time, parallelism). Small hosts lower `maxConcurrent`, never the cost.

`pepper.secret` is a reference the configuration resolves, never an inline value. See [Config var protocols](../configuration/05-config-var-protocols.md).

```ts
// config/authn.ts in your app
export default {
  authn: {
    local: {
      hasher: { maxConcurrent: 4 },
      pepper: {
        secret: 'aws-parameters://prod/authn/pepper-2',
        version: 2,
        previous: [{ secret: 'aws-parameters://prod/authn/pepper-1', version: 1 }],
      },
    },
  },
};
```

### Rotate the pepper

1. Store the new pepper in your secret store.
2. Move the current `{ secret, version }` into `pepper.previous`.
3. Set `pepper.secret` to the new reference and raise `pepper.version`.
4. Each user's hash is rewritten under the new pepper on their next successful login.
5. Remove an entry from `previous` only when no stored hash carries its version: such hashes stop verifying.

Setting `pepper.secret` to `null` stops peppering new hashes. Keep the old pepper in `previous`, or hashes made under it stop verifying.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Hasher | `PasswordHasher`, singleton, `@Injectable(PasswordHasher)` on import; injected into `LocalPasswordStrategy` and `LocalPasswordService` (`@Autoinject`) | `Argon2PasswordHasher` | none shipped | `DI.register(MyHasher).as(PasswordHasher)` after importing `@spinajs/authn-local` and before the boot resolves the strategies. Subclass `Argon2PasswordHasher` and override `verify()` or `needsRehash()` to keep the argon2 path. |

`PasswordHasher` is an abstract `AsyncService` with three methods:

| Method | Contract |
| --- | --- |
| `hash(password)` | Returns the value to store. |
| `verify(stored, password)` | `false` for a wrong password and for any stored value that cannot match (`null`, `!expired`, malformed). Costs the same as a real verify and never throws on a bad stored value. |
| `needsRehash(stored)` | `true` when a verified hash should be replaced by a fresh `hash()`. |

`Argon2PasswordHasher` adds:

- `hashWith(password, { argon2?, pepper? })`: a hash in the stored format under explicit argon2 cost or another pepper (`null`: none). For tests and data migrations; production code calls `hash()`.
- `limiter`: the `ConcurrencyLimiter`, with `active`, `queued`, `peak` and `runs` counters.
- A constructor seam: `new Argon2PasswordHasher({ maxConcurrent?, pepper? })` reads no configuration. `maxConcurrent` defaults to `AUTHN_LOCAL_DEFAULTS.hasher.maxConcurrent` there, the schema default (8).

The stored-format helpers are exported: `pepperInput()`, `formatStored()`, `parseStored()`, and `EXPIRED_PASSWORD_MARKER` (`'!expired'`).

### Hasher: custom implementation

Accept hashes imported from a legacy system until each user logs in once. Keep argon2 for everything else, and keep a failed legacy check as expensive as an argon2 verify.

```ts sample
import { createHash, timingSafeEqual } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Argon2PasswordHasher, PasswordHasher } from '@spinajs/authn-local';

const LEGACY = '$legacy-sha256$';

/** Verifies `$legacy-sha256$<salt>$<hex>` values from the old CRM; the login strategy then rehashes them to argon2id. */
export class LegacyImportHasher extends Argon2PasswordHasher {
  public async verify(stored: string | null | undefined, password: string): Promise<boolean> {
    if (typeof stored !== 'string' || !stored.startsWith(LEGACY)) {
      return super.verify(stored, password);
    }

    // Spend the work of an argon2 verify, so legacy accounts are not faster to probe.
    await super.verify(null, password);

    const [salt, hex] = stored.slice(LEGACY.length).split('$');
    const expected = Buffer.from(hex ?? '', 'hex');
    const actual = createHash('sha256').update(`${salt}${password}`, 'utf8').digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

DI.register(LegacyImportHasher).as(PasswordHasher);
```

`needsRehash()` of the base class already answers `true` for a value that is not argon2, so the first login rewrites the legacy hash.

## Important behaviour

- **The cost is fixed.** argon2id at the argon2 library defaults: 64 MiB, `t=3`, `p=4`. A test pins the stored prefix `$argon2id$v=19$m=65536,t=3,p=4$`, so a library upgrade that changes the defaults fails CI.
- **Peak memory is `maxConcurrent` × 64 MiB.** With the default 8, that is 512 MiB of argon2 work at once.
- **Every operation shares one cap.** Hashes, verifies and dummy verifies all queue in the same `ConcurrencyLimiter`. Under load, logins wait their turn instead of running out of memory.
- **The queue is FIFO and fair.** A finishing task hands its slot to the oldest waiter, never to a newcomer.
- **Failed checks cost the same as real ones (A02).** An unparseable value, an expired password and an unknown pepper version run a dummy verify.
- **`verify()` never throws on a bad stored value.** It answers `false`.
- **The pepper changes the argon2 input.** A hash under one pepper does not verify under another with the same version.
- **An unpeppered hash still verifies under a pepper** and is rehashed with the pepper on the next login.
- **The dummy hash is made at boot** when DI resolves the hasher, and is retried on the next use when it fails.

## Best practices

- Size `maxConcurrent` to the memory you can give argon2: a 1 GiB container with other work needs a lower value than 8.
- Watch `limiter.queued` and `limiter.peak` under load: a long queue means logins are waiting for argon2, not the database.
- Rotate the pepper by adding a version, never by changing the secret of an existing version.

## Patterns and antipatterns

```ts
// Don't: a pepper written inline ends up in the repository and every config dump.
authn: { local: { pepper: { secret: 'p3pp3r-0123456789', version: 1 } } }

// Do: a reference the configuration resolves at load time.
authn: { local: { pepper: { secret: 'aws-parameters://prod/authn/pepper-1', version: 1 } } }
```

## Examples

### Report argon2 pressure on a health endpoint

```ts sample
import { DI } from '@spinajs/di';
import { Argon2PasswordHasher, PasswordHasher } from '@spinajs/authn-local';

/** Argon2 queue figures for an ops dashboard; empty when another hasher is registered. */
export async function argon2Pressure(): Promise<Record<string, number>> {
  const hasher = await DI.resolve(PasswordHasher);
  if (!(hasher instanceof Argon2PasswordHasher)) {
    return {};
  }

  const { max, active, queued, peak, runs } = hasher.limiter;
  return { max, active, queued, peak, runs };
}
```

### Hash imported passwords without a pepper in a migration script

```ts sample
import { Argon2PasswordHasher } from '@spinajs/authn-local';

/** Hashes a batch of plain passwords from a vendor export, under no pepper, so the first login applies the current one. */
export async function hashImported(passwords: readonly string[]): Promise<string[]> {
  const hasher = new Argon2PasswordHasher({ maxConcurrent: 2 });
  return Promise.all(passwords.map((p) => hasher.hashWith(p, { pepper: null })));
}
```

## Related

- [Password login](01-password-login.md): where `verify()` and `needsRehash()` run.
- [Password expiry](08-password-expiry.md): the `!expired` marker that never verifies.
- [Config var protocols](../configuration/05-config-var-protocols.md): how a secret reference such as `aws-parameters://` resolves.
- [`@spinajs/authn`](../authn/README.md): the `authn.local` schema that validates these keys.
