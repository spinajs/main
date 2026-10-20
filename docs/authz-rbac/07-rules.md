# Rules

Rules narrow what assignments give, per scope: `restrict` cuts inherited access below a node, `cap` limits a ladder rank or strips tags, `threshold` asks a minimum rank for some permissions. Rules never grant. They come from config (`ConfigRuleStore`) or from the database through `AuthzAdmin` (`DbRuleStore`).

## How it works

1. `registerRbac` passes the rule stores `authz.rbac.stores.rules` names to the model: at most one in-memory store (`ConfigRuleStore`) and one other (`DbRuleStore`).
2. At boot, `RulesExtension.compile()` compiles every config rule against the role graph and the permission registry; a rule naming an unknown ladder, role or permission, or a condition that does not compile, fails boot. It contributes the rules' permission and scope refs to the boot checks.
3. Per check, `RulesExtension.gather()` reads the rules on the path: `ConfigRuleStore.rulesOn(path, now)` in memory and `DbRuleStore.forPath(path, now)` from `authz_rule`. It decides each rule's request-level parts (`when`, `subjects` except `rank`, `resource`, refs).
4. Step `restrict` drops assignments made strictly above a `restrict` rule's scope, unless their subject is in `allow` or the role was implied with `bypass: ['restrict']`.
5. Step `cap` clamps the rank of the selected assignments to `maxRole` (the lowest cap wins), drops them for `maxRole: null`, and empties their tags for `stripTags: true`.
6. Step `threshold` adds a deny entry where the deciding rank is below `minRole`, with the rule's `reason` (default code `threshold`, priority 600).
7. A rule's `expiresAt` bounds the vote's `validUntil`.

On a type-level request (`{ type }`) a rule that would apply differently per row makes the vote fail closed (`model_error`).

## Rule shape

Every kind:

| Key | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Unique. |
| `kind` | `'restrict' \| 'cap' \| 'threshold'` | |
| `scope` | `{ type, id? }` | `$global` (the default in config) or one node with an id. A bare type is refused. |
| `resourceTypes` | `string[]` | Applies only to checks on these types. |
| `subjects` | `SubjectSelector` | Whom it applies to: `principalTypes`, `actorTypes`, `refs`, `rank: { ladder, at, lt \| eq \| gte }`, `when`. All AND. |
| `when` | `Condition` | Applies only when the condition holds. |
| `expiresAt` | `Date \| string \| null` | A `Date`, or an ISO date-time with a zone. One without a zone fails boot. |

Per kind:

| Kind | Keys | Effect |
| --- | --- | --- |
| `restrict` | `allow` (required): principals or subject sets | Below its scope, only assignments made at the scope or below it count, plus those of the listed subjects. |
| `cap` | `ladder` with `maxRole` (a role, `{ ref }` or `null`), and/or `stripTags: true`; `assignments: { scopeTypes?, subjectTypes? }` | Clamps or drops ranks, or strips tags, of the selected assignments. |
| `threshold` | `permissions` (required, globs allowed), `minRole` (required: a role or `{ ref }`), `ladder?`, `at?` (with `ladder`), `resource?`, `reason?` | Denies those permissions below the minimum rank. With `at`, the rank at the nearest node of that type counts. |

