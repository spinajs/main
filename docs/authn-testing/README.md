# `@spinajs/authn-testing`

The test kit for `@spinajs/authn`. It ships in-memory fakes for the authn contracts, conformance suites for your own strategies and stores, and the behaviour rules A01 to A31 that every SpinaJS authn package runs against itself.

It does **not** boot an app, start an HTTP server or open a database: your test builds those and hands them to the kit through a harness. The fakes are test doubles, not production implementations: `FakeAuthnService` is not the `AuthnService` of `@spinajs/authn`. The suites register mocha tests, so they run under mocha only (peer dependency `mocha >= 10`).

## Install

```sh
npm install --save-dev @spinajs/authn-testing mocha
```

The package depends on `@spinajs/authn` and imports its contracts from `@spinajs/authn/contracts`.

## Features

| Feature | What it does |
| --- | --- |
| [Fakes](01-fakes.md) | In-memory implementations of the authn contracts: clock, identities, passwords, secrets, sessions, MFA, links, throttles, events, hooks |
| [Fake authentication service](02-fake-authn-service.md) | `FakeAuthnService`: the login, MFA and re-authentication flow over the fakes, to log a test user in |
| [Conformance suites](03-conformance-suites.md) | `runStrategyConformance`, `runIdentityStoreConformance` and the store wrappers: check your own strategy or store against the contract |
| [Behaviour runner](04-behaviour-runner.md) | `runAuthnBehaviour`: runs the behaviour rules against a harness you build, with facets, claims, pending cases and a fake `Date` |
| [Behaviour rules](05-behaviour-rules.md) | The catalogue of rules A01 to A31: what each one checks, its facets and the ports it needs |
| [HTTP port](06-http-port.md) | `HttpPort`, the route builders, the probe route, the cookie jar and the request helpers for the HTTP facets |
| [Test helpers](07-test-helpers.md) | Kit users and assertions, timing comparison, parallel bursts, backoff walks, keys, JWS, HTTP signatures, TOTP, a JWKS server |
| [C8 golden tickets](08-c8-fixtures.md) | `loadC8Fixtures`: vendored Ed25519 test keys and JWS tickets with their expected error codes |

## Which part do you need

| You want to | Use |
| --- | --- |
| Test app code that needs a logged-in user, without a database | [Fakes](01-fakes.md) and [`FakeAuthnService`](02-fake-authn-service.md) |
| Ship your own `AuthenticationStrategy` | [`runStrategyConformance`](03-conformance-suites.md#strategy-conformance) |
| Ship your own `IdentityStore` and `PasswordCredentialStore` | [`runIdentityStoreConformance`](03-conformance-suites.md#identity-store-conformance) |
| Ship your own session issuer, secret store, link store or throttle | [The store wrappers](03-conformance-suites.md#store-conformance-wrappers) |
| Check a whole authn stack (service, HTTP layer, boot) against the security rules | [`runAuthnBehaviour`](04-behaviour-runner.md) |

## Quick start

Log a test user in through the fakes and get the `Principal` your code receives.

```ts sample
import 'mocha';
import assert from 'node:assert/strict';
import {
  ALICE,
  DEFAULT_THROTTLE,
  EnrolledMfaPolicy,
  FakeAuthnService,
  FakeBackoffThrottle,
  FakeClock,
  FakeIdentityStore,
  FakeMfaStep,
  FakeStrategy,
  MemoryLinkStore,
  MemoryPasswordCredentialStore,
  MemorySessionIssuer,
  RecordingEventSink,
  RecordingPrincipalFactory,
  expectSuccess,
  fakeSeedPort,
  pw,
} from '@spinajs/authn-testing';

describe('order history', () => {
  it('belongs to the logged-in user', async () => {
    const clock = new FakeClock();
    const identities = new FakeIdentityStore();
    const passwords = new MemoryPasswordCredentialStore();
    const step = new FakeMfaStep();
    const service = new FakeAuthnService({
      strategies: [FakeStrategy.password({ identities, passwords })],
      throttle: new FakeBackoffThrottle(DEFAULT_THROTTLE),
      identities,
      links: new MemoryLinkStore(),
      linking: { jit: false, byVerifiedEmail: false },
      policy: new EnrolledMfaPolicy([step]),
      steps: [step],
      sessions: new MemorySessionIssuer(),
      sinks: [new RecordingEventSink()],
      principals: new RecordingPrincipalFactory(),
    });

    const alice = await fakeSeedPort(identities, passwords).user({ login: ALICE.login, password: ALICE.password });
    const result = await service.authenticate(pw(ALICE.login, ALICE.password), clock.ctx());
    expectSuccess(result);

    const principal = await service.principalOf(result);
    assert.equal(principal.id, alice.id);
    assert.equal(principal.authn?.assurance, 'aal1');
  });
});
```

## Related packages

- [`@spinajs/authn`](../authn/README.md): the contracts every fake implements and every suite checks; read it for what a strategy, store or session must do.
- [`@spinajs/authn-orm`](../authn-orm/README.md): its SQL throttle, secret store and link store run the store wrappers of this kit in their own tests.
- [`@spinajs/authz-testing`](../authz-testing/README.md): the matching kit for authorization (fake models, conformance suites, behaviour fixtures).
- `packages/authn-testing/README.md` in the repository: which SpinaJS package claims which facet, and the open hand-offs between them.
