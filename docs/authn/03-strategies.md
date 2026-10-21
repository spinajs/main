# Strategies

A strategy is one login method: a password, an API token, a signed request, an OIDC provider. It only verifies credentials. The session, the MFA step, the throttle and the audit are the job of `AuthnService`. You turn a strategy on by listing it in `authn.strategies`.

## How it works

1. A package registers its strategy class with `@Injectable(AuthenticationStrategy)`.
2. `StrategyRegistry` resolves when `AuthnService` boots. It reads `authn.strategies` and finds each entry's `service` by class name among the registered strategies of the container and its ancestors.
3. `StrategyRegistry.resolve()` checks each listed strategy (below). A bad entry fails the boot.
4. On every `authenticate` call, `StrategyRegistry.candidates(credentials)` returns the listed strategies whose `kinds` include `credentials.kind`, in list order, minus those whose optional `accepts(credentials)` declines.
5. `DefaultAuthnService` asks the candidates in order. An `unsupported_credentials` answer passes the credentials on; any other answer is final. See [Authentication flow](01-authentication-flow.md#login-authenticate).

Boot fails when:

- an entry names a service that is not registered (`ServiceNotFound`, naming the entry);
- the entry `name` differs from the strategy's own `name`;
- one service is listed under two names, or one entry is listed twice;
- the service is not a strategy (no `verify` or `throttleKeys`), its `interactive` is not a boolean, or it declares no credential kind.

## The `AuthenticationStrategy` contract

`AuthenticationStrategy` extends `AsyncService`, so a strategy may prepare itself in `resolve()`.

| Member | Meaning |
| --- | --- |
| `name` | The name in `authn.strategies` and in `AuthnFacts.strategy`, for example `local`, `token`, `oidc:google` |
| `kinds` | The `Credentials.kind` values it takes |
| `interactive` | `true`: may start a session and is asked for MFA (password, OIDC, key challenge). `false`: per request, no session (token, JWT, signatures) |
| `throttleKeys(credentials, ctx)` | The keys this attempt counts against. A per-request strategy derives them from the credential's stable id (a token id, a key id), never from the raw secret |
| `verify(credentials, ctx)` | Returns a `StrategyOutcome`. It must take the same time for an unknown account as for a known one |

`StrategyOutcome` is `{ ok: false, reason, retryAfterSeconds? }` or `{ ok: true, method, identity | external, ceiling?, delegation?, attributes? }`:

- exactly one of `identity` (an `IdentityRef`) and `external` (an `ExternalSubject` the core links to an identity);
- `method` becomes `AuthnFacts.method`. `DefaultMfaPolicy` asks for MFA only when it is `password`;
- `ceiling` narrows what the principal may do (a token's roles or scope);
- `delegation` makes the principal act on behalf of another identity (agent tokens);
- `attributes` reach `Principal.attributes`. Set only keys your strategy owns, from server-side records or validated claims.

A `reason` must be one of `invalid_credentials`, `unsupported_credentials`, `expired`, `revoked`, `not_linked`, `throttled`. Any other shape counts as a broken strategy and fails the attempt.

A strategy answers `throttled` only when it is short of capacity (the local strategy does it when its hasher queue is full), not to back off a client: the core's `AuthnThrottle` does that. `retryAfterSeconds` is the wait the client should observe; a missing or invalid value counts as 1. The result is a `throttled` failure with that wait, audited as a failed login with reason `throttled`.

### Optional members

| Member | Interface | Effect |
| --- | --- | --- |
| `accepts(credentials)` | `CredentialSelector` | Leaves the strategy out of the candidates unless it returns `true`. Use it when strategies share a kind, such as `token` and `jwt` (both `bearer`). A throwing `accepts` is a decline, except an `InvalidConfiguration`, which fails the request |
| `linkingFor(external)` | `ExternalLinkingStrategy` | The provider's own linking switches. See [Account linking](10-account-linking.md#linking-at-login) |

`isCredentialSelector(value)` tells whether an object has an `accepts` function.

## Shipped strategies

| Entry | Service | Kind | Interactive | Package |
| --- | --- | --- | --- | --- |
| `local` | `LocalPasswordStrategy` | `password` | yes | [`@spinajs/authn-local`](../authn-local/README.md) |
| `token` | `TokenStrategy` | `bearer` | no | [`@spinajs/authn-token`](../authn-token/README.md) |
| `jwt` | `JwtBearerStrategy` | `bearer` | no | [`@spinajs/authn-token`](../authn-token/README.md) |
| `keys-jws` | `JwsAssertionStrategy` | `jws-assertion` | no | [`@spinajs/authn-keys`](../authn-keys/README.md) |
| `keys-httpsig` | `HttpSignatureStrategy` | `http-signature` | no | [`@spinajs/authn-keys`](../authn-keys/README.md) |
| `keys-challenge` | `KeyChallengeStrategy` | `key-challenge` | yes | [`@spinajs/authn-keys`](../authn-keys/README.md) |
| `oidc:<provider>` | `oidc:<provider>` | `external` | yes | [`@spinajs/authn-oidc`](../authn-oidc/README.md) |

`@spinajs/authn-oidc` registers one strategy factory per configured provider, under the name `oidc:<provider>`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.strategies` | `{ name, service }[]` | `[]` | Each `name` once; both non-empty strings | The strategies that run, in the order the candidates are asked |

```ts
authn: {
  strategies: [
    { name: 'local', service: 'LocalPasswordStrategy' },
    { name: 'token', service: 'TokenStrategy' },
    { name: 'jwt', service: 'JwtBearerStrategy' },
  ],
}
```

List the strategies in one config file of the app. Config arrays concatenate across files, so no package lists one.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthenticationStrategy` | `AuthenticationStrategy`; each strategy keeps its own lifetime | None listed | The shipped strategies above | `@Injectable(AuthenticationStrategy)` on your class, then list it in `authn.strategies` |
| `StrategyRegistry` | Class token, per child container | `StrategyRegistry` | None | Not meant to be replaced |

### AuthenticationStrategy: custom implementation

Write a strategy for a login method the shipped ones do not cover, such as a corporate directory. Register it before the app boots, then list it.

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { AuthenticationStrategy, IdentityStore } from '@spinajs/authn';
import type { AuthnContext, CredentialSelector, Credentials, StrategyOutcome, ThrottleKey } from '@spinajs/authn';

export abstract class CorporateDirectory {
  abstract bind(login: string, password: string): Promise<boolean>;
}

const CORPORATE_DOMAIN = '@corp.example.com';

function passwordOf(c: Credentials): { login: string; password: string } | null {
  return c.kind === 'password' && typeof c.login === 'string' && typeof c.password === 'string' ? { login: c.login, password: c.password } : null;
}

@Injectable(AuthenticationStrategy)
export class CorporateDirectoryStrategy extends AuthenticationStrategy implements CredentialSelector {
  readonly name = 'corp';
  readonly kinds = ['password'];
  readonly interactive = true;

  @Autoinject(CorporateDirectory)
  protected Directory: CorporateDirectory;

  @Autoinject(IdentityStore)
  protected Identities: IdentityStore;

  // Only corporate logins reach this strategy; every other password goes to the next candidate.
  accepts(c: Credentials): boolean {
    return passwordOf(c)?.login.toLowerCase().endsWith(CORPORATE_DOMAIN) === true;
  }

  throttleKeys(c: Credentials, _ctx: AuthnContext): readonly ThrottleKey[] {
    const p = passwordOf(c);
    return p ? [{ kind: 'account', value: p.login.toLowerCase() }] : [];
  }

  async verify(c: Credentials, _ctx: AuthnContext): Promise<StrategyOutcome> {
    const p = passwordOf(c);
    if (!p) return { ok: false, reason: 'unsupported_credentials' };
    // Both calls run for an unknown login too, so its timing matches a known one.
    const identity = await this.Identities.findByLogin(p.login);
    const bound = await this.Directory.bind(p.login, p.password);
    if (!identity || !bound) return { ok: false, reason: 'invalid_credentials' };
    return { ok: true, identity, method: 'password' };
  }
}
```

```ts
authn: {
  strategies: [
    { name: 'corp', service: 'CorporateDirectoryStrategy' },
    { name: 'local', service: 'LocalPasswordStrategy' },
  ],
}
```

The strategy answers `method: 'password'`, so `DefaultMfaPolicy` asks for the user's second factor as for a local login.

## Important behaviour

- A strategy that is registered but not listed never runs.
- Only `unsupported_credentials` passes the credentials to the next candidate. A strategy without `accepts` that answers `invalid_credentials` for a value in another format hides every strategy listed after it. Nothing checks at boot that one strategy shadows another.
- The strategy's `account-ip` keys are dropped: the service builds them itself from the account key and `ctx.ip`.
- A per-request strategy's failures are verified in full for a parallel burst before the backoff applies. Use `interactive: false` only for credentials nobody can guess: tokens of 128 bits or more, or signatures.
- An interactive strategy that answers a `service` or `agent` identity is refused: only users get sessions.
- `StrategyRegistry` is one instance per container, so a child container reads its own `authn.strategies` and may list a root strategy next to its own.

## Best practices

- Return `unsupported_credentials` without I/O for a value in another format, or implement `accepts`.
- Do the same work for an unknown account as for a known one: verify against a dummy hash, call the directory anyway.
- Derive per-request throttle keys from a stable credential id, never from the secret itself.
- Leave sessions, MFA and events to `AuthnService`. A strategy that issues a session bypasses the throttle reset and the MFA policy.

## Patterns and antipatterns

```ts
// Don't: answers invalid_credentials for every bearer value it cannot parse, so the strategy listed after it never runs
async verify(c: Credentials): Promise<StrategyOutcome> {
  if (!isMyFormat(c)) return { ok: false, reason: 'invalid_credentials' };
}

// Do: pass foreign values on
async verify(c: Credentials): Promise<StrategyOutcome> {
  if (!isMyFormat(c)) return { ok: false, reason: 'unsupported_credentials' };
}
```

## Related

- [Authentication flow](01-authentication-flow.md): what runs before and after `verify`.
- [Throttling](05-throttling.md#keys-the-service-builds): how the strategy's keys are rewritten.
- [`@spinajs/authn-testing`](../authn-testing/README.md): `runStrategyConformance` checks a strategy against the contract.
