# CLI

Six commands, run through the `spinajs` bin (`npx spinajs <command>`). The package registers its command directory in `system.dirs.cli`. They use the store from `emailVerification.store`, so run them with the same configuration as the app, and make the CLI process import the store package ([below](#the-store-package-in-the-cli-process)).

| Command | Arguments and options | Effect |
| --- | --- | --- |
| `email-verification:check <email>` | | Prints each verifier's live answer. Reads and writes no cache. |
| `email-verification:sync [source]` | optional source name | Downloads the configured lists into the store |
| `email-verification:block <domains...>` | `--mx` | Adds domains to the `admin` `block` list; with `--mx`, to `block-mx` |
| `email-verification:allow <domains...>` | | Adds domains to the `admin` `allow` list |
| `email-verification:unlist <domains...>` | `--kind <kind>` (required), `--source <source>` (default `admin`) | Removes domains from one list |
| `email-verification:list` | `--kind <kind>`, `--source <source>` | Prints the stored entries |

`<kind>` is `block`, `allow` or `block-mx`. Domains are normalised first (case, trailing dot, punycode); a value that is not a domain fails the command with `not a domain: ...`.

## The store package in the CLI process

`npx spinajs` is its own process. It loads the config files, but not your app's entry module, so a store package that only the app imports is never registered there, and `emailVerification.store` (say `RedisEmailVerificationStore`) cannot resolve. Settings merged in a `FrameworkConfiguration` subclass are missing too.

Import the store package from a config module, which both the app and the CLI load, and keep the `emailVerification` settings in it:

```js
// config/email-verification.js of your app
import '@spinajs/email-verification-redis';

export default {
  emailVerification: {
    enabled: true,
    store: 'RedisEmailVerificationStore',
    redis: { host: '10.0.0.12', port: 6379, password: process.env.REDIS_PASSWORD },
  },
};
```

Run the CLI with the same `--app` and `--env` as the app, so it reads the same config. A config module that fails to import is logged and counts as empty, so a missing store package shows as the store failing to resolve. A module in a directory of your app's `system.dirs.cli` that imports the store package works as well, because the CLI imports every file there before it runs a command; it does not help the app itself.

## Output

- `check` prints `domain <domain>` (or `domain (invalid)`), then one line per verifier: `<verifier> <result> [reason] [source] [error]`.
- `sync` prints `<source> <status> [count] [error]` per source and sets exit code 1 when a source failed. `refused` and `unchanged` keep exit code 0.
- `list` prints `<kind> <source> <domain>`, sorted, to stdout.
- `block`, `allow` and `unlist` log the number of domains changed.

## Examples

### Allow a partner domain that a list wrongly blocks

```sh
npx spinajs email-verification:allow partner.example
npx spinajs email-verification:check someone@partner.example
```

### Block a throwaway-mail MX host

```sh
npx spinajs email-verification:block --mx mail.throwaway.example
```

### Run the sync from cron

```sh
npx spinajs email-verification:sync disposable-email-domains
```

## Important behaviour

- Every entry the CLI writes has source `admin`. A sync never overwrites or removes it.
- `block` and `allow` edits reach running processes within `lists.refreshSeconds`. A `block-mx` edit acts through the cached `dns` verdict: a domain already checked sees a new entry only after `dns.ttl.positive` (24 h by default), and a removed entry stops refusing after up to `dns.ttl.negative` (1 h by default).
- With `MemoryEmailVerificationStore` the CLI process has its own empty store, so list commands change nothing the app sees. Use a shared store.

## Related

- [Domain lists and sync](04-domain-lists-and-sync.md)
- [`@spinajs/cli`](../cli/02-commands.md): how commands are discovered and run.
