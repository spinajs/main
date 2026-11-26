# `@spinajs/authz-verify`

Checks an app's authorization assertions against its compiled policy IR: "the public never updates anything", "whoever may approve an invoice may read it". A development and CI tool: runtime code never imports it. The `spinajs authz:verify` command of `@spinajs/cli` runs it.

```sh
npm install --save-dev @spinajs/authz-verify
npx spinajs authz:verify --ir authz.ir.json --assertions authz.assertions.js
```

The assertions file's default export is `defineAssertions(({ implies, separated, isolated, onlyVia, never }) => [...])`. `never({ holder, permission })` takes a permission glob (`*:update`); the other kinds take exact permission names. Names are case-sensitive, as in the permission registry.

## Diagnostics

| Code | Severity | Meaning |
| --- | --- | --- |
| `AZV001` | error | Violated; the counterexample is printed. |
| `AZV002` | info | Holds: `holds (exact)`, or `verified up to k=N` by the bounded engine. |
| `AZV003` | warning | Not decided, or the verdict depends on an opaque part of the policy. |
| `AZV004` | info | `implies` holds for principals without a ceiling; `{ narrowed: true }` checks ceilings. |
| `AZV006` | error | The assertion names a permission the policy does not have, or its `never` glob matches none. The verdict is `unknown`: nothing about such a name is proved. |
| `AZV090` | warning | Only the bounded engine could decide and `z3-solver` is not installed; an error with `--require-solver`. |

The command exits 1 when a diagnostic of the `--fail-on` severity or worse is printed: `error` by default, `warning` to fail on undecided assertions too.

## A misspelt permission

```ts
export default defineAssertions(({ implies, never }) => [
  implies('folder:update', 'folder:read'),
  never({ holder: 'public', permission: 'folder:updaet' }),
]);
```

```text
ok   AZV002 implies(folder:update, folder:read)  holds (exact)
fail AZV006 never(public, folder:updaet)         folder:updaet names no permission of the policy
1 error(s), 0 warning(s), 1 info
```

The command exits 1. Every engine has nothing to search for a name the policy does not know, so without this check the second line would read `holds (exact)`: a typo would pass CI as a proof.
