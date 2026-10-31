# Policies

A policy permits or denies a set of permissions, for the requests it targets, where its scope and its condition hold. `AbacModel` reads policies from its [policy stores](05-policy-stores.md) and checks each one when it loads it.

## How it works

1. A store's `load()` returns plain policy objects: from config, memory, the database or your own source.
2. `loadPolicy(raw, order, { source }, parse)` checks each one and returns a frozen `LoadedPolicy`: the policy, its parsed condition, its type lists as sets, its `priority` (default `DEFAULT_POLICY_PRIORITY`, 500) and its `expiresAt` as a `Date`. Any error is an `AuthzConfigError` that starts with `abac policy "<id>"` (or `#<order>` without an id).
3. `PolicyIndex` maps each permission of the registry to the policies whose `permissions` name it, exactly or through a glob. An exact permission that is not registered throws `UnknownPermission`.
4. On a check, `candidates(permission, type)` filters by `resourceTypes`, then `targets()` by expiry, principal type and actor type, then the scope and the condition decide where the policy holds ([The ABAC model](01-abac-model.md#a-check)).

## Policy fields

`Policy` is declared in `@spinajs/authz` and re-exported by this package.

| Field | Type | Required | Meaning | Checked at load |
| --- | --- | --- | --- | --- |
| `id` | `string` | yes | Unique id across every store of the model. | Non-empty string; a second policy with the id fails the index. |
| `effect` | `'permit' \| 'deny'` | yes | What the policy votes. | One of the two. |
| `permissions` | `string[]` | yes | Permissions or globs: `invoice:update`, `invoice:*`, `user.*:read`, `*`. | Non-empty; each a permission or a glob; an exact one must be registered. |
| `resourceTypes` | `string[]` | no | Resource types it targets; omitted means every type. | Non-empty list of non-empty strings. |
| `principalTypes` | `string[]` | no | Principal types it targets; a companion's type matches too (a share link's signed-in user). | As above. |
| `actorTypes` | `string[]` | no | Types of the acting principal: `req.actor`, else the principal. Under `inherit` delegation the agent is the actor. | As above. |
| `scope` | `{ type, id? }` | no | Applies at this node and below. Without `id`: any node of the type. `{ type: '$global' }` is everywhere. | `$global` takes no id; an empty id is refused. |
| `when` | `Condition` | no | The condition ([Conditions](03-conditions.md)). | Parsed, function names and args included. |
| `fields` | `{ read?, write?, hide? }` | no | Field globs (`'name'`, `'a.*'`, `'*'`, `'!salary'`). `read` and `write` on a permit, `hide` on a deny. | Wrong key or wrong effect refused. |
| `reason` | `string` | no | The deny reason code; `'policy'` when unset. | Non-empty string. |
| `priority` | `number` | no | Rank of the deny reason; lower is reported first. Default 500. | 32-bit integer. |
| `expiresAt` | `Date \| null` | no | The policy stops applying at this instant; it also caps the decision's `validUntil`. | A `Date`, an ISO string or `null`. |
| `source` | `string` | set by the store | `'config'`, `'memory'`, `'db'` or your store's `name`. | A string; defaults to the store's `name`. |

Any other key fails the load.

## Configuration

Policies in config go under `authz.<model name>.policies`, `authz.abac.policies` for the default model; the key is on [Policy stores](05-policy-stores.md#configuration). Every permission a policy names exactly must be registered, for example in `authz.permissions` ([Config](../authz/04-host-boot-and-configuration.md#configuration)). A permission registered without `types` targets the type before its colon.

```ts
export default {
  authz: {
    permissions: {
      'invoice:read': { list: true },
      'invoice:update': {},
    },
    abac: {
      policies: [
        { id: 'finance-reads-invoices', effect: 'permit', permissions: ['invoice:read'], principalTypes: ['user'],
          when: { attr: 'principal.attributes.dept', eq: 'finance' } },
        { id: 'frozen-invoices', effect: 'deny', permissions: ['invoice:update'],
          when: { attr: 'resource.status', eq: 'frozen' }, reason: 'invoice_frozen' },
      ],
    },
  },
};
```

`authz.abac.policies` concatenates across every config file and source (see [Arrays](../configuration/01-configuration-service.md#arrays)), so a package fragment can add policies and an app adds its own to them.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Policy loader | none; a function | `loadPolicy` | none | Call it from a custom store or tool to check a policy the way the model does. |
| Policy index | none; built by `AbacModel` | `PolicyIndex` | none | Not replaceable. `targets`, `targetsPrincipal` and `scopeFilter` are exported for tools and tests. |

## Important behaviour

- **Unregistered permission fails the boot** (B02), not only the policy. A glob that matches nothing is accepted.
- **A deny with `fields.hide` still denies.** It does not only hide the fields.
- **Expiry is checked per request** against the engine's clock; an expired policy needs no reload to stop applying.
- **The engine reports one reason**: the deny with the lowest `(priority, sortKey)`, whatever the order of policies and models (B36). `sortKey` is the policy id.
- **`scope` without `id`** matches any node of the type, as `under` reads it. A scope other than `$global` makes the policy row-dependent, so it cannot serve a `list: true` permission ([Lists](04-lists.md)).
- **Policies of all stores share one id space.** `AbacModel.validate` refuses a stored policy whose id a policy of another store already uses.

## Best practices

- Name ids after the rule (`mfa-admin-writes`), not after a number: deny reasons and errors quote them.
- Narrow a policy with `resourceTypes` and `principalTypes` before reaching for `when`: they are checked without compiling anything.
- Prefer exact permissions over `*`; a broad glob routes the model to every permission and costs a vote on each check.

## Patterns and antipatterns

```ts
// Don't: fields.hide on a permit is refused at load
{ id: 'hide-salary', effect: 'permit', permissions: ['user:read'], fields: { hide: ['salary'] } }

// Do: a permit narrows what it gives; a deny hides (and denies)
{ id: 'read-public-profile', effect: 'permit', permissions: ['user:read'], fields: { read: ['*', '!salary'] } }
```

## Examples

### Block agents outside office hours

```ts
authz: {
  abac: {
    policies: [
      { id: 'agents-office-hours', effect: 'deny', actorTypes: ['agent'], permissions: ['*'],
        when: { not: { fn: 'time.between', args: { from: '08:00', to: '18:00', tz: 'Europe/Warsaw' } } },
        reason: 'outside_office_hours' },
    ],
  },
}
```

### Check a policy the way the model loads it

```ts sample
import { AuthzConfigError, DefaultConditionCompiler } from '@spinajs/authz';
import { loadPolicy } from '@spinajs/authz-abac';

// Validate policies from an import file before handing them to an admin.
export function policyErrors(raw: readonly unknown[]): string[] {
  const compiler = new DefaultConditionCompiler();
  const errors: string[] = [];
  raw.forEach((p, i) => {
    try {
      loadPolicy(p, i, { source: 'import' }, (c, where) => compiler.parse(c, where));
    } catch (e) {
      if (!(e instanceof AuthzConfigError)) throw e;
      errors.push(e.message);
    }
  });
  return errors;
}
```

`loadPolicy` checks shape and condition only. Registered permissions and unique ids are checked by `PolicyIndex` and `AbacModel.validate`.

## Related

- [The ABAC model](01-abac-model.md): how policies turn into a vote.
- [Conditions](03-conditions.md): the `when` language.
- [Policy administration](07-policy-administration.md): `policy.put` and `policy.delete` through `AuthzAdmin`.
- [Config](../authz/04-host-boot-and-configuration.md#configuration): `authz.permissions` and the other core keys.
