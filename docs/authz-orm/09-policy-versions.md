# Policy versions

Every decision record carries a `policyHash`: the SHA-256 of the policy the domain ran when it decided. With `@spinajs/authz-orm` imported and a decision log registered, a domain compiles its policy into the canonical policy IR (`@spinajs/authz-ir`) when it boots, its records cite that hash, and the IR itself is stored once per hash in `authz_policy_version`. `spinajs authz:compile` writes the same IR to `authz.ir.json`, the input of `authz:verify` and `authz:export`.

Without a decision log nothing is compiled, and the records of an app without `@spinajs/authz-orm` keep `policyHash: 'unknown'`.

## What the policy hash covers

The hash is the hash of the **config IR**: the policy declared in configuration and code. Policy held in database stores is not compiled into it; each such store becomes a placeholder term `{ opaque: 'stored:<model>:<store>' }`, also listed in `ir.opaque`. The hash is then the same for every node of a deploy and does not change when an admin edits a stored rule; those edits reach the changelog instead.

| Source | In the config IR | In `authz:compile --live` |
| --- | --- | --- |
| `authz.rbac.roles`, ladders, grants, config rules (rules are opaque terms) | compiled | compiled |
| RBAC `DbRuleStore` | an opaque deny term `stored:rbac:DbRuleStore` on every permission | the same (RBAC never compiles rules) |
| ABAC `ConfigPolicyStore` policies | compiled | compiled |
| ABAC `DbPolicyStore` / `MemoryPolicyStore` policies | not compiled; `stored:abac:<store>` (for `DbPolicyStore`, `stored:abac:db`) added to `abac_permit_<P>` and `abac_deny_<P>` of every registered permission | compiled |
| `authz.rebac.namespaces`, `@Parent`, `@Owner`, `@Self`, `@Relation` | compiled | compiled |
| models without `toIR`, custom combinators | `opaque` entries | the same |

What it does not cover:

- **Engine semantics.** The hash covers the IR and its `PolicyIR.version` only. A fix in an evaluator or a combinator that leaves the IR as it was does not change the hash.
- **Order.** The canonical form sorts keys, set operands, `allowed` and `opaque`, so model and fragment order do not change the hash. Two `@AccessResource` classes that define the same relation differently are a merge conflict: the fragments are sorted by model name first and the first one wins, so the app and the CLI resolve it the same way. The conflict is logged.

## At boot

