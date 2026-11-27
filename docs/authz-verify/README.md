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
| `AZV006` | error | The assertion names a permission or an `isolated` type the policy does not have, or its `never` glob matches none. The message says which (`names no permission of the policy`, `names no type of the policy`). The verdict is `unknown`: nothing about such a name is proved. |
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

The command exits 1. Every engine has nothing to search for a name the policy does not know, so without this check the second line would read `holds (exact)`: a typo would pass CI as a proof. A name that is empty or has blanks around it is printed in quotes (`' invoice:read '`).

## Names that are not checked

`AZV006` covers permission names and the type of `isolated`. These names are not checked yet:

- **Holders of `never`.** `never({ holder: 'role:clrek', permission: 'invoice:read' })` with a misspelt role, an unknown `@type` or `type#relation`, wrong letter case or an empty holder answers `holds (exact)` and the command exits 0. A misspelt holder therefore still passes CI as a proof. This gap is known and will be closed by a later change.
- **Holders of `onlyVia` and the `except` list of `isolated`.** A holder that names nothing excepts nothing, so the answer is stricter than intended (`violated`, or a `holds` that is true without the exception). No false proof results, but nothing reports the typo.
- **Names inside the policy IR itself**, such as a relation or permission that a rewrite names but no type defines, or a permission bound to a type the IR lacks. They are not `AZV006`: the engines drop a path through such a name, so an assertion that depends on it can answer `holds`.
- **The library functions called directly** (`implies`, `onlyVia`, `narrowedImplies`, `reachers`, `accessOf`, `bounded`). Only `verifyAssertions` and `spinajs authz:verify` check names. Called directly, these functions answer `holds`, `[]` or `never` for an unknown permission, and `bounded` throws.
