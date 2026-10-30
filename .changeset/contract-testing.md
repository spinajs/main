---
"@spinajs/http": minor
"@spinajs/testing": minor
---

Contract tests mode. With `http.contractTesting.enabled` and a registered `CONTRACT_VALIDATOR`, `@spinajs/http` checks every JSON response: a 2xx body against the schema of its route, a problem document against `PROBLEM_DETAILS_SCHEMA`. A body that breaks its schema answers 500 (`mode: 'throw'`) or is only logged (`mode: 'log'`), and is recorded in `CONTRACT_VIOLATIONS`. `createTestApp({ contractTesting })` builds the validator from the manifest's derived response schemas (`x-*` keys stripped, `x-explicit: 'partial'` entries accepted as documentation) and `dispose()` rejects when a response broke its contract. `installContractTesting` and `manifestOfFragments` serve harnesses that boot without `createTestApp`.
