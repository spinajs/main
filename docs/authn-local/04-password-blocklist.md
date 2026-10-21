# Password blocklist

`PasswordBlocklist` is a hook that refuses known-bad passwords: a breach check, a list of common passwords, words tied to your company. When `authn.local.policy.blocklist` names one, every new password must pass it. One implementation ships, `HibpPasswordBlocklist`, and the shipped config names it outside development and test.

## How it works

1. You write a class that extends `PasswordBlocklist` and register it under that token, for example with `@Injectable(PasswordBlocklist)`.
2. You set `authn.local.policy.blocklist` to the class name.
3. At boot, `LocalPasswordPolicy.resolve()` looks the name up among `DI.getRegisteredTypes(PasswordBlocklist)` by class `name`. No match throws `InvalidOption`.
4. On the first `check()` that reaches the blocklist, the policy resolves the class with `DI.resolve()` and keeps the instance. A resolve that fails is retried on the next check.
5. `check()` calls `isBlocked(password, ctx)` after the length, rule and similarity checks. `ctx` is the `PasswordPolicyContext` the check got, if any. `true` adds the `blocklisted` violation.

The blocklist runs for change, set and reset. It never runs at login, and `generate()` does not consult it.

### HibpPasswordBlocklist

`HibpPasswordBlocklist` checks the password against the [Have I Been Pwned](https://haveibeenpwned.com/API/v3#PwnedPasswords) range API:

1. It hashes the password with SHA-1 and upper-cases the hex digest.
2. It sends `GET <authn.local.hibp.url><first 5 characters>` with the header `Add-Padding: true`, through the global `fetch`, with a timeout of `authn.local.hibp.timeoutMs`. Only the 5-character prefix leaves the process (k-anonymity); the answer lists every suffix with that prefix and its breach count, plus padding rows with a count of 0.
3. A listed suffix with a count above 0 blocks the password.
4. It fails open. A timeout, a network error or an answer that is not 2xx (a redirect included) lets the password through and logs one warning on the `authn-local` logger. The warning names the reason, never the password or its hash.

The shipped `authn.local.policy.blocklist` is `'HibpPasswordBlocklist'` unless the app env is development or test (decision D3, Ory Kratos parity). The env is read when the configuration loads this package's config file, the way the configuration names it: `--env`, then `APP_ENV`, then `NODE_ENV`, and development when none is set.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.local.policy.blocklist` | `string \| null` | `'HibpPasswordBlocklist'` outside development and test, else `null` | the class name of a registered `PasswordBlocklist` | The blocklist to apply. `null` or `''`: none. |
| `authn.local.hibp.url` | `string` | `'https://api.pwnedpasswords.com/range/'` | non-empty | The range endpoint; the 5-character prefix is appended. Point it at a mirror to keep the check inside your network. |
| `authn.local.hibp.timeoutMs` | `integer` | `2000` | `>= 1` | Past it the check lets the password through. |

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

```ts
// config/authn.ts: turn the breach check off in production, or keep it on in development
export default {
  authn: { local: { policy: { blocklist: null } } },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Blocklist | `PasswordBlocklist`; the class is found by name at boot and resolved once, on first use, with the lifetime of its own decorators | `HibpPasswordBlocklist` outside development and test | your `PasswordBlocklist` | Extend `PasswordBlocklist`, implement `isBlocked(password, ctx?): Promise<boolean>`, register it under `PasswordBlocklist` before the boot resolves the policy, and name it in `authn.local.policy.blocklist`. Subclass `HibpPasswordBlocklist` to change its warning (`passUnchecked()`) or where it reads its settings (`url()`, `timeoutMs()`). |

`new HibpPasswordBlocklist({ url?, timeoutMs?, log? })` reads no configuration; a missing field falls back to `AUTHN_LOCAL_DEFAULTS.hibp`.

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
- **An error from `isBlocked()` is not caught.** The password flow that called `check()` fails with it. `HibpPasswordBlocklist` never throws: it fails open.
- **The breach check makes an outbound HTTPS call** on every change, set, reset and invite redeem outside development and test. A slow or unreachable endpoint adds up to `timeoutMs` to the request and then lets the password through.
- **The password reaches your code in clear.** It is never trimmed or normalised.
- **Above 1024 code points `isBlocked()` is not called.** The check answers `too_long` first.

## Best practices

- Keep class names stable in production builds: a minifier that renames classes breaks the lookup.
- Keep `HibpPasswordBlocklist` on in production. Behind an egress firewall, allow `api.pwnedpasswords.com` or point `authn.local.hibp.url` at a mirror; otherwise every check times out and passes.
- For your own remote check, send only a hash prefix (k-anonymity), never the password, and set a timeout: a hanging call holds up the change or reset.
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
