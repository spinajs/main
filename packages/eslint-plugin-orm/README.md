# `@spinajs/eslint-plugin-orm`

ESLint rules for the SpinaJS ORM.

## Install

```sh
npm i -D @spinajs/eslint-plugin-orm eslint typescript-eslint typescript
```

```js
// eslint.config.mjs
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import orm from '@spinajs/eslint-plugin-orm';

export default defineConfig({ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, orm.configs.recommended);
```

## typed-sql

Checks every `sql` template of `@spinajs/orm` against `app.manifest.json` (written by `spinajs build`) and writes the
row type the query returns:

```ts
const q = sql`SELECT Id, Email FROM users`;
// fixed to
const q = sql<{ Id: number; Email: string }>`SELECT Id, Email FROM users`;
```

It reports the **errors** `spinajs doctor` reports for the template (SQL002–SQL006), on the template itself. Doctor
warnings are not lint errors: a column no model declares on a partial model (the default, see the ORM docs on
partial models) is a warning there and is typed `unknown` here, so it never fails a lint run. SQL005 (the declared
row differs) is fixed by rewriting the type argument. When the row cannot be inferred (an unnamed expression, `*`
over a subquery it cannot type) it suggests `sql<Record<string, unknown>>` and does not fix.

The rule needs no type information. It finds the template in the manifest by file and text. A template the manifest
does not have means the manifest is older than the file: the rule reports that once and checks nothing else in the
file until `spinajs build` runs again. A template whose type argument the manifest does not know (you edited it, or
`--fix` just wrote it) is checked for everything except its row. A file with no `app.manifest.json` between it and
its `package.json` is not checked.

Options: `manifest` (path to the manifest, relative to the ESLint working directory; set it when the manifest is not
above the linted files, as in a monorepo lint from the root) and `dialect` (the name or driver token of a
dialect an installed driver declares, such as `postgresql` or `orm-driver-postgres`; default from
`package.json#spinajs.orm.dialects` of the app, else the only dialect in the manifest, else a generic grammar that types
driver-dependent columns `unknown`).
