# `@spinajs/eslint-plugin-authz`

ESLint rules for SpinaJS authorization. Its one rule, `require-accessible`, flags multi-row queries of `@AccessResource` models that skip `.accessible()`, `.unscoped()` or `runAs()`.

It does **not** run on ESLint 8 or read `.eslintrc` files: it targets ESLint 9 or 10 with a flat config. It does **not** replace the runtime guard of `@spinajs/authz-orm`; it catches the same mistakes earlier, in the editor and the lint step.

## Install

```sh
npm install --save-dev @spinajs/eslint-plugin-authz eslint typescript-eslint typescript
```

Peer dependencies: `eslint` `^9.0.0 || ^10.0.0`, `@typescript-eslint/parser` `^8.0.0`, `typescript` `>=4.8.4 <6.1.0`.

## Features

| Feature | What it does |
| --- | --- |
| [Flat config setup](01-flat-config-setup.md) | The default export, `configs.recommended` and `rules`, wired into `eslint.config.mjs` with type information |
| [`require-accessible` rule](02-require-accessible.md) | Reports unscoped selects and read shortcuts on `@AccessResource` models; the `resources` option |

## Quick start

```js
// eslint.config.mjs
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

## Related packages

- [`@spinajs/authz`](../authz/README.md#orm-spinajsauthz-orm): `@AccessResource`, `.accessible()`, `.unscoped()`, `runAs()` and the runtime guard this rule mirrors.
