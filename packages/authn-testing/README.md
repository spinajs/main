# `@spinajs/authn-testing`

Test kit for SpinaJS authentication: fakes, conformance suites, behaviour fixtures.

## Running the behaviour rules in a lane

```ts
import { runAuthnBehaviour, UnsupportedConfig } from '@spinajs/authn-testing';

runAuthnBehaviour(['A02', 'A03', 'A04', 'A11', 'A30'], localHarness, {
  claim: ['A02/local', 'A03/argon2', 'A04/local', 'A11/local', 'A30/local'],
});
```

Call it at the top level of a mocha spec file (`mocha` is a peer dependency;
the kit uses the `describe`, `it` and `after` globals).

### Harness factory

`(ctx: HarnessContext) => Harness | Promise<Harness>`, called once per case.

- `ctx`: `rule`, `facet`, `caseName`, `clock` (a `FakeClock`), `config` (the
  case's `ConfigOverrides`, `{}` when none).
- Apply `ctx.config` (`authn.*` semantics of design §22.5; secrets are the
  values themselves; `throttle` merges over `DEFAULT_THROTTLE`). Without
  overrides, run the §22.5 defaults. A config you cannot apply: throw
  `new UnsupportedConfig(keys)`.
- Return only the ports you have; every port shares one container (the
  `seed` users are the ones `service` authenticates, `events` sees what
  `service` publishes, and so on).
- `dispose()` releases everything the factory made. Fresh state per case
  comes from `DI.uncache(<your types>)`; never `DI.clearCache()`, and not
  `DI.child()` alone (a root singleton resolved through a child stays in
  root).
- HTTP: implement `HttpPort` over supertest or express yourself; keep
  request ids and timestamps out of 401 bodies or list them in
  `volatileBodyFields`. Route builders (`routes.login`, …) are optional;
  a case needing one you lack is pending.

### Facets, claims, pending

- Every case has a facet `<rule>/<kind>` (e.g. `A07/store`) and `needs`
  (ports, `fakeDate`, `mfa.recovery`, `http.routes.<name>`).
- A case whose needs your harness lacks (or whose config throws
  `UnsupportedConfig`) is **pending**: its title gets
  ` [pending: missing <needs>]`, and one line per pending case is printed
  after the suite (`authn-testing pending: <case> → <needs>`;
  `AUTHN_TESTING_SUMMARY=off` silences it). Never a silent pass.
- `claim`: facets (or whole rule ids) your lane owns. A claimed case with a
  missing need or an unsupported config **fails**, naming what is missing.
- `facets`: register only these facets. Unknown ids, A28/A29, duplicates
  and claims/facets outside the given ids throw at registration.
- `timeoutMs` raises every case to at least that value (timing cases set
  600 s themselves; lanes with slow hashing raise them here, see
  `timingTimeoutMs`).

### Time rules (design §3.3)

Each case installs a `FakeClock` that fakes `Date` only (timers,
`performance.now()` and `process.hrtime` stay real). Code under test must:

1. take "now" from `ctx.now` wherever a contract passes `ctx`;
2. elsewhere read `Date` (directly or through luxon) at call time; never
   let SQL compute "now" for secret, session or throttle decisions: pass
   the Node time as a parameter;
3. never capture `Date` at module load in code that decides expiry;
4. accept that pool idle timers on `Date.now()` stop aging while frozen;
5. bound retry loops by count, not by elapsed time.

`fakeDate: false` turns the clock off; cases needing `fakeDate` are then
pending (or fail when claimed).

### Store and strategy conformance

`runSessionIssuerConformance`, `runSecretStoreConformance`,
`runLinkStoreConformance`, `runThrottleConformance` run the store facets
(A07–A09, A11, A19, A05–A06) claimed. `runStrategyConformance(subjectFactory,
{ title })` checks one `AuthenticationStrategy`; pass a `title`, the default
names no strategy. `runIdentityStoreConformance` covers `IdentityStore`.

### Lane → facets (design §4.4)

| Lane | Facets it claims |
|---|---|
| N1 | A01/core, A02/core, A02/external, A05/store, A05/core, A06/store, A06/core, A09/core, A13/core, A19/core, A20/core, A21/core, A23/core, A24/boot |
| N2 | A07/store, A08/store, A09/store |
| N3 | A02/local, A03/argon2, A04/local, A11/local, A30/local (A13/local first runs in N8b) |
| N4 | A05/store, A06/store, A11/store, A19/store, A32/migration |
| N5 | A10/step, A10/totp |
| N6 | A14/token, A15/token, A16/jwt |
| N7 | A17/keys, A17/jws, A17/core, A18/core |
| N8a | A02/core, A02/http, A05/core, A05/http, A07/http, A08/http, A09/http, A15/core, A20/http, A22/http, A23/http, A26/http, A31/http, A31/config |
| N8b | A10/core, A10/http, A11/local, A11/http, A13/local, A13/http, A14/http, A17/core, A17/http, A25/http, A30/local, A30/http, A32/http |
| N10 | A02/external, A19/oidc, A27/oidc |
| C1 | A08/lifecycle, A12/identity, A12/flow |
| C2, SEC1 | A12/api |
| C3 | A26/http |

Some of these are not yet in the lane's plan list (design §4.4 `*`,
§12). Ports per facet: the `needs` of each case in `src/behaviour/A*.spec.ts`.
Shared names and helpers for spec files: `src/behaviour/steps.ts`.