A `{ ref }` reads a value: `scope.<type>.<path>` (a scope attribute), `principal.<path>`, `actor.<path>` or `env.<path>`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.rbac.rules` | `RuleDef[]` | `[]` | unique `id`s | Config rules, read by `ConfigRuleStore`. |
| `authz.rbac.stores.rules` | `string[]` | `['ConfigRuleStore']` | `ConfigRuleStore`, `DbRuleStore`, your own; `[]` turns rules off | Rule stores of the model. |

```ts
authz: {
  rbac: {
    rules: [
      { id: 'file-grant-cap', kind: 'cap', ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'] } },
      {
        id: 'no-download', kind: 'threshold', permissions: ['project:export'], minRole: 'editor',
        when: { attr: 'scope.org.policies.viewers_may_download', eq: false }, reason: { code: 'policy' },
      },
    ],
    stores: { rules: ['ConfigRuleStore', 'DbRuleStore'] },
  },
}
```

Rules in `authz.rbac.rules` with no `ConfigRuleStore` in `authz.rbac.stores.rules` fail boot, so they are never dropped without a word.

## Stored rules (`rule.put`, `rule.delete`)

`RbacRuleHandler` writes rules through the domain's `AdminRuleStore` (`DbRuleStore`, registered only when `authz.rbac.stores.rules` names it).

1. `validate`: the shape per kind, a known ladder, `minRole` and `maxRole` on it, registered permission names, subjects, conditions that compile with the domain's `ConditionCompiler` (`rule_not_compilable`), and an existing id at another scope (`conflict`). `DbRuleStore.assertStorable` refuses values longer than their columns.
2. `RbacRuleListGuard` refuses a rule that can match a `list: true` permission (`not_list_filterable`).
3. The actor needs `authz:rules.manage` at the rule's scope.
4. `DefaultAdminGuard` refuses a `minRole` or `maxRole` that ranks above the actor's own at the rule's scope (`escalation`).
5. `DbRuleStore.put` inserts or replaces the rule by id; `rule.delete` removes it. The change tag is `rule:<id>`; the event `RuleChanged`.

```ts
await authz().admin().putRule(actor, {
  id: 'project-3-freeze', kind: 'restrict', scope: { type: 'project', id: '3' },
  allow: [{ type: 'user', id: 'lead-7' }],
});
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Rule store | `RuleStore` (and `AdminRuleStore` for a writable one), per child container, by `registerRbacStores` | `ConfigRuleStore` | `DbRuleStore`, `MemoryRuleStore` | Name classes in `authz.rbac.stores.rules`: one in memory (`all()` and `rulesOn()`), one other. See [Custom stores](11-custom-stores.md). |
| `RbacRuleHandler` | `AuthzWriteHandler`, singleton, at import | `RbacRuleHandler` | none | Add an `AuthzCommandValidator` to refuse rules your product forbids. |
| `RbacRuleListGuard` | `ListSupportGuard`, singleton, at import | `RbacRuleListGuard` | none | none |

`readRuleDefs(rules, source?)` turns config rules into frozen `RuleDef`s (default scope `$global`, `expiresAt` as a `Date`).

## Important behaviour

- **Rules block lists.** A `restrict` or `cap` rule acts on every permission of its `resourceTypes` (all types without it); a `threshold` on its own `permissions`. Boot refuses a config rule that can match a `list: true` permission on one of its types (boot rule 12), and a list plan that meets a live stored rule fails with `model_error`.
- **`restrict` reads the path.** On a type-level request it changes nothing at the type; rules at other nodes make the vote fail closed.
- **Caps compose.** The lowest `maxRole` wins; ranks for `subjects.rank` are read after `restrict` and before any cap, so caps do not depend on each other's order.
- **A cap never leaves more than the capped role gives**: implied roles of a capped or dropped assignment go too, unless they bypass `cap`.
- **Two stores at most.** Two in-memory or two other rule stores throw `AuthzConfigError`.

## Best practices

- Give `restrict` and `cap` rules `resourceTypes` that leave out the types you list with `.accessible()`.
- Keep product-wide rules in config and per-customer rules in `DbRuleStore`; admins then change only their own scope's rules, under `authz:rules.manage`.
- Set a `reason` on every threshold, so the deny tells the client why (`{ code: 'policy' }`).

## Patterns and antipatterns

```ts
// Don't: a cap without resourceTypes acts on every permission, so every list: true permission becomes unlistable
rules: [{ id: 'link-cap', kind: 'cap', ladder: 'project', maxRole: 'viewer', assignments: { subjectTypes: ['link'] } }]

// Do: scope it to the types you never list
rules: [{ id: 'link-cap', kind: 'cap', ladder: 'project', maxRole: 'viewer', assignments: { subjectTypes: ['link'] }, resourceTypes: ['file'] }]
```

## Related

- [Ladders, tags and implied roles](06-ladders-tags-and-implied-roles.md): the ranks rules clamp and compare.
- [How a check resolves](05-check-resolution.md): where steps 2, 3 and 8 run.
- [Database storage](02-database-storage.md#authz_rule): `authz_rule` and `authz_rule_subject`.
- [List filter term](01-list-filter-term.md): why lists cannot follow rules.
