# ESLint setup

Turn on `@spinajs/authz/require-accessible` in the ESLint config of an app that uses `@spinajs/authz-orm`. The plugin ships one preset, `recommended`, in the `.eslintrc` format.

## How it works

1. ESLint resolves the plugin name `@spinajs/authz` to the package `@spinajs/eslint-plugin-authz` and reads its `rules` and `configs` exports.
2. `plugin:@spinajs/authz/recommended` adds the plugin and sets `@spinajs/authz/require-accessible` to `error`, with no options.
3. For every linted file, the rule calls `ESLintUtils.getParserServices(context)` and reads the TypeScript program from `@typescript-eslint/parser`. Without `parserOptions.project` this call throws, and the lint run stops with that error.
4. The rule resolves each model through the type checker, so the files that declare your models must belong to that TypeScript project.

## Exports ESLint reads

| Export | Value |
| --- | --- |
| `rules` | `{ 'require-accessible': requireAccessible }` |
| `configs.recommended` | `{ plugins: ['@spinajs/authz'], rules: { '@spinajs/authz/require-accessible': 'error' } }` |

## Configuration

Rule options for `@spinajs/authz/require-accessible`:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `resources` | `string[]` | `[]` | unique, non-empty class names | Classes to treat as `@AccessResource` models even when no decorator is visible. |

Decorators do not survive into `.d.ts` files. A model your app imports from a compiled package is found only when its class name is listed in `resources`. A listed class matches by name alone, whatever module it comes from.

### `.eslintrc`

```js
// .eslintrc.cjs
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname },
  extends: ['plugin:@spinajs/authz/recommended'],
  rules: {
    // models compiled into a shared package of your own
    '@spinajs/authz/require-accessible': ['error', { resources: ['Invoice', 'Contract'] }],
  },
};
```

Without the preset, add the plugin yourself:

```js
// .eslintrc.cjs
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname },
  plugins: ['@spinajs/authz'],
  rules: { '@spinajs/authz/require-accessible': 'error' },
};
```

### Flat config

`configs.recommended` uses the `.eslintrc` shape (`plugins` is a list of names), so a flat config sets the rule itself and passes the module as the plugin object:

```js
// eslint.config.js
import { fileURLToPath } from 'node:url';
import tsParser from '@typescript-eslint/parser';
import * as authz from '@spinajs/eslint-plugin-authz';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)) },
    },
    plugins: { '@spinajs/authz': authz },
    rules: { '@spinajs/authz/require-accessible': ['error', { resources: ['Invoice'] }] },
  },
];
```

<!-- TODO(docs-hook): verify flat config; the package tests cover only the .eslintrc path (TSESLint.ESLint with extends: plugin:@spinajs/authz/recommended). -->

## Important behaviour

- **Typed linting is required.** `meta.docs.requiresTypeChecking` is `true`. A file outside `parserOptions.project` fails to lint.
- **The SpinaJS monorepo does not lint apps for you.** Add the rule to your app's lint step and fail the build on errors.
- **`resources` does not see `@Primary()` either.** For a listed `.d.ts` class the rule finds no primary key, so `Invoice.where('Id', id).first()` is reported. `Invoice.get(id)` and `Invoice.findOrFail([id])` are not ([the rule](02-require-accessible.md#what-it-does-not-report)).
- **Unknown options fail the config.** The option schema has `additionalProperties: false` and `uniqueItems: true` on `resources`.

## Best practices

- Run the rule as `error`. A warning on a query that leaks rows is easy to ship.
- List every compiled `@AccessResource` model your app queries in `resources`, in one shared config.
- Keep the run-time guard on in tests (`APP_ENV=test`); it catches what the rule misses ([what it misses](02-require-accessible.md#what-it-misses)).

## Related

- [The `require-accessible` rule](02-require-accessible.md): what the rule reports once it is on.
- [Access lists](../authz-orm/01-access-lists.md): `.accessible()` and the run-time guard.