1. Importing `@spinajs/authz-orm` registers `IRPolicyHashSource` as the `PolicyHashSource`.
2. A domain boots. When it has a decision log (a `DecisionLog` is registered and `authz.decisionLog.mode` is not `'off'`), the host awaits `IRPolicyHashSource.prepare(domain, service)` before the domain's service resolves, so no record of that domain is written before its hash is known.
3. `prepare` compiles the domain (`compileDomainPolicy`: the models, the `@AccessResource` relations, the domain's `authz.combine`) and logs:

   ```
   authz-orm: domain root runs policy 3f1a…c2 (6 ms, 1 opaque)
   ```

   The compile runs in memory; for the test fixtures it takes about 6 ms.
4. In mode `'record'` the first boot of a hash in the process stores the IR in `authz_policy_version`, in the background with retries after 1 s, 5 s and 30 s. A slow database never delays the boot.

`IRPolicyHashSource.current(domain)` returns the running snapshot: `hash`, `ir`, `canonical`, `conflicts`, `compiledAt` and `recorded` (a promise: `true` stored now, `false` known already, `undefined` not stored).

### `authz.changelog.policyVersion`

| Value | Effect for a domain with a decision log |
| --- | --- |
| `'record'` (default) | compile at boot, records cite the hash, the IR is stored in `authz_policy_version` |
| `'hash'` | compile at boot, records cite the hash, nothing is written (OTLP-only sinks, no migration rights) |
| `'off'` | nothing is compiled; records carry `'unknown'` |

```ts
export default {
  authz: { changelog: { retentionDays: 400, policyVersion: 'record' } },
};
```

A domain without a decision log is never compiled, whatever the value.

### An unreachable store degrades to `'hash'`

The first write of a process reads `authz_policy_version` once. When that read fails (no `authz` connection alias, no table, the database is down), the process logs one warning and from then on only cites hashes, as in mode `'hash'`:

```
authz-orm: authz_policy_version is not reachable on the authz connection; this process cites policy hashes without storing them (mode 'hash'); run `spinajs authz:compile --record` where the database is reachable
```

A write that fails after a successful read is retried; when the last retry fails it logs an error and a later domain boot tries again.

## Several nodes and rolling deploys

Every node records, not a leader only. During a rolling deploy two policies run at once and each node cites its own hash; the row of each must exist. The write is idempotent: one primary-key read per new hash per process, and a unique violation from a node that wrote first counts as success. Several domains of one process with the same policy write once. The table is content-addressed and serves every domain and node that runs the same policy; it is on the `authz` connection, like `authz_change_log`, and the retention job never prunes it.

## `spinajs authz:compile`

```
spinajs authz:compile [-o authz.ir.json] [--domain <name>] [--live] [--check] [--record]
```

The command boots the domain's `AuthzService` and compiles it as a booting app does.

| Option | Meaning |
| --- | --- |
| `-o, --out <path>` | the file written; default `authz.ir.json`, the default `--ir` of `authz:verify` and `authz:export` |
| `--domain <name>` | the domain compiled; default `authz.orm.domain`, else `root` |
| `--live` | the effective policy: DB-stored ABAC policies are compiled in. Its hash is not a policy version, and the command says so |
| `--check` | writes nothing; exit code 1 when the file is missing, not valid JSON, not a valid policy IR, or holds a different policy |
| `--record` | also stores the policy version in `authz_policy_version` (a backfill); refused with `--live` |

The file is a bare `PolicyIR`, pretty-printed for reviewable diffs; the hash is computed over its canonical form, so formatting does not change it. The hash is printed, not stored in the file:

```
$ npx spinajs authz:compile && npx spinajs authz:verify
wrote /app/authz.ir.json
policyHash 3f1a…c2
opaque 1: stored:rbac:DbRuleStore
```

Commit `authz.ir.json` and keep it current in CI:

```
$ npx spinajs authz:compile --check
authz:compile: /app/authz.ir.json is stale (hash 9b0e… differs from the compiled 3f1a…); run spinajs authz:compile
```

The reason in parentheses is `missing`, `not valid JSON`, `invalid IR: <codes>` or `hash <old> differs from the compiled <new>`. A merge conflict prints `conflict <path>: <message>`; a compiled IR that fails validation prints `invalid <code> <path>: <message>` per diagnostic and writes nothing.

To verify the policy as it runs, stored policies included:

```sh
npx spinajs authz:compile --live -o live.ir.json && npx spinajs authz:verify --ir live.ir.json
```

## When the hash is `'unknown'`

A record carries `policyHash: 'unknown'` when:

- no `PolicyHashSource` is registered (`@spinajs/authz-orm` is not imported);
- `authz.changelog.policyVersion` is `'off'`;
- the compile failed: a model's `toIR` threw. The host logs `Authz domain <name>: the policy hash source failed to prepare; decision records carry policyHash 'unknown'` and the boot goes on;
- `@spinajs/authz-ir` cannot be loaded (a pruned or bundled install): one warning per process.

`@spinajs/authz-orm` loads `@spinajs/authz-ir` only when it compiles, so the last case is reachable only in an app that loads it nowhere else. `@spinajs/authz-abac` and `@spinajs/authz-rbac` import it when they are imported (for the `stored:` placeholder names): an app with either model loads `@spinajs/authz-ir` at startup, whatever `authz.changelog.policyVersion` says, and fails at that import, not at boot, when the package is missing.

## When the hash has no row

A 64-hex hash without a row in `authz_policy_version` means the process ran in mode `'hash'`, configured or degraded after a failed read, or the background write gave up. Store the row from where the database is reachable, with the code and configuration of that deploy:

```sh
npx spinajs authz:compile --record
```

It prints `recorded <hash>`, or `already recorded <hash>` when the row exists.
