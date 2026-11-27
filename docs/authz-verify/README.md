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
| `AZV005` | error | A holder of `never`, `onlyVia` or the `except` list of `isolated` names no holder of the policy (`names no role or relation of the policy`). The verdict is `unknown`. |
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

## Holder names

A holder is written `public`, `role:<role>` (the role on any type), `role:<role>@<type>`, `<type>#<relation>` or `public:<type>#<relation>` (a stored relation of the type, not a permission), or `anyone:<type>#<permission>` (a rewrite that holds for every principal). Each part must be a name of the policy, in the same letter case, or the assertion is `AZV005`:

```text
fail AZV005 never(role:clrek, invoice:read)  role:clrek names no role or relation of the policy
```

Without this check `never` of a misspelt holder would read `holds (exact)`: no path reaches a holder the policy does not have. An assertion that names both an unknown permission and an unknown holder reports only `AZV006`.

## Names that are not checked

`AZV006` covers permission names and the type of `isolated`, `AZV005` the holders. These names are not checked yet:

- **A holder that exists but is never the holder of a path**, such as a stored relation that no path reads first: `never` of it answers `holds`, which is true. A role that shares every relation with a role earlier in sort order is the exception: the engines name each relation after its first role only, so `never` of the later role answers `holds` although the role reaches the permission. `rbacToIR` gives each role its own relation, so only a hand-written IR has such a role.
- **Names inside the policy IR itself**, such as a relation or permission that a rewrite names but no type defines, or a permission bound to a type the IR lacks. They are not `AZV006`: the engines drop a path through such a name, so an assertion that depends on it can answer `holds`.
- **The library functions called directly** (`implies`, `onlyVia`, `narrowedImplies`, `reachers`, `accessOf`, `bounded`). Only `verifyAssertions` and `spinajs authz:verify` check names. Called directly, these functions answer `holds`, `[]` or `never` for an unknown permission or holder, and `bounded` throws.
