# CLI commands

Two `spinajs` commands: `authn:password` sets the password of an identity, and `authn:password-expire` runs the expiry job. The package config adds its `cli` directory to `system.dirs.cli`, so the [CLI](../cli/README.md) discovers them.

## How it works

### `authn:password <login> [-g, --generate]`

1. `IdentityStore.findByLogin(login)`. No identity: logs an error and throws `InvalidArgument`, so the command exits non-zero. The login is not echoed.
2. The password:
   - with `--generate`: `LocalPasswordPolicy.generate()`;
   - without it: the first line of standard input, with only the line ending removed. On a terminal it first prompts on standard error; the typed text is visible.
3. `PasswordService.set(id, password, { now, purpose: 'request' }, { actor: { type: 'service', id: 'cli' } })`. Every session of the identity ends and, under `authn.local.reset.revokeTokens`, every token.
4. A policy violation logs the violations and throws `InvalidArgument`: the command exits non-zero and the stored password is unchanged. The password is never echoed.
5. On success it logs `Password set for <type> <id>`. With `--generate` it also writes the password once to standard output, never to the logger.

The password is never a command-line argument, which would stay in the shell history. A second argument fails the command.

### `authn:password-expire`

1. Resolves `PasswordExpirationJob` and calls `run()`.
2. Logs one of:
   - `Password expiry is disabled (authn.local.expiration.enabled)`;
   - `No PasswordAgeSource is registered; nothing was expired`;
   - `Passwords expired: <n>, already expired: <n>, failed: <n>`.

Both commands resolve their services when they run, not when the CLI lists commands, so `spinajs --help` works with a broken policy config.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.cli` | `string[]` | the package's `lib/<mjs\|cjs>/cli` directory, under the workspace root and one level up | | Shipped by the package config; makes the commands discoverable. |
| `authn.local.generator.*` | | | | Used by `--generate`; see [Password policy](03-password-policy.md#configuration). |
| `authn.local.expiration.*` | | | | Used by `authn:password-expire`; see [Password expiry](08-password-expiry.md#configuration). |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Password setting | `PasswordService`, resolved per run | `LocalPasswordService` | | See [Password service](11-password-service.md). |
| Expiry job | `PasswordExpirationJob`, resolved per run | `PasswordExpirationJob` | | See [Password expiry](08-password-expiry.md). |

The command classes (`SetUserPassword`, `ExpirePasswords`) are not exported from the package entry.

## Important behaviour

- **Passwords are never trimmed.** Only the trailing `\n` or `\r\n` is removed from the input line; spaces stay.
- **A generated password is shown once,** on standard output only. Log targets never receive it.
- **`authn:password` ends the user's sessions.** It goes through `set()`, which is not a voluntary change.
- **Failures exit non-zero.** An unknown login and a policy violation throw `InvalidArgument`.

## Best practices

- Pipe the password in from a secret manager or use `--generate`; avoid typing it on a shared screen.
- Schedule `authn:password-expire` with cron or a task scheduler; the package runs no timer.

## Examples

### Set a password from a secret manager

```sh
aws secretsmanager get-secret-value --secret-id prod/ops-admin --query SecretString --output text \
  | spinajs authn:password ops@acme.com
```

### Generate a password for a new support agent

```sh
spinajs authn:password agent.kowalska@acme.com --generate
# Password (copy it now, it is not shown again): <generated>
```

### Expire old passwords nightly

```sh
# crontab: 02:30 every day
30 2 * * * cd /srv/acme && npx spinajs authn:password-expire
```

## Related

- [Change and set](05-change-and-set.md): what `set()` revokes.
- [Password expiry](08-password-expiry.md): what the expiry job does.
- [`@spinajs/cli`](../cli/01-running-the-cli.md): how `spinajs` boots and finds commands.
- [`@spinajs/users`](../users/17-cli-commands.md): the user management commands.
