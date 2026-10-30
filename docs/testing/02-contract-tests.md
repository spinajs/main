# Contract tests

`createTestApp({ contractTesting })` checks every JSON response of the app against the schemas the compiler derived from your handlers' return types. A handler that returns a body its declared type does not describe fails the test that called it.

```ts
const app = await createTestApp({
  configuration: AppConfiguration,
  contractTesting: { manifest: 'app.manifest.json', mode: 'throw' },
  resolve: [Controllers],
});
```

| Option | Meaning |
| --- | --- |
| `manifest` | A `Manifest` or the path of one. Default, per app container: the manifest the app registered (its configuration source, or `withManifest`), else the file of its effective `system.manifest.path`, else `app.manifest.json` in the working directory. It is read when the app's configuration has resolved, so a missing file fails the boot. |
| `mode` | `throw` (default): a body that breaks its schema answers 500. `log`: the response is sent and the violation recorded. |

## What is checked

- A JSON body against the schema its route declares for the status: `returnType.schema` for 2xx, the `doc.responses` entry of that status otherwise. The body goes through a JSON round trip first, so a `Date` is compared as the string the client receives. A body that cannot be serialized (a cycle, a `BigInt`) is recorded as a violation.
- A problem document (`application/problem+json`) against `PROBLEM_DETAILS_SCHEMA`, on any route and on 404s no route answers. A broken problem is recorded, never turned into another response.
- Nothing else. Only `res.json` is observed, so files, streams, `sendFile`, HTML, empty bodies (204, redirects), routes or controllers the manifest does not know, and routes or statuses without a derived schema are not checked. A clean run means every JSON body that had a schema matched it, not that every response was verified.

Schemas reach Ajv without their `x-*` keys. An `x-explicit: 'partial'` entry is documentation only (the runtime `@Schema` validates), so it accepts anything. A model from a dependency derives to an open object and accepts any object.

## Failing the test

Violations are logged at `error` and collected in `app.contractViolations`. `dispose()` rejects when the list is not empty, naming each route, status and Ajv error; `disposeTestApps()` rethrows it.

## Harnesses that do not use createTestApp

```ts
const contract = await installContractTesting({ manifest: await manifestOfFragments([fragmentFile]) });
contract.register(DI.RootContainer); // before the app resolves anything; the check reads the container that serves the request
contract.enable(configuration); // after Configuration resolved
// ... run requests ...
contract.unregister(); // removes the validator and the log again
contract.assertClean(); // after the app stopped; `finishContractTesting(teardown, contract)` does all three even when teardown throws
```

`contract.checkedRoutes` is the number of routes that have a response schema; assert it in a suite so a compiler regression that drops schemas cannot pass vacuously.

`manifestOfFragments` merges built `lib/manifest.fragment.json` files, for packages that have no `app.manifest.json`.
