# Permission checks in app tests

Test code that calls `authz().can()`, `assert()` or `check()` against the real engine, with permissions granted by a fake model instead of a database. Use it for services, controllers and jobs whose behaviour depends on a permission.

## How it works

1. `testHost.installHost()` registers `TestConfiguration` as the DI `Configuration` in the root container and resolves it. It holds an in-memory object: no file, no env source, no schema validation.
2. You write the `authz.*` keys the host reads: `authz.permissions`, `authz.combine`, and `authz.cache` when you want it off.
3. `testHost.activate(DI.RootContainer, 'root', model)` registers a kit model under `AuthorizationModel` as a factory named after `model.name` (through `registerInRoot`) and appends that name to `authz.models`. `authz.combine` routes the same name. `FakeRbacModel` is named `rbac` by default; a `StaticModel` takes `name`.
4. `(await testHost.domains()).service('root')` boots the root `AuthzService` with that model, as at app boot. An unregistered permission then throws `UnknownPermission`.
5. Checks run through the engine: combining, the L1/L2 caches, the decision audit and the reason codes are the real ones.
6. `testHost.resetHost()` between tests disposes the domains, the root service and the root registrations, and empties the config. `testHost.uninstallHost()` in the last hook also removes `TestConfiguration`.

## Configuration

