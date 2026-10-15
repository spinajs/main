# `@spinajs/eslint-plugin-authz`

ESLint rules for SpinaJS authorization (design `docs/plans/2026-10-14-authz-resource-access-design.md` §8).

## Install

```sh
npm i -D @spinajs/eslint-plugin-authz @typescript-eslint/parser eslint@8 typescript
```

The rule is typed: ESLint must run with `@typescript-eslint/parser` and a `parserOptions.project`.

```js
// .eslintrc.cjs
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname },
  plugins: ['@spinajs/authz'],
  extends: ['plugin:@spinajs/authz/recommended'],
  // or: rules: { '@spinajs/authz/require-accessible': ['error', { resources: ['User'] }] },
};
```

SpinaJS's own CI does not run ESLint; apps add the rule to their lint step.

## `require-accessible`

A select on an `@AccessResource` model must call `.accessible(permission)`, use `.unscoped(reason)`, or run
inside `runAs(SYSTEM, reason)`. The rule reports:

- a chain from a static query member (`where`, `query`, `select`, `all`, `whereExists`, `whereNotExists`,
  `populate`) that reaches `first`, `firstOrFail`, `firstOrThrow`, `orThrow`, `all`, `execute`, `asRaw`,
  `resultExists`, `selectCount` or `then`, or is awaited, with no `.accessible(` or `.unscoped(` before that;
- a static read that returns a promise at once (`getOrNew`, `getOrCreate`, `first`, `last`, `newest`,
  `oldest`, `count`, `exists`, and `find` / `findOrFail` with more than one key): there is no builder to
  scope, so run it in `runAs(SYSTEM, reason)`, or query with `.accessible()`.

Single-object loads are not reported, as the runtime guard does not refuse them: `get(id)`,
`getOrFail(id)`, `find([id])`, `findOrFail([id])`, and `where('<primary key>', id)` with no other where
(the primary key is the `@Primary()` property). The route's `@Access` check-before covers them.

Any arrow or function passed to `runAs(...)` or `x.runAs(...)` exempts what it contains. Writes (`create`,
`insert`, `update`, `destroy`) are not checked.

A model is an access resource when its class, or a class it extends, has `@AccessResource(...)`, however
the decorator or the class is imported or renamed.

### Options

- `resources: string[]`: class names to treat as access resources. Decorators do not survive into `.d.ts`
  files, so models a package ships compiled (`User` from `@spinajs/users`, `JobModel` from
  `@spinajs/authz-queue`) are only found when listed here.

### What it misses

A builder kept in a variable and executed later, a builder returned unexecuted from an `async` function,
`Promise.all` over builders, instance relations, and `populate()` of an access-resource child. The runtime
guard (an `AuthzConfigError` in the `test` env) catches those.
