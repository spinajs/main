# CLI commands

Three `spinajs` commands manage API tokens from a terminal or a scheduler: create a token for a user, revoke a token by id, and sweep expired and revoked rows. They call the registered `TokenService`, so they follow the same rules as the routes and your code.

## How it works

1. The package config adds its `lib/<mjs|cjs>/cli` directory to `system.dirs.cli`, under `node_modules/@spinajs/authn-token` of `WORKSPACE_ROOT_PATH` (or the working directory) and one directory up. The `spinajs` bin finds the commands there; see [Command discovery](../cli/05-command-discovery.md).
2. Every command extends `CliCommand` and injects `TokenService` with `@Autoinject`. The CLI resolves only the command it runs; `DbTokenService` (and `UsersTableTokenOwnerResolver`) inject `Orm`, so resolving the service is what boots the ORM and connects the `AccessToken` model to the database.
3. `authn:token-create` calls the service with `ctx = { now: new Date(), purpose: 'request' }`; `authn:token-delete` with `cliContext()` from `@spinajs/authn/contracts`, which adds `userAgent: 'spinajs-cli'`.
4. A failure sets `process.exitCode = 1` and logs an error on the `authn-token` logger; the commands never throw out of `execute`.

### `authn:token-create <ownerUuid>`

1. `--kind` must be `pat` or `service`. Agent tokens are never minted from the CLI.
2. The expiry is `--expires` parsed as ISO 8601 (local time of the machine when it has no offset). Without `--expires` it is now plus `authn.token.defaultTtlDays`. An unparseable or empty `--expires` is refused before anything is created.
3. `--roles` is split on commas, trimmed, and empty entries dropped. A `--roles` that names no role is refused by the service (`invalid_scope`).
4. It calls `TokenService.create({ type: 'user', id: ownerUuid }, …)`.
5. On success it writes three lines to **standard output**: the token id and expiry, a warning that the token will not be shown again, and the plaintext. The logger gets only the token id and owner.
6. A refusal logs `Token not created: <code>`. A thrown error logs its message only when it is one the service throws itself (`InvalidArgument`, `InvalidOption`, `InvalidOperation`, `UnexpectedServerError`); any other error, such as a database error, is reported by class name and code, because its message can quote the new hash.

### `authn:token-delete <uuid>`

1. It calls `DbTokenService.revokeById(uuid, cliContext(), { actor: CLI_ACTOR })`, with `CLI_ACTOR = { type: 'system', id: 'cli' }` from `@spinajs/authn/contracts`: the token is revoked whoever owns it.
2. It logs `Token <uuid> revoked`, or a warning when the token is unknown or already revoked (exit code `0`).
3. The row is revoked, not deleted; `authn:token-delete-expired` removes it later. A `TokenService` without `revokeById` fails the command with `InvalidOperation`.

### `authn:token-delete-expired`

1. It calls `DbTokenService.deleteExpired(new Date())`.
2. It logs the number of deleted rows: tokens expired at or before now, and revoked tokens. Rows without an expiry are kept.
3. A `TokenService` without `deleteExpired` fails the command with `InvalidOperation`.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Command('authn:token-create', …)` | `CreateToken` | `@Argument('ownerUuid', required)`; `-n, --name <name>` required; `-r, --roles <roles>`; `-k, --kind <kind>` default `pat`; `-p, --profile <profile>`; `-e, --expires <expires>` | Creates a token and prints the plaintext once. |
| `@Command('authn:token-delete', …)` | `DeleteToken` | `@Argument('uuid', required)` | Revokes a token by id, whoever owns it. |
| `@Command('authn:token-delete-expired', …)` | `DeleteExpiredTokens` | none | Deletes expired and revoked rows. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.token.defaultTtlDays` | `integer` | `30` | `>= 1` | Expiry of `authn:token-create` without `--expires`. A value above `authn.token.maxTtlDays` makes every such create fail with `invalid_expiry`. |
| `system.dirs.cli` | `string[]` | this package's `lib/<mjs\|cjs>/cli`, appended | directory paths | Where the `spinajs` bin finds the commands. Owned by `@spinajs/cli`. |

```sh
npx spinajs authn:token-create 4b1c6e1e-1f7a-4a8e-9b0e-3f5f2a8d9c11 --name "ci deploy" --kind service --expires 2026-12-31T00:00:00Z
npx spinajs authn:token-delete 0d6f2b7a-5c3e-4f1a-8e9d-2a7b6c5d4e3f
npx spinajs authn:token-delete-expired
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Token service | `TokenService`, `@Autoinject` per command | `DbTokenService` | | See [Issuing and revoking tokens](01-token-service.md#services-and-extension-points). `authn:token-delete` needs `revokeById`, `authn:token-delete-expired` needs `deleteExpired`. |

### Token service: custom command

Write your own token command when operators need a task the shipped ones lack, such as revoking every token of a user during an incident. Extend `CliCommand`, inject `TokenService`, and put the file in a directory listed in `system.dirs.cli`. Resolving `DbTokenService` boots the ORM, so the command needs no `Orm` of its own.

```ts sample
import { CLI_ACTOR, TokenService, cliContext } from '@spinajs/authn/contracts';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';

@Command('app:token-revoke-user', 'Revokes every API and agent token of a user')
@Argument('userUuid', true, 'uuid of the user')
export class RevokeUserTokens extends CliCommand {
  @Autoinject(TokenService)
  protected Tokens: TokenService;

  public async execute(userUuid: string): Promise<void> {
    const count = await this.Tokens.revokeAllFor({ type: 'user', id: userUuid }, cliContext(), { actor: CLI_ACTOR });
    process.stdout.write(`Revoked ${count} token(s)\n`);
  }
}
```

## Important behaviour

- **The plaintext goes to standard output only**, never to the logger, whose targets may be files or a remote store. Capture it from stdout in scripts.
- **Exit codes.** Every failure sets exit code `1`; an unknown token for `authn:token-delete` is not a failure.
- **Owners are users.** `authn:token-create` always passes `{ type: 'user', id: ownerUuid }`; an owner the resolver does not know is reported as an error and nothing is created.
- **`authn:token-delete` revokes.** Despite its name, it keeps the row with `RevokedAt` set, and the audit records `system:cli` as the actor.

## Best practices

- Run `authn:token-delete-expired` from a scheduler (cron, a worker); the commands never run it themselves.
- Pass `--expires` explicitly in automation, so a change of `defaultTtlDays` does not change your tokens' lifetime.
- Use `--kind service` for machine tokens, so lists and audits tell them apart from personal ones.

## Examples

### Nightly sweep in a crontab

```sh
# m h dom mon dow  command
15 3 * * *  cd /srv/orders-api && npx spinajs authn:token-delete-expired >> /var/log/orders-api/token-sweep.log 2>&1
```

## Related

- [Issuing and revoking tokens](01-token-service.md): the service methods behind the commands.
- [`@spinajs/cli`](../cli/README.md): the `spinajs` bin, [running it](../cli/01-running-the-cli.md) and [command discovery](../cli/05-command-discovery.md).
- [Token storage and migrations](05-token-storage.md): the rows the sweep removes.
