# Conformance suites

Mocha suites that check your own implementation of an authn contract: an `AuthenticationStrategy`, an `IdentityStore` with its `PasswordCredentialStore`, a `SessionIssuer`, a `SecretStore`, an `IdentityLinkStore` or an `AuthnThrottle`. Run them in the test suite of the package that ships the implementation.

| Suite | Checks | Your factory returns |
| --- | --- | --- |
| `runStrategyConformance` | One `AuthenticationStrategy` | `StrategySubject` |
| `runIdentityStoreConformance` | `IdentityStore` and `PasswordCredentialStore` | `IdentitySubject` |
| `runSessionIssuerConformance` | `SessionIssuer`: rules A07, A08, A09 (store facets) | `Harness` with `sessions`, `sessionStorage`, `seed` |
| `runSecretStoreConformance` | `SecretStore`: rule A11 (store facet) | `Harness` with `secrets`, `secretStorage`, `seed` |
| `runLinkStoreConformance` | `IdentityLinkStore`: rule A19 (store facet) | `Harness` with `links`, `seed` |
| `runThrottleConformance` | `AuthnThrottle`: rules A05, A06 (store facets) | `Harness` with `throttle` |

## How it works

1. Call the suite at the top level of a spec file, or inside a `describe`. It registers mocha tests through the `describe`, `it` and `after` globals.
2. For each case the suite starts a fresh `FakeClock`, installed on `Date` unless you pass `fakeDate: false`.
3. It calls your factory with `{ clock }` (strategy, identity) or a `HarnessContext` (store wrappers), and runs the case against what it returns.
4. It calls `dispose()` on the subject or harness once, on every exit path, bounded to 5 s, then uninstalls the clock. A dispose error fails the case; it never hides the case's own error.
5. A case that does not apply to your subject is marked pending in its title and in a summary printed after the suite. It never passes silently.

The store wrappers run the [behaviour rules](05-behaviour-rules.md) of their facets with every facet claimed: a port your harness lacks, or config it throws `UnsupportedConfig` for, **fails** the case instead of leaving it pending.

## Strategy conformance

`runStrategyConformance(factory, options?)` registers nine cases, each titled `conformance: <case>`:

