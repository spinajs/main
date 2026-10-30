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
| `manifest` | A `Manifest` or the path of one. Default `app.manifest.json` in the working directory. |
| `mode` | `throw` (default): a body that breaks its schema answers 500. `log`: the response is sent and the violation recorded. |

## What is checked

- A 2xx JSON body against the schema of its route (`returnType.schema`), after a JSON round trip, so a `Date` is compared as the string the client receives.
- A problem document (`application/problem+json`) against `PROBLEM_DETAILS_SCHEMA`, on any route and on 404s no route answers. A broken problem is recorded, never turned into another response.
- Nothing else: HTML, files, empty bodies, routes or controllers the manifest does not know, and routes without a derived schema.

Schemas reach Ajv without their `x-*` keys. An `x-explicit: 'partial'` entry is documentation only (the runtime `@Schema` validates), so it accepts anything. A model from a dependency derives to an open object and accepts any object.

## Failing the test

Violations are logged at `error` and collected in `app.contractViolations`. `dispose()` rejects when the list is not empty, naming each route, status and Ajv error; `disposeTestApps()` rethrows it.

## Harnesses that do not use createTestApp

```ts
const contract = await installContractTesting({ manifest: await manifestOfFragments([fragmentFile]) });
contract.register(DI.RootContainer); // before the app resolves anything
contract.enable(configuration); // after Configuration resolved
// ... run requests ...
contract.assertClean(); // after the app stopped
```

`manifestOfFragments` merges built `lib/manifest.fragment.json` files, for packages that have no `app.manifest.json`.
