# `@spinajs/eslint-plugin-authz`

ESLint rules for SpinaJS authorization. `@spinajs/authz/require-accessible` reports multi-row queries on `@AccessResource` models that run without `.accessible(permission)`, `.unscoped(reason)` or an enclosing `runAs(...)`. `@spinajs/authz/require-access` reports an http route with no `@Access`, `@Policy` or `@AllowAnonymous` on it or on its class.

It does **not** change or fix queries, and it does **not** check writes. It does **not** run on ESLint 8 or read `.eslintrc` files: it targets ESLint 9 or 10 with a flat config. It is the edit-time half of a check whose run-time half is the `@spinajs/authz-orm` query guard, which is off in production ([The runtime guard](../authz-orm/07-runtime-guard.md)).

## Install

```sh
npm install --save-dev @spinajs/eslint-plugin-authz eslint typescript-eslint typescript
```

Peer dependencies: `eslint` `^9.0.0 || ^10.0.0`, `@typescript-eslint/parser` `^8.0.0`, `typescript` `>=4.8.4 <6.1.0`. `require-accessible` needs type information, so ESLint must run with the typescript-eslint parser and `parserOptions.projectService` (or `project`). `require-access` reads the syntax tree only.

## Features

| Feature | What it does |
| --- | --- |
| [Flat config setup](01-flat-config-setup.md) | The default export, `configs.recommended` and `rules`, wired into `eslint.config.mjs` with type information. |
| [The `require-accessible` rule](02-require-accessible.md) | What the rule reports and why, what it exempts, the `resources` option, its messages, how to suppress it and what it misses. |
| [The `require-access` rule](04-require-access.md) | Which route methods it reports, what guards them, the `routeDecorators` and `guardDecorators` options, and how it relates to the boot report of `@spinajs/authz-http`. |
| [Detection helpers](03-detection-helpers.md) | `isAccessResourceClass()`, `primaryKeyOf()` and the member sets the rule uses, for rules of your own. |

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

```ts
import { Task } from './models/Task';

// Reported: a list of every task, whatever the caller may read
const all = await Task.where('status', 'open');

// Not reported: the access plan of 'task:read' filters the rows
const mine = await Task.where('status', 'open').accessible('task:read');
```

## Related packages

- [`@spinajs/authz-orm`](../authz-orm/README.md): ships `@AccessResource`, `.accessible()`, `.unscoped()` and the run-time guard this rule mirrors.
- [`@spinajs/authz`](../authz/README.md): `authz().runAs(SYSTEM, reason, fn)`, the engine and the access plans behind `.accessible()`.
- [`@spinajs/orm`](../orm/README.md): the model statics and query builder members the rule follows.
