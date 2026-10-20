# Config loading and env layers

The converter reads the app's compiled config dirs the way the configuration loader does, and keeps the common files and each env apart. Each layer is converted into its own output files, so the 3.0 loader rebuilds the same config per env.

## How it works

1. `loadLayers(dirs)` checks every dir. A missing dir, a dir with TypeScript sources (`.ts`, `.mts`, `.cts`; `.d.ts` files do not count) or a dir with no `.js`, `.cjs` or `.json` file is refused.
2. It walks each dir, nested dirs included, and sorts files into layers by name:
   - `rbac.js`, `http.json` (two name parts): the **common** layer.
   - `rbac.local.js`, `cors.prod.js`: the layer of env `local`, `prod`, and so on.
   - Dot files and files with the env suffix `production` or `development` are skipped and listed as `file-skipped` warnings: the loader reads those envs as `prod` and `dev`, so it never loads such a file.
3. A `BaseFileSource` subclass from `@spinajs/configuration` loads each layer, with the given dirs as its only dirs. 2.x package defaults are **not** read.
4. Each JS file is imported, and its `onConfigLoad(cfg)` hook runs when it exports one. A file that fails to load is refused; the converter never goes on with `{}`.
5. The view of an env is built in the loader order: common JS, env JS, common JSON, env JSON. `mergeLayers()` merges them with lodash `mergeWith`: objects merge, scalars override, arrays concatenate.
6. A key set by an env JS file and by a common JSON file is refused: the loader lets the JSON win, which separate output files cannot express.
7. The files run again in child processes under other `NODE_ENV` values (see [Computed values](#computed-values)).
8. The result is a `ConfigLayers` object: `common`, `envs` (env suffix to merged layer), `view(env)`, plus the skipped files, computed values, env readers and probe errors.

## Computed values

A config file can compute a value at load time (`process.env.NODE_ENV === 'prod' ? ... : ...`). The output files hold the value of the converter's own run, so the converter looks for such values:

1. `computedLeaves()` runs every loaded file again with `NODE_ENV` and `APP_ENV` set to each of `production`, `prod`, `development`, `dev` and `test`, skipping the converter's own `NODE_ENV`. Each value runs in its own child Node process, all of them at once.
2. The child process starts from the environment of before the first run, so values a dotenv helper put into `process.env` are not there.
3. It compares every leaf of each view with the first run. A leaf under `rbac.` or `http.` that changed becomes a `computed-value` manual item. An env layer lists only what the common layer does not.
4. Each child records which environment variables a file reads, itself or through what it imports. Every file that reads one gets a `reads-env` warning. `NODE_ENV` counts; the other `NODE_*` variables, `WORKSPACE_ROOT_PATH` and `WATCH_REPORT_DEPENDENCIES` do not.
5. A child that fails or runs longer than 120 seconds does not stop the conversion: it becomes a `probe-failed` manual item, and only the other runs count.

Only `NODE_ENV` and `APP_ENV` vary. A value computed from another variable, the clock or a file is caught only through the `reads-env` warning.

## Arrays across layers

The 3.0 loader concatenates arrays across config files, so an env file can add to an array but cannot replace or empty it. Four 3.0 keys are arrays that come from 2.x scalars (`SCALAR_TO_ARRAY_KEYS`):

- `authz.rbac.defaultRoles`
- `authz.rbac.anonymousRoles`
- `authn.strategies`
- `authn.mfa.steps`

For each one, in each env layer, `convertLayers()`:

- drops the env value when it equals the common value (written twice it would be listed twice);
- writes a manual `env-array` item when it differs from the common value;
- writes a manual `env-array` item when the env turns off what common fills (for example `twoFactorAuth.enabled: false` in an env while common writes the TOTP step).

The login strategy follows the same rule. When the common view holds `rbac` keys but no `rbac.auth.service`, the common file gets `authn.strategies: [{ name: 'local', service: 'LocalPasswordStrategy' }]`, the 2.x default. An env whose 2.x login provider differs from the common one gets a manual `env-array` item. When only env files hold `rbac` keys, each such env layer gets the local strategy itself.

## Important behaviour

- Several dirs merge in the order given, into the same layers.
- The converter sets ES module support on `DI` and imports files through `DI.__spinajs_require__`, so ESM and CommonJS config files both load.
- Dir problems (missing, TypeScript sources, no config file) are collected over all dirs and refused together. A file that fails to load stops the run at once.
- A config file found in the dirs that the configuration loader did not read is refused, with a hint to move the config files to a plain directory path.
- A config file prints freely: the child runs write their result to a temp file, not to stdout.

## Patterns and antipatterns

```ts
// Don't: an env JS file overriding a key a common JSON file sets; the converter refuses it
// config/rbac.json      { "rbac": { "defaultRole": "user" } }
// config/rbac.prod.js   export default { rbac: { defaultRole: 'customer' } };

// Do: keep the key in one kind of file
// config/rbac.js        export default { rbac: { defaultRole: 'user' } };
// config/rbac.prod.js   export default { rbac: { defaultRole: 'customer' } };
```

```ts
// Don't: name an env file by the long env name; the loader never loads it
// config/rbac.production.js

// Do: use the short name the loader reads
// config/rbac.prod.js
```

## Examples

### Inspect the layers before converting

```ts sample
import { loadLayers } from '@spinajs/authz-convert';

export async function listLayers(): Promise<void> {
  const layers = await loadLayers(['lib/mjs/config']);
  console.log('envs:', [...layers.envs.keys()].join(', '));
  console.log('skipped:', layers.skipped);
  for (const [layer, paths] of layers.computed) console.log(`${layer} computes`, paths);
  for (const reader of layers.envReaders) console.log(`${reader.file} reads ${reader.vars.join(', ')}`);
  console.log('prod view:', JSON.stringify(layers.view('prod').rbac, null, 2));
}
```

## Related

- [`@spinajs/configuration`](../configuration/README.md): the loader whose file order and merge rules the converter repeats.
- [Running the converter](01-running-the-converter.md): the command that calls `loadLayers()`.
- [Findings and refusals](05-findings-and-refusals.md): `computed-value`, `reads-env`, `probe-failed`, `env-array` and `file-skipped`.
