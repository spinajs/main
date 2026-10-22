# Flat config setup

The plugin ships as an ESLint flat-config plugin. Spread `configs.recommended` into `eslint.config.mjs` to turn on `require-accessible` and `require-access` as errors, or register the plugin yourself to set the rule's options.

## How it works

1. ESLint loads `eslint.config.mjs`, which imports the default export of `@spinajs/eslint-plugin-authz`.
2. The default export is the plugin object: `meta.name` (`@spinajs/eslint-plugin-authz`), `rules` and `configs`.
3. `configs.recommended` registers the plugin under the prefix `@spinajs/authz` and sets `@spinajs/authz/require-accessible` and `@spinajs/authz/require-access` to `error`.
4. For every linted file, `require-accessible` asks typescript-eslint's parser services for the type checker. On a file linted without type information, typescript-eslint throws its missing-type-information error.

## Exports

| Export | Type | Meaning |
| --- | --- | --- |
| default export | flat-config plugin | `{ meta, rules, configs }`; put it in `plugins` or spread `configs.recommended` |
| `configs.recommended` | `FlatConfig.Config` | `name: '@spinajs/authz/recommended'`, the plugin under `@spinajs/authz`, `require-accessible` and `require-access` as `error` |
| `rules` | object | `{ 'require-accessible': requireAccessible, 'require-access': requireAccess, 'no-raw-request': noRawRequest }`; `no-raw-request` is not in `configs.recommended` |
| `requireAccessible`, `requireAccess`, `noRawRequest` | rule modules | The rules themselves, for a custom plugin object or `RuleTester` |
| `isAccessResourceClass`, `primaryKeyOf` | functions | The type-checker helpers the rule uses to find `@AccessResource` classes and their `@Primary()` property |

## Configuration

`configs.recommended` sets no `files`. Scope it with a `files` entry next to the parser settings, as in the examples below.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `rules['@spinajs/authz/require-accessible']` | rule level, or `[level, options]` | `'error'` in `configs.recommended` | `'off'`, `'warn'`, `'error'`; options per [the rule page](02-require-accessible.md#configuration) | Turns the rule on and passes `resources` |
| `languageOptions.parser` | parser | none | `tseslint.parser` | Required: the rule reads types |
| `languageOptions.parserOptions.projectService` | `boolean` | none | `true` | Type information through the TypeScript project service; `project` works too |

## Important behaviour

- `require-accessible` needs type information (`meta.docs.requiresTypeChecking` is `true`); `require-access` does not. Lint `.js` files in a separate config entry without the plugin, or the rule fails on them.
- The rule resolves each model through the type checker, so the files that declare your models must belong to the linted TypeScript project.
- The plugin prefix is `@spinajs/authz`. Use it in rule keys and in `eslint-disable` comments: `// eslint-disable-next-line @spinajs/authz/require-accessible`.
- Unknown options fail the config: the option schema has `additionalProperties: false` and `uniqueItems: true` on `resources`.
- SpinaJS lints its own packages with `configs.recommended` in the root `eslint.config.mjs`, with `require-access` switched off there: it would flag the open endpoints of existing controllers and many test fixtures. `no-raw-request` is on there for `packages/{authn,authz}*/src`. It does not lint your app: add the rule to your app's lint step and fail the build on errors.

## Best practices

- List compiled models in `resources` when you set the rule yourself: decorators do not survive into `.d.ts`, so `User` from `@spinajs/users` is not detected otherwise ([details](02-require-accessible.md#configuration)).
- Keep the rule at `error`. A flagged query is an authorization hole in production, where the runtime guard is off.
- Keep the run-time guard on in tests (`APP_ENV=test`); it catches what the rule misses ([what it misses](02-require-accessible.md#what-it-misses)).

## Examples

### Lint an app with the recommended config

```js
// eslint.config.mjs
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import authz from '@spinajs/eslint-plugin-authz';

export default defineConfig(
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
  authz.configs.recommended,
);
```

### Flag queries of `User` and `JobModel` from compiled packages

```js
// eslint.config.mjs
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import authz from '@spinajs/eslint-plugin-authz';

export default defineConfig({
  files: ['src/**/*.ts'],
  languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  plugins: { '@spinajs/authz': authz },
  rules: { '@spinajs/authz/require-accessible': ['error', { resources: ['User', 'JobModel'] }] },
});
```

## Migration

ESLint 8 and `.eslintrc` are not supported. `plugin:@spinajs/authz/recommended` and `plugins: ['@spinajs/authz']` no longer resolve. Move to `eslint.config.mjs` on ESLint 9 or 10 and typescript-eslint v8.

```js
// before: .eslintrc.cjs
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname },
  plugins: ['@spinajs/authz'],
  extends: ['plugin:@spinajs/authz/recommended'],
};
```

```js
// after: eslint.config.mjs
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import authz from '@spinajs/eslint-plugin-authz';

export default defineConfig(
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
  authz.configs.recommended,
);
```

## Related

- [The `require-accessible` rule](02-require-accessible.md): what the rule reports and its options.
- [The runtime guard](../authz-orm/07-runtime-guard.md): the `@spinajs/authz-orm` check the rule mirrors.
