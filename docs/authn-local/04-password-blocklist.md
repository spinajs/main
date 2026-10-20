# Password blocklist

`PasswordBlocklist` is an optional hook that refuses known-bad passwords: a list of common passwords, a breach check, words tied to your company. When `authn.local.policy.blocklist` names one, every new password must pass it. No implementation ships.

## How it works

1. You write a class that extends `PasswordBlocklist` and register it under that token, for example with `@Injectable(PasswordBlocklist)`.
2. You set `authn.local.policy.blocklist` to the class name.
3. At boot, `LocalPasswordPolicy.resolve()` looks the name up among `DI.getRegisteredTypes(PasswordBlocklist)` by class `name`. No match throws `InvalidOption`.
4. On the first `check()` that reaches the blocklist, the policy resolves the class with `DI.resolve()` and keeps the instance. A resolve that fails is retried on the next check.
5. `check()` calls `isBlocked(password)` after the length and rule checks. `true` adds the `blocklisted` violation.

The blocklist runs for change, set and reset. It never runs at login, and `generate()` does not consult it.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.local.policy.blocklist` | `string \| null` | `null` | the class name of a registered `PasswordBlocklist` | The blocklist to apply. `null` or `''`: none. |

```ts
// config/authn.ts in your app
export default {
  authn: {
    local: {
      policy: { blocklist: 'CommonPasswordBlocklist' },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Blocklist | `PasswordBlocklist`; the class is found by name at boot and resolved once, on first use, with the lifetime of its own decorators | none | your `PasswordBlocklist` | Extend `PasswordBlocklist`, implement `isBlocked(password): Promise<boolean>`, register it under `PasswordBlocklist` before the boot resolves the policy, and name it in `authn.local.policy.blocklist`. |

### Blocklist: custom implementation

Refuse the 10,000 most common passwords from a file shipped with the app.

```ts sample
import { readFile } from 'node:fs/promises';
import { Injectable } from '@spinajs/di';
import { PasswordBlocklist } from '@spinajs/authn-local';

/** Refuses any password on the common-passwords list, compared without case. */
@Injectable(PasswordBlocklist)
export class CommonPasswordBlocklist extends PasswordBlocklist {
  private list?: Promise<Set<string>>;

  public async isBlocked(password: string): Promise<boolean> {
    this.list ??= readFile('./data/common-passwords.txt', 'utf8').then((text) => new Set(text.split(/\r?\n/).map((line) => line.toLowerCase())));
    return (await this.list).has(password.toLowerCase());
  }
}

// config/authn.ts: authn.local.policy.blocklist: 'CommonPasswordBlocklist'
```

## Important behaviour

- **Lookup is by class name.** The config value must equal the class's `name` at run time.
- **A wrong name fails the boot**, through `LocalPasswordPolicy.resolve()`, not the first password change.
- **An error from `isBlocked()` is not caught.** The password flow that called `check()` fails with it.
- **The password reaches your code in clear.** It is never trimmed or normalised.
- **Above 1024 code points `isBlocked()` is not called.** The check answers `too_long` first.

## Best practices

- Keep class names stable in production builds: a minifier that renames classes breaks the lookup.
- For a remote breach check, send only a hash prefix (k-anonymity), never the password, and set a timeout: a hanging call holds up the change or reset.
- Load a large list once and keep it in memory, as in the example; `isBlocked()` runs on every change, set and reset.

## Patterns and antipatterns

```ts
// Don't: a registered blocklist that no config names never runs.
@Injectable(PasswordBlocklist)
export class CommonPasswordBlocklist extends PasswordBlocklist { /* ... */ }

// Do: name it as well.
// config/authn.ts
authn: { local: { policy: { blocklist: 'CommonPasswordBlocklist' } } }
```

## Related

- [Password policy](03-password-policy.md): where the blocklist runs in `check()`.
- [Change and set](05-change-and-set.md), [Reset and invite](06-reset-and-invite.md): the flows that answer `rejected` with `blocklisted`.
