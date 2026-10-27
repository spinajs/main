# CLI commands

Five `spinajs` commands manage users from a shell: create, find, activate or deactivate, ban or unban, delete. Each calls the matching [user action](03-user-actions.md), so it sends the same mails and emits the same events. Write your own command on `RbacCliCommand` to get a booted ORM.

## How it works

1. users' config adds `node_modules/@spinajs/users/lib/<cjs|mjs>/cli` (and the same one directory up) to `system.dirs.cli`, so `spinajs` discovers the commands.
2. The CLI resolves only the command it runs. `RbacCliCommand` injects the `Orm`, which boots the ORM and applies the `Migration.OnStartup` migrations for that command alone, as an app process does before serving; listing commands (`--help`) opens no connection.
3. `execute()` calls the action and logs the result through the `rbac` logger.
4. Errors are caught and logged (`Error while ...`), and the command sets `process.exitCode = 1`.

## Commands

| Command | Arguments and options | Action |
| --- | --- | --- |
| `rbac:user-create` | `-e, --email <email>` (required), `-l, --login <login>` (required), `-p, --password <password>`, `-r, --roles <roles>` (comma separated) | `create({ Email, Login, Password }, roles, SYSTEM)` inside `AuthzService.runAs(SYSTEM, 'cli', ...)`. No `--roles`: `authz.rbac.defaultRoles`. No `--password`: the user is invited by mail. |
| `rbac:user-find` | `-i, --identifier <identifier>` (required): id, UUID, email or login | `getUser()`; logs `Id`, `Uuid`, email, login, active, `CreatedAt`, `LastLoginAt`. |
| `rbac:user-activate` | `<idOrUuid> <active>`; `active` is `true` or anything else (false) | `activate()` or `deactivate()`. |
| `rbac:user-ban` | `<idOrUuid> <ban> [duration] [reason]`; `ban` is `true` or anything else (false, unban); `duration` in minutes, default `1440` | `ban(idOrUuid, reason, duration * 60)` or `unban(idOrUuid)`. |
| `rbac:user-delete` | `<idOrUuid>` | `deleteUser()`: a soft delete (`DeletedAt`); sessions and tokens end. |

`idOrUuid` accepts anything `getUser()` does: id, UUID, email or login.

```sh
spinajs rbac:user-create -e ada@acme.com -l ada -r user,support
spinajs rbac:user-find -i ada@acme.com
spinajs rbac:user-activate ada@acme.com true
spinajs rbac:user-ban ada@acme.com true 60 "chargeback"
spinajs rbac:user-ban ada@acme.com false
spinajs rbac:user-delete 3f0e1b8c-2a4d-4e6f-9b1a-7c8d9e0f1a2b
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Command base | abstract `RbacCliCommand` (extends `CliCommand`), resolved per run | | your command | Extend it; it gives `this.Orm` booted and the database migrated (`this.Migrator`). Put the file in a `system.dirs.cli` directory. |
| Shipped commands | `'__cli_command__'` registrations from `@Command` | the five above | your own command names | Add commands; to change one, write a command with another name. A subclass of a shipped command inherits its `@Command` metadata and would register the same name twice. |

### Custom command: resend an invite

```ts sample
import { Argument, Command } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { PasswordService } from '@spinajs/authn/contracts';
import { AuthzService, SYSTEM } from '@spinajs/authz';
import { RbacCliCommand, getUser } from '@spinajs/users';

@Command('rbac:user-reinvite', 'Sends the invite mail of an invited user again')
@Argument('idOrUuid', true, 'id, uuid, email or login')
export class ReinviteUser extends RbacCliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string): Promise<void> {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;

    await authz.runAs(SYSTEM, 'cli', async () => {
      const user = await getUser(idOrUuid);
      const passwords = (await DI.resolve(PasswordService)) as PasswordService;
      await passwords.invite({ type: 'user', id: user.Uuid }, { now: new Date(), purpose: 'request' }, { actor: { type: SYSTEM.type, id: SYSTEM.id } });
    });

    this.Log.success({ user: idOrUuid }, 'Invite for ${user} sent');
  }
}
```

## Important behaviour

- A failed command logs the error and exits with code 1.
- `rbac:user-create` runs as `SYSTEM`, so `AuthzAdmin`'s guard is skipped: anyone with shell access grants any assignable role.
- `rbac:user-find`, `-activate`, `-ban` and `-delete` do not run as `SYSTEM`. With an `@AccessResource` [user model](02-custom-user-model.md) their lookups are scoped to the CLI's principal.
- `rbac:user-ban` and `rbac:user-activate` parse only the literal `true` (any case) as ban or activate.
- `rbac:user-ban` takes `duration` in minutes; `ban()` itself takes seconds.

## Best practices

- Pass `--roles` explicitly in provisioning scripts; the defaults may change with configuration.
- Prefer inviting (`rbac:user-create` without `--password`) over passing a password on the command line, where it lands in shell history.

## Related

- [User actions](03-user-actions.md): what each command calls.
- [`@spinajs/cli`](../cli/README.md): running commands and `system.dirs.cli` discovery.
- [Commands](../cli/02-commands.md): `@Command`, `@Argument` and `@Option`.
