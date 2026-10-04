# `@spinajs/authz-convert`

Converts a SpinaJS 2.x app's `rbac.*` configuration to the 3.0 roots `authz.*`, `users.*` and
`authn.*`. The steps around it (packages, code, data, secrets) are in
[the migration guide](../../docs/authz/migration-guide.md).

```sh
npx spinajs-authz-convert lib/mjs/config --out src/config/converted \
  --db rbac-facts.json --src src
```

- `<config-dir>...`: the app's **compiled** config dirs (`.js`, `.cjs`, `.json`), merged in order.
  The converter runs the files the way the configuration loader does: common files, then one
  layer per env suffix (`rbac.local.js` is env `local`). A dir that holds TypeScript sources is
  refused. Only the app's own files are read; 2.x package defaults are not.
- `--out <dir>`: where the files go (default `./authz-convert-output`); existing files need `--force`.
- `--db <file.json>`: rows exported from the 2.x database before the 3.0 migrations drop
  `users.Role`: `{ "users": [{ "Id", "Login", "Role" }], "tokens": [{ "Id", "Roles", "ExpiresAt" }] }`
  (role lists as arrays, JSON strings or comma lists). With it the converter marks package roles
  nobody holds `assignable: false` and lists users with several roles, roles the config does not
  define and tokens without expiry.
- `--src <dir>`: app sources to scan for `@OrmResource`, `@ResourceOwner` and `@OrmPermission`.
- `--self-resources <a,b>`: resources whose `:own` grants mean the caller's own account
  (relation `self`; default `user`). Every other `:own` becomes relation `owner`.

## Output

| File | Holds |
|---|---|
| `authz-generated.ts`, `authz-generated.<env>.ts` | `authz.rbac.roles`, `authz.permissions`, principals, admin guard, impersonation, token role policy |
| `users-generated.ts`, `users-generated.<env>.ts` | `users.user`, `users.email`, `users.actions` |
| `authn-generated.ts`, `authn-generated.<env>.ts` | strategies, local password, session, MFA, token, throttle |
| `authz-warnings.md` | what to convert by hand, behaviour changes, notes |

The base names hold no dot: the 3.0 loader reads `name.js` as a common file and `name.<env>.js`
as an env file, so `authz.generated.ts` would never load.

Exit codes: `0` converted; `2` converted, with keys left to convert by hand; `1` refused or
failed, nothing written.

## What it refuses

The converter never guesses. It refuses, and writes nothing, when the 2.x config holds:

- an action key accesscontrol rejects, or a resource name that is not a 3.0 permission resource
  (`[A-Za-z][A-Za-z0-9_.-]*`; for example `ArrowClient:yourscreen`);
- a `scope:` token on an `:any` grant (2.x ignores it), a token named `owner` or `self`, scope
  tokens next to negated attributes only, attributes with spaces around them, or an attribute that
  is not a 3.0 field glob;
- an attribute list set in common and in an env file (2.x joins the lists before reading them), or a
  negation or `scope:` token on a key a 2.x package also granted (`admin.users`, `user`, `guest`);
- a key an env JS file and a common JSON file both set;
- a value of the wrong type.

It runs the config files again, in child processes, with `NODE_ENV` and `APP_ENV` set to each of
`production`, `prod`, `development`, `dev` and `test`, and lists every value that changes: the converted
files hold the values of one run. Files that read an environment variable (themselves or through what
they import) are named too, since only those two variables are varied.

Where the app ran on a 2.x package default, the converter carries it over when 3.0 needs it (the local
login strategy, the package part of `impersonation.protectedRoles` and `password.generator.characters`)
and lists the rest (lockout, default role, guest account, password expiry, TOTP, the public cookie
secret).

It writes as found, and lists for a person, custom services (role guard, token role policy) so that
boot fails until they are ported. It leaves out, and lists, values a file cannot hold (functions),
unknown `rbac.*` keys, custom auth, password and 2FA providers and units that do not convert exactly.

## Library use

```ts
import { convert } from '@spinajs/authz-convert';

const { files, findings, exitCode } = await convert({ dirs: ['lib/mjs/config'] });
```
