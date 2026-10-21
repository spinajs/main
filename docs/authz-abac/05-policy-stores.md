# Policy stores

A `PolicyStore` is where `AbacModel` reads its policies. The package ships three: `ConfigPolicyStore` (config), `MemoryPolicyStore` (memory, tests) and `DbPolicyStore` (the `authz_policy` table). A model reads every store it holds and merges their policies.

## How it works

1. `new AbacModel({ stores })` takes the stores in order. Without `stores`, `AbacModel.init` calls `storesFromConfig(name, ctx)`, which builds one store per name in `authz.<name>.stores`:
   - `'ConfigPolicyStore'`: `new ConfigPolicyStore(authz.<name>.policies)`;
   - `'DbPolicyStore'`: `new DbPolicyStore()`;
   - any other name, or a value that is not a list: `AuthzConfigError`.
2. A load calls `load()` on every store at once, then checks each policy in store order, its `source` defaulting to the store's `name`.
3. A store that does not return a list fails the load with `AuthzConfigError` naming the store. A policy that fails its check fails the whole load.
4. The model reloads every store on an invalidation of `*`, `policy`, `policy:<id>` or `model:<name>`, unless every store is a `ConfigPolicyStore` ([The ABAC model](01-abac-model.md#important-behaviour)).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.abac.stores` | `string[]` | `['ConfigPolicyStore']` | `ConfigPolicyStore`, `DbPolicyStore` | Stores `new AbacModel()` builds when no `stores` option is passed. |
| `authz.abac.policies` | `object[]` | `[]` | policy objects ([Policies](02-policies.md#policy-fields)) | Policies the built `ConfigPolicyStore` holds. |
| `authz.abac.connection` | none | none | none | Removed: `AbacModel.init` fails with an `AuthzConfigError` naming `db.Aliases.authz`. |

A model with another `name` reads `authz.<name>.*`. The schema `AUTHZ_ABAC_CONFIGURATION_SCHEMA` checks `authz.abac` only; it is registered at import and again by `AbacConfigBootstrapper`. `ABAC_STORE_NAMES` and `ABAC_DEFAULT_STORES` hold the allowed and default store names.

```ts
export default {
  authz: {
    abac: {
      stores: ['ConfigPolicyStore', 'DbPolicyStore'],
      policies: [{ id: 'agents-read-only', effect: 'deny', actorTypes: ['agent'], permissions: ['*:update', '*:delete'] }],
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Policy store | none for the model, which takes instances in `stores`; `PolicyStore` for `AuthzAdmin`, which writes to the one writable store registered under it | `ConfigPolicyStore` | `MemoryPolicyStore`, `DbPolicyStore`, your own subclass of `PolicyStore` | Pass the instances to `new AbacModel({ stores })`. Register a `MemoryPolicyStore` or `DbPolicyStore` as `PolicyStore` to write through `AuthzAdmin` ([Policy administration](07-policy-administration.md)). |

| Store | `name` (policy `source`) | `load()` | `version()` | Writes |
| --- | --- | --- | --- | --- |
| `ConfigPolicyStore(policies)` | `'config'` | The policies given to the constructor, frozen. | Hash of their content. | None; config never changes at run time. |
| `MemoryPolicyStore(policies)` | `'memory'` | The current map, by id. | A counter that each write moves. | `put(policy)`, `delete(id)`: synchronous, no checks. |
| `DbPolicyStore()` | `'db'` | Every `authz_policy` row ([Database policy store](06-database-policy-store.md)). | Hash of the rows. | `put` and `delete` inside an `AuthzAdmin` transaction. |

The `PolicyStore` contract:

| Member | Meaning |
| --- | --- |
| `readonly name: string` | Store name; the default `source` of its policies, and the store named in errors. |
| `load(): Promise<readonly Policy[]>` | Every policy, as plain objects. The model checks them; the store need not. |
| `version(): Promise<string>` | A value that changes when the policies change. `AbacModel` does not read it; it hashes what it loaded. |

### Policy store: custom implementation

Write a store when policies live somewhere the shipped stores do not reach: a file, a remote service, a settings table you already have. Return plain policies from `load()`; the model checks them. Tell the model to reload by invalidating `model:<name>` (or `policy`): on one node with `AuthzService.invalidate`, on every node by publishing an `AuthzChange` on the `ChangeBus`.

```ts sample
import { readFile, stat } from 'node:fs/promises';
import { DI } from '@spinajs/di';
import { AuthorizationModel, AuthzContributor, authz } from '@spinajs/authz';
import type { Policy } from '@spinajs/authz-abac';
import { AbacContributor, AbacModel, ConfigPolicyStore, PolicyStore } from '@spinajs/authz-abac';

// Policies the security team ships as a JSON file next to the app.
export class JsonFilePolicyStore extends PolicyStore {
  readonly name: string = 'security-file';

  constructor(private readonly path: string) {
    super();
  }

  async load(): Promise<readonly Policy[]> {
    const list = JSON.parse(await readFile(this.path, 'utf8')) as Omit<Policy, 'source'>[];
    return list.map((p) => ({ ...p, source: this.name }));
  }

  async version(): Promise<string> {
    return String((await stat(this.path)).mtimeMs);
  }
}

export function wireFilePolicies(fromConfig: readonly unknown[]): void {
  const abac = new AbacModel({ stores: [new ConfigPolicyStore(fromConfig), new JsonFilePolicyStore('security/policies.json')] });
  DI.register(() => abac).as(AuthorizationModel);
  const contributor = new AbacContributor(abac);
  DI.register(() => contributor).as(AuthzContributor);
}

// Call after the file changed: this node reloads the model's stores on its next request.
export function reloadFilePolicies(): void {
  authz().invalidate(['model:abac']);
}
```

## Important behaviour

- **One failing store fails the load.** At boot that fails the domain; at a reload the model keeps routing on its last good policies and retries.
- **Stores are read together.** `load()` runs on every store at once, so the slowest store sets the load time, and requests of the model wait for it during a reload.
- **Ids are global to the model.** Two stores with one policy id fail the index.
- **A config-only model is static.** It ignores invalidations and can be `sync: 'always'`; adding any other store, even an empty `MemoryPolicyStore`, makes it `'never'`.
- **`MemoryPolicyStore` does not check.** Its `put` stores what it gets; the model checks at the next load. Through `AuthzAdmin` the handler checks first.

## Best practices

- Keep reviewed, long-lived rules in `ConfigPolicyStore`, and the ones admins change at run time in `DbPolicyStore`.
- Return the same policy ids from a custom store on every load; ids show up in deny reasons and audit.
- Use `MemoryPolicyStore` in tests: a `put` followed by `model.invalidate(['policy'])` applies the change.

## Patterns and antipatterns

```ts
// Don't: a store name typo is refused, and a string is not a list
authz: { abac: { stores: 'DbPolicyStore' } }

// Do
authz: { abac: { stores: ['ConfigPolicyStore', 'DbPolicyStore'] } }
```

## Examples

### Change a policy in a test

```ts sample
import type { Policy } from '@spinajs/authz-abac';
import { AbacModel, MemoryPolicyStore } from '@spinajs/authz-abac';

export function freezeInvoices(store: MemoryPolicyStore, model: AbacModel): void {
  const policy: Policy = { id: 'freeze-invoices', effect: 'deny', permissions: ['invoice:update'], reason: 'frozen', source: 'memory' };
  store.put(policy);
  model.invalidate(['policy:freeze-invoices']);
}
```

The next check of the model waits for the reload and sees the deny.

## Related

- [Database policy store](06-database-policy-store.md): `DbPolicyStore`, its table and migration.
- [Policy administration](07-policy-administration.md): writing to the store through `AuthzAdmin`.
- [The ABAC model](01-abac-model.md): loads, reloads and the `stores` option.
