# `@spinajs/authz-convert`

Converts the `rbac.*` configuration of a SpinaJS 2.x app into 3.0 config files for the `authz.*`, `users.*` and `authn.*` roots, plus an `authz-warnings.md` report of what a person must finish. It ships the `spinajs-authz-convert` command and the same steps as a library.

It does **not** touch the database, the app's code or its secrets. It does **not** convert config roots other than `rbac` (it reads `http.*` only to warn). The steps around it (packages, decorators, data, secrets) are in the [migration guide](../authz/migration-guide.md).

## Install

```sh
npm install --save-dev @spinajs/authz-convert
```

The package needs Node.js 16.11 or later.

## Features

| Feature | What it does |
| --- | --- |
| [Running the converter](01-running-the-converter.md) | The `spinajs-authz-convert` command: options, output files, exit codes, the `--db` and `--src` inputs. |
| [Config loading and env layers](02-config-loading-and-env-layers.md) | How it reads the compiled config dirs as a common layer plus one layer per env, and finds values computed at load time. |
| [Config key mapping](03-config-key-mapping.md) | Which 2.x `rbac.*` key becomes which `authz.*`, `authn.*` or `users.*` key. |
| [Grant and role conversion](04-grant-and-role-conversion.md) | How `rbac.grants` and `rbac.roles` become `authz.rbac.roles` and `authz.permissions`. |
| [Findings and refusals](05-findings-and-refusals.md) | What the converter refuses, and every finding `authz-warnings.md` can list. |
| [Library API](06-library-api.md) | `convert()`, `convertLayers()` and the building blocks behind the command. |

## Quick start

```sh
npx spinajs-authz-convert lib/config --out src/config/converted --db rbac-facts.json --src src
```

Then read `src/config/converted/authz-warnings.md`, finish its "Convert by hand" items, and copy the generated files into the app's config dir.

The same conversion from code:

```ts sample
import { ConversionError, convert } from '@spinajs/authz-convert';

export async function convertLegacyConfig(): Promise<number> {
  try {
    const { files, exitCode } = await convert({ dirs: ['lib/config'] });
    for (const file of files) console.log(file.name);
    return exitCode;
  } catch (err) {
    if (err instanceof ConversionError) console.error(err.problems.join('\n'));
    return 1;
  }
}
```

## Related packages

- [Migration guide](../authz/migration-guide.md): the whole 2.x to 3.0 path; the converter covers its config step.
- [`@spinajs/authz`](../authz/README.md): owns the `authz.*` keys the converter writes; it also supplies the role name and permission rules the converter checks against.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): reads `authz.rbac.roles`, the role definitions the converter writes.
- [`@spinajs/authn`](../authn/README.md): owns the `authn.*` keys (strategies, local password, sessions, MFA, tokens, throttling).
- [`@spinajs/users`](../users/README.md): owns the `users.*` keys (`users.user`, `users.email`, `users.actions`).
- [`@spinajs/configuration`](../configuration/README.md): the converter loads config files through its file source, the way the app loads them.