| Case | Passes when |
| --- | --- |
| name, kinds and interactive are declared | `name` and every kind are non-empty strings, `kinds` is non-empty, `interactive` is a boolean |
| verify accepts valid credentials | `valid()` gives `ok: true` with exactly one of `identity` and `external`, and a non-empty `method` |
| verify answers invalid and unknown credentials alike without throwing | `invalid()` gives exactly `{ ok: false, reason }` with a known reason, and `unknown()` gives the same outcome |
| an undeclared kind is unsupported_credentials | Kind `authn-testing-undeclared` gives `{ ok: false, reason: 'unsupported_credentials' }` |
| verify has no session or event side effects | Session count and event list are unchanged after verifying valid, invalid and unknown credentials |
| throttle keys are stable | Two `throttleKeys()` calls with the same credentials agree |
| throttle key values carry no secret | No key value contains a string from `secretsOf()` that is 8 characters or longer |
| a non-interactive strategy returns account and account-ip keys from a stable id | Both key kinds are present, and `sameId()` gives the same keys; pending for interactive strategies |
| A02 verify takes the same time for unknown accounts | The median times of `invalid()` and `unknown()` agree (see [timing](07-test-helpers.md#timing-comparison)); pending without `unknown()` or with `timing: false` |

Each case passes the strategy a context from `clock.ctx()` with `purpose` `'login'` for an interactive strategy and `'request'` otherwise.

### `StrategySubject`

| Member | Required | Meaning |
| --- | --- | --- |
| `strategy` | yes | The strategy under test |
| `valid()` | yes | Fresh credentials it accepts; a new `jti` or nonce on each call where the strategy needs one |
| `invalid()` | yes | A known account with a wrong secret |
| `unknown()` | no | An account that does not exist; leave it out for strategies without an account lookup (OIDC, JWT) |
| `sameId()` | no | Other credentials with the same stable id as `valid()`; non-interactive strategies |
| `secretsOf(c)` | yes | The secret parts of `c` (password, token, JWS, signature) that must never appear in a key |
| `sessions` | yes | `{ count(): Promise<number> }` over the sessions in the strategy's container |
| `events` | yes | An `EventsPort` (`all()`, `clear()`), for example a `RecordingEventSink` |
| `dispose()` | no | Releases what the factory made |

### Options

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `title` | `string` | `'strategy conformance'` | any | Title of the outer `describe`; pass one, since the default names no strategy |
| `timing` | `TimingOptions \| false` | timing defaults | `false` or `{ runs, warmup, tolerance, noiseFloorMs, retries }` | Options of the timing case; `false` makes it pending |
| `fakeDate` | `boolean` | `true` | `true`, `false` | Install the case clock on `Date` |
| `timeoutMs` | `number` | `600000` | milliseconds | Timeout of the timing case only; other cases use 10 s |

## Identity store conformance

`runIdentityStoreConformance(factory, { title? })` registers 13 cases titled `identity store: <case>`. The clock is always installed.

| Area | Cases |
| --- | --- |
| Lookup | Finds by login and by email; an unknown login is `null`; `display` gives the email |
| Status | `status` reflects `active: false`, `banned`, `deleted` and `invitePending`, each with `exists: true` |
| Password reads and writes | No password reads `null`; a set hash reads back verbatim; an unconditional `set` answers `true` and overwrites |
| Compare-and-set | A conditional `set` writes only over the expected value; with `null` only where no password is stored; of 8 parallel conditional sets over one value exactly one writes |
| JIT | `provision` exists exactly when `jit` is `true` |

`IdentitySubject` holds `store`, `passwords`, `seed` (a `SeedPort` that writes into your stores), `jit` and an optional `dispose()`.

## Store conformance wrappers

`runSessionIssuerConformance`, `runSecretStoreConformance`, `runLinkStoreConformance` and `runThrottleConformance` take a `HarnessFactory` and `StoreConformanceOptions`: the [`RunOptions`](04-behaviour-runner.md#configuration) of the behaviour runner without `facets` and `claim`.

Apply `ctx.config` in your factory. The store cases set these keys:

| Wrapper | Ports | Config the cases set |
| --- | --- | --- |
| `runSessionIssuerConformance` | `sessions`, `sessionStorage`, `seed` | `authn.session.expiration.ttl` and `maxLifetime` (minutes), `authn.session.pendingTtlSeconds` |
| `runSecretStoreConformance` | `secrets`, `secretStorage`, `seed` | none in the store facet |
| `runLinkStoreConformance` | `links`, `seed` | none in the store facet |
| `runThrottleConformance` | `throttle` (`{ throttle, params }`) | `authn.throttle.*`; build the throttle from `throttleParams(ctx.config)` and report the same `params` |

`sessionStorage` needs `storedKeys()` (every storage key the store holds) and `seedLegacy(row)` (plant a 2.x-shaped row with a raw UUID v4 id). `secretStorage.rows()` lists the stored rows with `identity`, `purpose`, `hash`, `expiresAt` and `usedAt`. For `seed`, `fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore())` is enough when the store under test keeps no identities.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Strategy subject | none; your factory | none | none | Implement `StrategySubject` per strategy |
| Identity subject | none; your factory | none | none | Implement `IdentitySubject` over your stores |
| Store harness | none; your factory | none | none | Return the `Harness` ports listed above |
| Test API | the mocha globals | `describe`, `it`, `after` | none | Pass `bdd` to collect the cases without mocha; the kit's own tests do that |

## Important behaviour

- Every case gets a new subject. State from one case never reaches the next unless your factory shares it; clear shared tables at the start of the factory.
- The installed clock fakes `Date` only. A store that computes "now" in SQL (`now()`, `CURRENT_TIMESTAMP`) does not see it, and the expiry and backoff cases fail. Pass the Node time as a query parameter. See [time rules](04-behaviour-runner.md#time-rules).
- The timing case runs `warmup + runs` calls per side, up to `retries + 1` times. With a slow hash it can take minutes; raise `timeoutMs`, for example with `timingTimeoutMs(timingDefaults(), perCallMs)`.
- The A06 store facet makes thousands of throttle calls (one case makes 10,000 attempts). A database throttle needs a long `timeoutMs`; `@spinajs/authn-orm` passes 900 s.
- `verify` must not issue sessions or publish events: the service does that. The side-effect case fails a strategy that does.

## Best practices

- Pass `title` with the strategy or store name (and the driver name when you run one suite per database), so failures say which one broke.
- Mint every credential that has side effects (a token whose creation publishes `token.create`) in the factory, before the case body starts counting events.
- Make `invalid()` and `unknown()` cost the same lookup. When your strategy has no account apart from the secret (an API token), both may return a random secret of the right format.
- Build the throttle with `throttleParams(ctx.config)` rather than reading `ctx.config` yourself; it merges the overrides per flow and per key the way the cases expect.

## Patterns and antipatterns

```ts
// Don't: the factory ignores ctx.config, so the A06 cases that set their own backoff fail
runThrottleConformance(() => ({ throttle: { throttle: new MyThrottle(DEFAULT_THROTTLE), params: DEFAULT_THROTTLE } }));

// Do
runThrottleConformance((ctx) => {
  const params = throttleParams(ctx.config);
  return { throttle: { throttle: new MyThrottle(params), params } };
});
```

## Examples

### Check a kiosk PIN strategy

```ts sample
import 'mocha';
import { randomUUID } from 'node:crypto';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { FakeIdentityStore, MemorySessionIssuer, RecordingEventSink, runStrategyConformance } from '@spinajs/authn-testing';
import type { StrategySubject } from '@spinajs/authn-testing';

class KioskPinStrategy extends AuthenticationStrategy {
  readonly name = 'kiosk-pin';
  readonly kinds = ['kiosk-pin'];
  readonly interactive = true;

  constructor(
    private readonly identities: FakeIdentityStore,
    private readonly pins: ReadonlyMap<string, string>,
  ) {
    super();
  }

  throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    if (c.kind !== 'kiosk-pin') return [];
    const login = String((c as { login?: unknown }).login).toLowerCase();
    return [
      { kind: 'account', value: login },
      { kind: 'account-ip', value: `${login}|${ctx.ip ?? ''}` },
    ];
  }

  async verify(c: Credentials): Promise<StrategyOutcome> {
    if (c.kind !== 'kiosk-pin') return { ok: false, reason: 'unsupported_credentials' };
    const { login, pin } = c as { login?: unknown; pin?: unknown };
    const id: IdentityRef | null = await this.identities.findByLogin(String(login));
    const expected = id ? this.pins.get(id.id) : undefined;
    return id && expected === String(pin) ? { ok: true, identity: id, method: 'pin' } : { ok: false, reason: 'invalid_credentials' };
  }
}

async function kioskSubject(): Promise<StrategySubject> {
  const identities = new FakeIdentityStore();
  const clerk = identities.add({ login: 'clerk@example.test' });
  const strategy = new KioskPinStrategy(identities, new Map([[clerk.id, '48213906']]));
  const sessions = new MemorySessionIssuer();
  const pin = (login: string, value: string): Credentials => ({ kind: 'kiosk-pin', login, pin: value });

  return {
    strategy,
    valid: async () => pin('clerk@example.test', '48213906'),
    invalid: async () => pin('clerk@example.test', '00000000'),
    unknown: async () => pin(`${randomUUID()}@example.test`, '00000000'),
    secretsOf: (c) => [String((c as { pin?: unknown }).pin)],
    sessions: { count: async () => (await sessions.storage.storedKeys()).length },
    events: new RecordingEventSink(),
  };
}

runStrategyConformance(kioskSubject, { title: 'KioskPinStrategy conformance' });
```

### Check a session issuer

```ts sample
import 'mocha';
import { FakeIdentityStore, MemoryPasswordCredentialStore, MemorySessionIssuer, fakeSeedPort, runSessionIssuerConformance } from '@spinajs/authn-testing';

// Replace MemorySessionIssuer with your issuer; map the case config to its options.
runSessionIssuerConformance(
  (ctx) => {
    const s = ctx.config.authn?.session;
    const sessions = new MemorySessionIssuer({
      idleMinutes: s?.expiration?.ttl,
      absoluteMinutes: s?.expiration?.maxLifetime,
      pendingTtlSeconds: s?.pendingTtlSeconds,
    });
    return {
      sessions,
      sessionStorage: sessions.storage,
      seed: fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore()),
    };
  },
  { title: 'session issuer conformance' },
);
```

### Check a database throttle per driver

`@spinajs/authn-orm` runs the throttle facets once per database:

```ts
for (const kind of DB_KINDS) {
  describe(`DbAuthnThrottle conformance (${kind})`, function () {
    // boot the database in before(), dispose it in after()
    runThrottleConformance(
      async (ctx) => {
        await rawQuery(db.driver, 'DELETE FROM authn_throttle', [], QueryContext.Delete);
        const params = throttleParams(ctx.config);
        return { throttle: { throttle: new DbAuthnThrottle(params), params } };
      },
      { title: `throttle conformance (${kind})`, timeoutMs: 900_000 },
    );
  });
}
```

## Related

- [Behaviour runner](04-behaviour-runner.md): the store wrappers are `runAuthnBehaviour` with fixed facets and claims.
- [Behaviour rules](05-behaviour-rules.md): what the A05 to A11 and A19 store facets check.
- [`@spinajs/authn-orm`](../authn-orm/README.md): SQL stores that pass these suites.
- [`@spinajs/authn`](../authn/README.md): the contracts the suites check.
