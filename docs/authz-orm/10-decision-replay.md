# Decision replay

A logged decision can be replayed: the authz state and the policy are rebuilt as they were at the decision's instant, the decision is evaluated again with the reference evaluator of `@spinajs/authz-ir`, and the answer says whether the log can be trusted for it. Support uses it to answer "why was I denied yesterday?" after the data has moved on.

Replay needs the [database decision log](08-database-audit.md#authz_decision_log), the authz changelog (`authz_change_log`) and the [policy versions](09-policy-versions.md). It is reached through `spinajs authz:replay <id>` or, in an app with `@spinajs/authz-http`, `GET /authz/decisions/:id/explain` ([Explain](../authz-http/09-explain.md#the-decisions-route)).

## Setup

```ts
import '@spinajs/authz-orm/replay';

export default {
  db: { Aliases: { 'authz-audit': 'default' } },
  authz: {
    decisionLog: { mode: 'all' },
    changelog: { policyVersion: 'record' },
    replay: { maxChanges: 50000, concurrency: 2 },
  },
};
```

Importing `@spinajs/authz-orm/replay` registers `DbDecisionReplay` as the `DecisionReplay` of `@spinajs/authz`, and the history contributors of ORM relation columns and of `DbScopeAttributeStore` leaves. `@spinajs/authz-rbac` and `@spinajs/authz-rebac` register the contributors of assignments and tuples, `@spinajs/authz-rbac` and `@spinajs/authz-abac` the splicers of DB-stored rules and policies. Register `DbDecisionLog` as the `DecisionLog` so decisions are written to `authz_decision_log`.

## How a replay works

1. The record is read from `authz_decision_log` by id, on the primary. A row it cannot read back is `unreplayable` (`record`); an unknown id answers nothing.
2. The policy is the IR stored under the record's `policyHash` in `authz_policy_version`. DB-stored rules and policies are spliced in as they were at the instant.
3. Every key the evaluation reads is rebuilt at `T = loggedAt`, backwards from its current row through the changes logged after `T`. A key whose state the history cannot prove is a gap; the evaluator treats a gap as `unknown`.
4. The verdict applies the rules below in order.

| Verdict | When | The report names |
| --- | --- | --- |
| `unreplayable` | The record lacks something (a truncated principal or resource key, a type-level or `filter` decision, a SYSTEM principal, companions, facts the policy needs), the policy version is missing or `'unknown'`, or the replayed answer is `unknown` | `missing[]`: each input with a reason, such as `policy_version`, `column:<type>`, a gap key, an opaque term, a caveat parameter, `limit`, `history-budget` or `timeout` |
| `divergent` | The stored policy does not hash to its key, the replayed answer differs from the logged one, or captured inputs hash or read differently | `divergence[]`: `policy-hash`, `outcome` (with `(cached)` for a cached decision), `inputs-hash` or `captured-state` |
| `faithful` | Otherwise | `evidence`: `inputs-hash` with captured inputs, `outcome` without |

A `divergent` verdict with complete history means a write outside the changelog on a key without logged history, a difference between the IR and the engine, or a cached decision; the report cannot tell them apart. `currentPolicy` says whether the record's policy is the one its domain runs now: a record of an older deploy replays all the same.

## What it cannot prove

- **Inputs not captured.** The condition context holds only what the record holds. With `authz.decisionLog.captureInputs` off (the production default) every decision that reached a caveat over `env` or principal or resource attributes is `unreplayable`, naming the parameter. Application condition functions are `unknown` in any case: their code at `T` is gone.
- **Raw SQL.** A write outside the changelog to a key that exists now is caught only where the key has logged history. A grant deleted by raw SQL after `T`, with no changelog row, is invisible whether or not it has logged history: the key is absent now and has no change after `T`, so the replay answers as if it never existed and can be `divergent`. The protection against that holds for ORM relation columns only, not for assignments and tuples.
- **Captured attributes are checked one way.** With captured inputs, each captured scope attribute is rebuilt from the attribute history. A captured path the store did not hold at `T` proves nothing (defaults and adapters fill nodes in); a logged leaf changed by raw SQL after `T` is a gap, not a finding. Attribute changes count against `maxChanges` and `maxKeys` like any other.
- **Stored RBAC rules.** The IR cannot express a rule, so each rule held at `T` that can match the permission stays an opaque term. An expired rule still counts until it is deleted (the replay answers `unreplayable`), and a `restrict` or `cap` rule at any scope can make an RBAC allow `unreplayable`.
- **Stored ABAC policies.** A DB policy whose state at `T` is a gap, or whose stored image no longer loads, is an opaque `abac policy <id>` on both sides of every permission. A policy whose caveat name another stored policy shares, or that the stored IR holds with another meaning, is opaque across the whole domain, so any decision that reaches the ABAC relations can be `unreplayable`. Policy stores that write no changelog (`MemoryPolicyStore`, config) keep the `stored:` placeholder opaque.
- **Coverage is what the boots recorded.** History of a kind starts at the first boot that tracked it, and retention moves that start forward. A decision before it is `unreplayable`. During a rolling deploy that turns tracking on for a type, nodes of the old version keep writing without logging after the first new node restarted coverage, so decisions made before the last old node stopped are not provably replayable for that type. An app that swaps a DB store for a memory store without `changelog: false` keeps a stale horizon.
- **Long transactions.** A change is stamped when its row is inserted, not when it commits. Changes within `clockSkewMs` after `T` and `durationMs + clockSkewMs + commitLagMs` before it are gaps. A transaction that holds an authz write open longer than `commitLagMs` and commits after `T` is not detected, and neither is a transaction that loses a write and stays open longer than that window after its `lost` marker. Raise `commitLagMs` for long authz-writing transactions.
- **Membership closure** (`authz_membership` rows written outside assignments) is not replayed.

## What a report reveals

A report carries the record's principal facts (type, id, ceiling, `onBehalfOf` chain, delegation, companions), the captured principal state, attributes and `env` when `captureInputs` is on, and through `tree` and `reads` which other subjects held the relations the decision read at `T`. That is more than `authz:explain` shows, so the HTTP route checks its own permission (`authz.http.decisionsRoute.permission`, default `authz:replay`), in the record's domain too. Every answered call writes an `explain` entry naming the decision to the access domain's selected `DecisionAudit`, and a replay of a domain the caller may not see writes a `deny` entry. Declare `authz:replay` in `authz.permissions` of the access domain and of every domain whose records it replays (or of their common parent), and grant it like an admin permission. The 404 of such a domain hides the answer, not the replay's duration: the replay runs before its domain is known.

## `spinajs authz:replay`

```
spinajs authz:replay <decisionId> [-f text|json] [--max-changes <n>] [--fail-on divergent|unreplayable|never]
```

| Option | Meaning |
| --- | --- |
| `<decisionId>` | the record's UUIDv7, the `decisionId` of its 403 |
| `-f, --format` | `text` (default): the verdict, the outcome, the policy, `missing`, `divergence` and the tree indented; `json`: the `ReplayReport` |
| `--max-changes <n>` | changes after the decision to scan; default `authz.replay.maxChanges`, capped at 500,000 |
| `--fail-on` | exit code 1 at this verdict or a worse one (`faithful` < `divergent` < `unreplayable`); default `divergent`, `never` always exits 0 |

An unknown id prints `authz:replay: no decision <id> in the decision log` and exits 1. The command runs as SYSTEM, waits while `concurrency` replays run in the process, and never opens a transaction.

```
$ npx spinajs authz:replay 019a8e2c-6c1e-7a51-9f3e-2b1c4d5e6f70
faithful (evidence: outcome)
decision 019a8e2c-6c1e-7a51-9f3e-2b1c4d5e6f70 at 2026-11-17T10:00:00.000Z in root: user:alice doc:read doc:1
outcome recorded deny, replayed deny
policy 3f1a…c2 (current); 12 changes scanned, 3 keys
tree:
  doc:1#doc:read = deny (union)
```

## Configuration

| Key `authz.replay.` | Default | Over the limit |
| --- | --- | --- |
| `maxChanges` | 50,000 (at most 500,000) | `unreplayable`, `history-budget` |
| `maxKeys` | 5,000 | `unreplayable`, `history-budget` |
| `maxDepth`, `maxCalls` | 8, 10,000 | `unreplayable`, `limit` |
| `timeoutMs` | 15,000 | `unreplayable`, `timeout` |
| `concurrency` | 2 | `ReplayBusy`: HTTP 429 with `Retry-After: 5`; the CLI waits |
| `clockSkewMs` | 1,000 | the window on both sides of `T` |
| `commitLagMs` | 5,000 | the window before `T` |

A replay scans about 0.5 KB per change, so the default scan peaks near 25 MB.

## Important behaviour

- **Never inside a transaction.** `DbDecisionReplay` refuses to run inside a transaction open on the authz connection (`ReplayInTransaction`, an `AuthzConfigError`): the changelog would be read from the transaction's snapshot while the stores' rows stay fresh.
- **Primary only.** Every read goes to the primary; a lagging replica would pair a stale row with a fresh changelog.
- **Policy versions are required.** A record whose hash has no row is `unreplayable` with `{ input: 'policy_version', key: <hash> }`; `spinajs authz:compile --record` stores it.

## Related

- [Database audit](08-database-audit.md): `authz_decision_log` and its columns.
- [Policy versions](09-policy-versions.md): the hash a record cites.
- [`@spinajs/authz-http` explain](../authz-http/09-explain.md#the-decisions-route): the HTTP route.
