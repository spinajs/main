# `@spinajs/eslint-plugin-authz`

ESLint rules for SpinaJS authorization. Its one rule, `@spinajs/authz/require-accessible`, reports multi-row queries on `@AccessResource` models that run without `.accessible(permission)`, `.unscoped(reason)` or an enclosing `runAs(...)`.

It does **not** change or fix queries, and it does **not** check writes. It is the edit-time half of a check whose run-time half is the `@spinajs/authz-orm` query guard, which is off in production ([Access lists](../authz-orm/01-access-lists.md#important-behaviour)).

## Install

```sh
npm install --save-dev @spinajs/eslint-plugin-authz @typescript-eslint/parser eslint@8 typescript
```

Peer dependencies: `eslint` `^8.32.0`, `@typescript-eslint/parser` `^5.48.2`, `typescript` `>=4.8`. The rule needs type information, so ESLint must run with `@typescript-eslint/parser` and `parserOptions.project`.

## Features

| Feature | What it does |
| --- | --- |
| [ESLint setup](01-eslint-setup.md) | The `recommended` preset, `.eslintrc` and flat config wiring, the `resources` option, running it in CI. |
| [The `require-accessible` rule](02-require-accessible.md) | What the rule reports and why, what it exempts, its messages, how to suppress it and what it misses. |
| [Detection helpers](03-detection-helpers.md) | `isAccessResourceClass()`, `primaryKeyOf()` and the member sets the rule uses, for rules of your own. |

## Quick start

```js
// .eslintrc.cjs
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname },
  extends: ['plugin:@spinajs/authz/recommended'],
};
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
