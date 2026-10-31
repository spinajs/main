# Environments

The environment decides which environment-specific config files load (`db.dev.js`, `db.prod.json`) and sets the `configuration.isDevelopment`, `isProduction` and `isLocal` flags. One normalizer, `normalizeEnvironment()`, maps the name for both, so the loaded files and the flags agree.

## How it works

1. **Constructor.** `FrameworkConfiguration` sets `Env` to the `--env <name>` command-line argument, else to `process.env.APP_ENV`.
2. **`load()`** stores the environment in the tree at `process.env.APP_ENV`, taking the first that is set: `Env`, `APP_ENV` from the `process.env` DI value, `process.env.NODE_ENV`, `'development'`.
3. **File sources.** `BaseFileSource.getEnvironment(config)` reads `process.env.APP_ENV` from the tree and passes it to `normalizeEnvironment()`:

   | Input | Result | File suffix |
   | --- | --- | --- |
   | `dev`, `development` | `dev` | `*.dev.js`, `*.dev.json` |
   | `prod`, `production` | `prod` | `*.prod.js`, `*.prod.json` |
   | `''`, `undefined`, `null` | `prod` | `*.prod.*` |
   | any other name (`local`, `staging`) | unchanged, case kept | `*.local.js`, `*.staging.json` |

4. **Flags.** `load()` computes the flags from that same `process.env.APP_ENV`, through the same `normalizeEnvironment()`, before the sources merge.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `process.env.APP_ENV` | `string` | `--env`, `APP_ENV`, `NODE_ENV` or `'development'` | any | The environment the file sources use. |
| `process.env.*` | `string` | the process environment | any | Every environment variable, merged with the `process.env` DI value. |
| `configuration.isDevelopment` | `boolean` | `true` when the environment is `dev` | `true`, `false` | Development guard. |
| `configuration.isProduction` | `boolean` | `true` when the environment is `prod` | `true`, `false` | Production guard; `@spinajs/http` hides error detail and `@spinajs/email` refuses recipient redirection when it is `true`. |
| `configuration.isLocal` | `boolean` | `true` when the environment is `local` | `true`, `false` | Local-machine guard. |

The flags are ordinary config values. Override them in your own config file when a deployment needs it:

```js
// config/configuration.staging.js
export default {
  configuration: { isProduction: true },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Environment override | `process.env` DI value | none | none | `DI.register({ APP_ENV: 'local', DB_HOST: 'localhost' }).asValue('process.env')` before the configuration resolves. Its keys override `process.env` in the `process.env` section, and its `APP_ENV` is used when `--env` and `process.env.APP_ENV` are both unset. |
| Environment resolution in file sources | `BaseFileSource.getEnvironment(config)`, protected | `normalizeEnvironment(config.get('process.env.APP_ENV') ?? this.Env)` | none | Override in a `BaseFileSource` subclass (see [Config files](03-config-files.md#basefilesource-custom-file-format)). |

### Environment override: custom implementation

Use the `process.env` value to feed variables from a secrets file or a test, without touching the real process environment.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

async function main() {
  DI.register({
    DB_HOST: 'localhost',
    DB_PASSWORD: 'local-only',
  }).asValue('process.env');

  const configuration = await DI.resolve(Configuration);
  console.log(configuration.get<string>('process.env.DB_HOST'));
}

void main();
```

## Important behaviour

- `APP_ENV` wins over `NODE_ENV`. A container that pins `NODE_ENV=production` for npm and sets `APP_ENV=dev` loads the dev files and reports `isDevelopment`.
- Nothing set means **development** for the files (`load()` defaults to `'development'`) and for the flags.
- An explicitly empty `APP_ENV` (`APP_ENV=`) means **production** for both: `normalizeEnvironment('')` returns `prod`.
- Environment names are case-sensitive: `Local` and `local` load different files.
- File suffixes use the short names: `db.prod.js`, not `db.production.js`. A file named `*.production.js` never loads.
- `load()` derives the flags from the same resolved `APP_ENV` the file sources read, so `--env` and the `process.env` DI value set both.

## Best practices

- Guard production-only behaviour with `configuration.isProduction`, not `process.env.NODE_ENV`.
- Use `local` for developer machines and keep secrets in `*.local.js`, excluded from version control.

## Patterns and antipatterns

```ts
// Don't: NODE_ENV disagrees with the loaded config when APP_ENV is set
if (process.env.NODE_ENV === 'production') hideStackTraces();

// Do
if (configuration.get<boolean>('configuration.isProduction')) hideStackTraces();
```

## Examples

### Per-environment database settings

```js
// config/db.js: shared
export default { db: { DefaultConnection: 'main', Connections: [] } };

// config/db.dev.js: loaded only when the environment is dev
export default { db: { Connections: [{ Name: 'main', Driver: 'orm-driver-sqlite', Filename: './dev.sqlite' }] } };

// config/db.prod.js: loaded only when the environment is prod
export default { db: { Connections: [{ Name: 'main', Driver: 'orm-driver-mysql', Host: 'db.internal' }] } };
```

`db.Connections` is an array, so the environment file's list replaces the shared, empty one (see [Arrays](01-configuration-service.md#arrays)).

## Related

- [Config files](03-config-files.md): how the suffix selects files.
- [`@spinajs/configuration-common`](../configuration-common/README.md): `normalizeEnvironment()`, shared with migration file loading in `@spinajs/orm`.
