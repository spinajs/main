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
- Apply `ctx.config`: `authn.*` keys mean what the `authn.*` config means
  (`docs/plans/2026-10-01-authz-v3-design.md` §22.5); secrets are the
  values themselves; `throttle` merges over `DEFAULT_THROTTLE`. Without
  overrides, run those defaults. A config you cannot apply: throw
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
- A requested rule whose cases are not written yet (listed in
  `PENDING_TRANSCRIPTION`) shows one case `<id> [pending: not transcribed
  yet (PENDING_TRANSCRIPTION)]`; when you claim the rule or one of its
  facets, that case fails instead. Nothing is silent.
- `timeoutMs` raises every case to at least that value (timing cases set
  600 s themselves; lanes with slow hashing raise them here, see
  `timingTimeoutMs`).

### Time rules

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

### Fakes for the `service` port

Lanes that do not own `AuthnService` (N3, N6, N7, N10) build the `service`
port from kit fakes until N1 lands: `FakeAuthnService` (the login, MFA and
re-authentication flow over the contracts) with `FakeBackoffThrottle`,
`MemorySessionIssuer`, `FakeIdentityStore`, `MemoryLinkStore`,
`EnrolledMfaPolicy`, `RecordingEventSink`, `RecordingPrincipalFactory` and
the lane's own strategy. `throttleParams(ctx.config)` gives the params to
build the throttle with and to report in the `throttle` port. These are
fakes, not N1's implementation.

### C8 golden tickets

`loadC8Fixtures(dir?)` returns the canvas C8 test keys and golden JWS tickets
(`{ keys, tickets }`: 3 valid, 23 invalid with their `error` code). It
checks each file against the sha256 in `C8_SOURCE` and throws on a mismatch.
The files are `fixtures/c8/keys.json` and `tickets.json` (also importable as
`@spinajs/authn-testing/fixtures/c8/*`); `fixtures/c8/SOURCE.md` records the
canvas commit, hashes and how to refresh. The keys are public test keys.

### Lane → facets

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

Some of these are not yet in the lane's plan list (see below). Ports per
facet: the `needs` of each case in `src/behaviour/A*.spec.ts`. Shared names
and helpers for spec files: `src/behaviour/steps.ts`.

## Known gaps for lanes

Open hand-offs (no frozen contract changes; the owning lane decides):

| Topic | Gap | Who |
|---|---|---|
| Plan lists | A08/http has no lane (add to N8a), A08/lifecycle none (C1); A20/core missing from N1; A15/core missing from N8a; A05 missing from N8a; A13/local missing from N3 | controller |
| Pepper versions | "a hash under an older pepper version is rehashed" needs the older secret; the kit tests only unpeppered → peppered and other argon2 parameters | N3, N1: add `pepper.previous` or drop the clause |
| A25 credential admin | who enforces `users:credentials` and the target rule; the kit uses `ActorsPort.admin({ credentialsRight })` and a separate `targetGuard` port | N8b, C3 |
| A17 formats | the key proof signing input and an assertion's `iss` are not frozen; lanes supply `KeyProofPort` and `AssertionPort` | N7: document both for CLI clients |
| A18 | the kit signs with RFC 9421 label `sig1` and no `alg` parameter | N7 must accept it |
| A12 prefixes | the reserved metadata prefixes (`2fa:`, `user:2fa:`, `user:pwd_reset:`, `user:pwd:`, `user:login:`, `user:ban:`, `user:invite:`) come from plan SEC1, not a contract | SEC1, C2: confirm |
| Time in stores | `SessionIssuer`, `SecretStore`, `MfaStep` and `AuthnThrottle.succeed` take no `ctx`: compute "now" in Node and pass it to SQL, never SQL `now()` | N2, N4 |
| A13 inline re-auth | the re-auth field of `POST /user/tokens` is not frozen; supply `routes.tokenCreate({ reauthPassword })` | N8b |
| A16 JIT | the kit sets only `authn.linking.jit` for JWT subjects; `authn.jwt.issuers` has no per-issuer switch | N6: confirm |
| Two `bearer` strategies | token and JWT strategies share kind `bearer`; A14/A15 configs list only the token strategy, A16 only the JWT one | N1, N6: first-listed-wins or unique kinds |
| `impersonation.requireMfa` | no defined meaning; every A20 case pins it true and uses an aal2 admin session | N1, N8a |
| A24 secret-storing step | how boot learns that an MFA step stores secrets (A24 `mfaStep: 'secret-storing'`) | N1 |
| A25 ports | needs `actors.admin`, `targetGuard`, `tokens` and `outbox` in the harness; who enforces the target rule is design §12 #5 | N8b |
| B5 http paths | A27, A30, A32 http rows need route builders `passwordChange`, `passwordReset`, `login`, and an `/auth/oidc/:provider[/callback]` pair at those exact paths | N8b, N10 |
| A27 JIT default | "unlinked subject fails with JIT off" sets no config (§22.5 default is off); a lane whose default is on fails it | N10 |
| A31/config | `checkConfig` topic `cors`, level `warning`; the reference boot has no `checkConfig`, so A31/config first runs in N8a | N8a |
| A32 carried rows | row 4 redeems `{ type: 'user', id: uuid }`: the secret store must key carried rows by `user:<uuid>` | N4 |

Per lane, today:

| Lane | Runs today | Gaps |
|---|---|---|
| N1 | A01, A02, A05, A06, A09, A13, A19, A21, A23, A24 | add A20; `BootPort` needs `start` and `checkConfig` |
| N2 | A07/A08/A09 store via `runSessionIssuerConformance` | none |
| N3 | A02/local, A03, A04, A11/local, A30/local (service from the fakes above) | A13/local not in its list |
| N4 | A05/A06 store, A11/store, A19/store wrappers; `a32Fixtures`, A32/migration | none |
| N5 | A10/step, A10/totp | none |
| N6 | A14/token, A15/token, A16/jwt (service from the fakes above), strategy conformance | two `bearer` strategies; JWT JIT switch |
| N7 | A17/keys, A17/jws, A17/core, A18/core (service and throttle from the fakes above), strategy conformance, `loadC8Fixtures` (C8 golden tickets) | proof and `iss` formats; `sig1` |
| N8a | A02, A07, A09 (the force row needs `routes.mfaEnrol`), A20/http, A22, A23, A26, A31 | add A05, A08, A15; a test-only probe route answering `ProbeBody` (`principal`, `clientIp`, `hits`) after all middlewares |
| N8b | A10, A11, A13, A14, A17 http/core facets, A25, A30/http, A32/http | A25 enforcement |
| N10 | A02/external (service from the fakes above), A19/oidc, A27 | none |
| SEC1 | A12/api | the "red on the 2.x code" run stays in the lane; prefix list to confirm |

All lanes: follow the time rules above; never `DI.clearCache()`; list
per-request 401 body keys in `volatileBodyFields`; claim the facets you own.