The host reads the same keys as an app ([authz config](../authz/04-host-boot-and-configuration.md#configuration)). The keys a test usually sets:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.permissions` | object | none | permission name → `PermissionDef` options (`{}` is enough) | Permissions the checks may name. |
| `authz.models` | string[] | none | registered model names | The models root activates; `testHost.activate` appends to it. |
| `authz.combine.default` | object | none | `{ algorithm, models }` | Routes every type to the listed model names. |
| `authz.cache.maxEntries` | number | `10000` | `0` turns L2 off | Set `0` when a test changes votes without a model version change. |

`TestConfiguration.set(path, value)` takes a dotted string or a segment array. Write permission names with dots (`user.metadata:read`) as segment arrays.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Test configuration | `Configuration`, registered in root by `installHost()` | `TestConfiguration` | `configurationOf(values)` for schema tests ([Test host](05-test-host-and-di.md)) | `testHost.config()` returns the instance; set keys before the root service boots. |
| Model under the check | `AuthorizationModel`, registered in root and listed in `authz.models` by `testHost.activate` | none | `StaticModel`, `FakeRbacModel`, `FakeTupleModel`, a real `RbacModel` | Register before `service('root')`; after a change call `testHost.resetRoot()`. |
| Decision audit | `DecisionAudit` | `LogDecisionAudit` (logs every deny) | `RecordingAudit` | `testHost.registerInRoot(DecisionAudit, testHost.instance(new RecordingAudit()))`. |

## Granting permissions

| Model | Grant | Change mid-test |
| --- | --- | --- |
| `FakeRbacModel` | `roles: { approver: ['invoice:*'] }` and `assignments: [{ subject, role, scope? }]`; `scope` defaults to `GLOBAL`. A grant may be `{ permission, relation }` to permit only where the relation holds. | `assign(a)` and `revoke(a)` bump `version()`, so cached decisions drop. |
| `StaticModel` | A vote table: `{ 'invoice:approve': { permitWhen: TRUE } }`, keyed `'<permission>@<resourceKey>'`, `'<permission>@<type>'`, `'<permission>'` or `'*'`. A function `(req, ctx) => vote` also works. | `respond(votes)` replaces the script but keeps the version; call `bump()` too, or set `authz.cache.maxEntries: 0`. |
| `RbacModel` (authz-rbac) | Real roles and a `MemoryAssignmentStore` | `store.add(...)`, then invalidate as the model requires |

[Fake models](03-fake-models.md) has every option.

## Important behaviour

- The root service boots once. A model registered after `service('root')` is not routed until `testHost.resetRoot()` and a new `service('root')`.
- `StaticModel.respond()` does not change `version()`. With L2 on, a repeated check returns the old decision until `bump()`.
- The default `LogDecisionAudit` logs one line per deny (`authz audit deny principal=... reason=no_access`). Register a `RecordingAudit` to assert on denials instead.
- `uninstallHost()` uncaches only the root types it found uncached at install. It never calls `DI.clearCache()`.
- Load the host from `@spinajs/authz` (the built lib), never from authz `src`: two copies register two `DefaultAuthzService` classes in one DI root.

## Best practices

- Build principals with [the builders](02-principals.md) (`userPrincipal('alice')`): they are frozen as the engine expects.
- Call `testHost.resetHost()` in `afterEach` when tests register different models; each test then boots its own root.
- Keep `registerInRoot`'s returned function when a test removes one registration early; `resetHost()` removes the rest.
- To test a list (`.accessible()`), use a model with list plans: `ListStaticModel`, or the real RBAC model ([authz-orm access lists](../authz-orm/01-access-lists.md)).

## Patterns and antipatterns

```ts
// Don't: DI.clearCache() wipes entries other packages write at import time (http's error map), which nothing rebuilds
afterEach(() => DI.clearCache());

// Do
afterEach(() => testHost.resetHost());
after(() => testHost.uninstallHost());
```

```ts
// Don't: the decision of the first check stays in L2, the second check still permits
model.respond({});

// Do
model.respond({}).bump();
```

## Examples

### Allow invoice approval only for approvers

```ts sample
import { DI } from '@spinajs/di';
import { FakeRbacModel, testHost, userPrincipal } from '@spinajs/authz-testing';

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const invoice = { type: 'invoice', id: '7' };

export async function approvalRules(): Promise<void> {
  const config = await testHost.installHost();
  try {
    config.set(['authz', 'permissions'], { 'invoice:approve': {}, 'invoice:read': {} });
    config.set(['authz', 'combine'], { default: { algorithm: 'deny-overrides', models: ['rbac'] } });

    const rbac = new FakeRbacModel({ roles: { approver: ['invoice:*'] }, assignments: [{ subject: alice, role: 'approver' }] });
    testHost.activate(DI.RootContainer, 'root', rbac);

    const authz = await (await testHost.domains()).service('root');
    console.log(await authz.can(alice, 'invoice:approve', invoice)); // true
    console.log(await authz.can(bob, 'invoice:approve', invoice)); // false, reason no_access

    // Grant bob the role on this invoice only.
    rbac.assign({ subject: bob, role: 'approver', scope: invoice });
    console.log(await authz.can(bob, 'invoice:approve', invoice)); // true
    console.log(await authz.can(bob, 'invoice:approve', { type: 'invoice', id: '8' })); // false
  } finally {
    await testHost.uninstallHost();
  }
}
```

### Assert that a denial is audited

```ts sample
import { DI } from '@spinajs/di';
import { AccessDenied, DecisionAudit } from '@spinajs/authz';
import { RecordingAudit, StaticModel, testHost, userPrincipal } from '@spinajs/authz-testing';

export async function deniedPayoutIsAudited(): Promise<void> {
  const config = await testHost.installHost();
  try {
    config.set(['authz', 'permissions'], { 'payout:create': {} });
    config.set(['authz', 'combine'], { default: { algorithm: 'deny-overrides', models: ['payouts'] } });

    const audit = new RecordingAudit();
    testHost.activate(DI.RootContainer, 'root', new StaticModel({ name: 'payouts', votes: {} }));
    testHost.registerInRoot(DecisionAudit, testHost.instance(audit));

    const authz = await (await testHost.domains()).service('root');
    try {
      await authz.assert(userPrincipal('mallory'), 'payout:create');
    } catch (e) {
      console.log(e instanceof AccessDenied); // true
    }
    console.log(audit.of('deny').length); // 1
  } finally {
    await testHost.uninstallHost();
  }
}
```

## Related

- [Test host and DI isolation](05-test-host-and-di.md): every `testHost` function.
- [Fake models](03-fake-models.md): the vote table, list plans and call records.
- [Behaviour harnesses](10-behaviour-harnesses.md): `hostHarness` does the same boot per case, in a child domain.
- [`@spinajs/authz` service](../authz/03-checking-permissions.md): `can`, `assert`, `check` and the rest.
