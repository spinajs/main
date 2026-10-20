# `@spinajs/authz-testing`

The test kit of SpinaJS authorization: principal builders, fake models, adapters and resolvers, an in-memory test host, conformance suites for the models and adapters you write, and the behaviour fixtures B01-B46 that every authz package runs.

It does **not** ship a real RBAC or ABAC model. A package plugs its own model into a harness ([authz-rbac](../authz-rbac/README.md), [authz-abac](../authz-abac/README.md)). The suites register mocha tests through the mocha globals, so call them at the top level of a mocha test file.

## Install

```sh
npm install --save-dev @spinajs/authz-testing
```

It depends on `@spinajs/authz`, `@spinajs/configuration`, `@spinajs/di` and `fast-check`. It imports no lane package (`authz-rbac`, `authz-orm`, `authz-http`).

## Features

| Feature | What it does |
| --- | --- |
| [Permission checks in app tests](01-permission-checks-in-app-tests.md) | Boots a real `AuthzService` over in-memory config, grants permissions with a fake model, checks them. |
| [Principal builders](02-principals.md) | `userPrincipal`, `agentPrincipal`, `linkPrincipal`, … build frozen principals with ceilings, companions and authn facts. |
| [Fake models](03-fake-models.md) | `StaticModel`, `ListStaticModel`, `FakeRbacModel` and `FakeTupleModel`: scripted or tiny models that record their calls. |
| [Fake adapters, contexts and recorders](04-fake-adapters-and-contexts.md) | `FakeAdapter`, `FakeScopeResolver`, `fakeEvaluationContext`, `RecordingAudit`, `ManualClock` and the other stand-ins. |
| [Test host and DI isolation](05-test-host-and-di.md) | `testHost`, `scopedContainer`, `uncacheOwned` and the configuration helpers that keep tests from leaking DI state. |
| [Model conformance](06-model-conformance.md) | `runModelConformance` checks any `AuthorizationModel`, and the store behind it, against the model contract. |
| [Adapter conformance](07-adapter-conformance.md) | `runAdapterConformance` checks any `ResourceAdapter`, including that its query side selects what the residual says. |
| [Client access conformance](08-client-access-conformance.md) | `runClientAccessConformance` drives a running app's `/user/access/checks`, `$access`, epoch and push events. |
| [Behaviour fixtures](09-behaviour-fixtures.md) | `runBehaviour` runs the rules B01-B46 against a harness; what each rule covers and which parts it has. |
| [Behaviour harnesses](10-behaviour-harnesses.md) | `BehaviourHarness`, `hostHarness` and `instantiateWorld`: plug your system into the fixtures. |
| [Writing fixtures](11-writing-fixtures.md) | `fixtureDsl`, worlds, steps and expectations; lane-local fixture parts. |
| [Reference residual evaluator](12-filter-oracle.md) | `evaluateFilter`: the kit's oracle for what a residual selects, in SQL three-valued logic. |
| [Arbitraries](13-arbitraries.md) | The `arb` namespace of fast-check generators and `accessWorld` for property tests. |

## Quick start

```ts sample
import { FakeRbacModel, fakeEvaluationContext, userPrincipal } from '@spinajs/authz-testing';

const alice = userPrincipal('alice');
const rbac = new FakeRbacModel({
  roles: { approver: ['invoice:approve'] },
  assignments: [{ subject: alice, role: 'approver' }],
});

export async function aliceMayApprove(): Promise<boolean> {
  const ctx = fakeEvaluationContext({ permissions: ['invoice:approve'] });
  const vote = await rbac.evaluate({ principal: alice, permission: 'invoice:approve', resource: { type: 'invoice', id: '7' } }, ctx);
  return vote.permitWhen.op === 'true';
}
```

To check through the real engine and its combining, caching and audit, see [Permission checks in app tests](01-permission-checks-in-app-tests.md).

## Related packages

- [`@spinajs/authz`](../authz/README.md): the engine, the model and adapter contracts the suites check, and the [testing kit overview](../authz-testing/README.md).
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): runs `runModelConformance` over `RbacModel` and most RBAC behaviour parts through its own harnesses.
- [`@spinajs/authz-abac`](../authz-abac/README.md): runs `runModelConformance` over `AbacModel` and the `abac` behaviour parts.
- [`@spinajs/authz-orm`](../authz-orm/README.md): its tests boot the host with `testHost`; the `orm` and `accessible` behaviour parts hold `.accessible()` to the B06 and B20 rules.
- [`packages/authz-testing/README.md`](../../packages/authz-testing/README.md): the binding readings of the design (D-F5-1 to D-F5-11) that fixture notes cite.
