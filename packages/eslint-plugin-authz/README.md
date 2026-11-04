# `@spinajs/eslint-plugin-authz`

ESLint rules for SpinaJS authorization.

## Install

```sh
npm i -D @spinajs/eslint-plugin-authz eslint typescript-eslint typescript
```

ESLint 9 or 10 with a flat config. The rule is typed: the files it lints need typescript-eslint's parser
with type information (`projectService` or `project`).

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
  // or: { plugins: { '@spinajs/authz': authz }, rules: { '@spinajs/authz/require-accessible': ['error', { resources: ['User'] }] } },
);
```

SpinaJS lints its own packages with this rule (root `eslint.config.mjs`).

The compiler is authoritative: `spinajs build` records every entry point and its access in the manifest, and
`spinajs doctor` checks them across classes, inheritance and packages (AUTHZ003, AUTHZ004, AUTHZ005, AUTHZ007,
AUTHZ008, AUTHZ009). These rules look at one file and are the fast editor path to the same findings.

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

An arrow or function passed to `runAs(SYSTEM, ...)` or `x.runAs(SYSTEM, ...)` exempts what it contains. A
`runAs` of any other principal does not: its queries read only what that principal may, so they still need
`.accessible()`. Writes (`create`, `insert`, `update`, `destroy`) are not checked.

A model is an access resource when its class, or a class it extends, has `@AccessResource(...)`, however
the decorator or the class is imported or renamed.

### Options

- `resources: string[]`: class names to treat as access resources. Decorators do not survive into `.d.ts`
  files, so models a package ships compiled (`User` from `@spinajs/users`, `JobModel` from
  `@spinajs/authz-queue`) are only found when listed here.
- `legacyRunAsExemption: boolean` (default `false`): any `runAs(...)` callback exempts its queries, as before
  4.0. Removed in 5.0.

### What it misses

A builder kept in a variable and executed later, a builder returned unexecuted from an `async` function,
`Promise.all` over builders, instance relations, and `populate()` of an access-resource child. The runtime
guard (an `AuthzConfigError` in the `test` env) catches those.

## `require-access`

An http route method (`@Get`, `@Post`, `@Put`, `@Patch`, `@Del`, `@Head`) must have `@Access`, `@Policy` or
`@AllowAnonymous` on it or on its class. The rule reads the syntax tree only, so it needs no type
information. The root `eslint.config.mjs` of this repo switches it off: it would flag the open endpoints of
existing controllers and many test fixtures.

### Options

- `routeDecorators: string[]`: extra decorator names that mark a method as a route.
- `guardDecorators: string[]`: extra decorator names that guard a route.

A guard on a base class is not seen: repeat it on the subclass or list your wrapper in `guardDecorators`.

## `require-socket-access`

A socket command or event (`@Command`, `@OnEvent`) must have `@SocketAccess`, `@SocketPolicy` or
`@SocketPolicyGroup` on it or on its class: under `http.socket.access.default: 'deny'` the server refuses it
(`no_policy`). In `configs.recommended` as an error. Like `require-access`, a guard on a base class is not seen;
`spinajs doctor` (AUTHZ003) follows inheritance.

### Options

- `guardDecorators: string[]`: extra decorator names that guard a socket handler.

## `require-handler-access`

A queue job (a class with `@Job(...)` or one that extends `QueueJob`, not abstract) must declare the permissions
it needs with `@Job({ access })`, or say why it needs none with `@SystemTask(reason)`. `runAs: 'system'` alone
does not count. In `configs.recommended` as a warning in 4.x (`spinajs doctor` AUTHZ004 / AUTHZ009 warn too).

## `no-raw-request`

An http controller must not take `@Req()` or `@Res()` parameters or call `bodyField()`: its input goes through route
arguments (`@Body`, `@Query`, `@Param`, `@Header`, `@Cookie`, typed arg decorators), which validate it. A controller
is a class that extends a `…Controller` class or has a route method. The rule reads the syntax tree only and is not in
`configs.recommended`; the root `eslint.config.mjs` turns it on for `packages/{authn,authz}*/src`.

### Options

- `decorators: string[]`: extra parameter decorator names to refuse.
- `functions: string[]`: extra function names whose calls are refused inside a controller.
