# Token generation

`AccessTokenGenerationProvider` mints new API tokens and hashes presented ones. The default, `SecureRandomTokenProvider`, produces `<prefix><base64url of N random bytes>` and stores the SHA-256 hex digest. Replace it when you need another hash (for example a keyed one) or another body format.

## How it works

1. `DbTokenService` injects the provider into its `Generator` property with `@AutoinjectService('authn.token.generation', AccessTokenGenerationProvider)`: the registered class whose name is `authn.token.generation.service`, resolved once, when `DbTokenService` is built. `create` and `validate` both use it. See [Config-selected services](../configuration/08-config-selected-services.md#autoinjectservice).
2. On create, `generate()` returns `{ Plaintext, Hash }`:
   1. `checkTokenSize(prefix, length)` throws `InvalidOption` unless `length` is an integer of at least 32 and `prefix.length + ceil(length × 4 / 3)` is at most `MAX_TOKEN_LENGTH` (1024).
   2. `randomBytes(length)` from `node:crypto`, encoded base64url, after `authn.token.prefix`.
   3. `Hash` is `hash(Plaintext)`.
3. `DbTokenService` then checks the plaintext: it must start with the prefix, the rest must be base64url of at least `ceil(length × 4 / 3)` characters, and the whole must fit in 1024 characters. Otherwise create throws `UnexpectedServerError` and stores nothing.
4. The row stores `Hash`; the caller gets `Plaintext`.
5. On validate, `hash(raw)` of the presented token is looked up in the `Token` column.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.token.generation.service` | `string` | `'SecureRandomTokenProvider'` (package config) | class name of a registered `AccessTokenGenerationProvider` | The provider used for every create and validate. |
| `authn.token.prefix` | `string` | `'spt_'` | non-empty | Stable plaintext prefix; lets secret scanners find leaked tokens and lets the `bearer` dispatch tell tokens from JWTs. |
| `authn.token.length` | `integer` | `32` | `>= 32`, and prefix plus body at most 1024 characters | Random bytes per token (32 bytes = 256 bits). |

```ts
authn: {
  token: { generation: { service: 'SecureRandomTokenProvider' }, prefix: 'spt_', length: 32 },
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Token algorithm | `AccessTokenGenerationProvider`; singleton; `@Injectable(AccessTokenGenerationProvider)`; resolved by class name when `DbTokenService` is built | `SecureRandomTokenProvider` | none | Register a subclass with `@Injectable(AccessTokenGenerationProvider)` and set `authn.token.generation.service` to its class name. |

Exported helpers: `checkTokenSize(prefix, length)` and `MAX_TOKEN_LENGTH` (1024), the size rule every token must meet.

### Token algorithm: custom implementation

A keyed hash (HMAC with a server secret) means a stolen copy of the table cannot be checked against guessed tokens offline. Implement both methods: `generate()` must honour the configured prefix and length, and `hash()` must be deterministic and fit the 64-character `Token` column.

```ts sample
import { createHmac, randomBytes } from 'node:crypto';
import { AccessTokenGenerationProvider, checkTokenSize } from '@spinajs/authn-token';
import type { IGeneratedToken } from '@spinajs/authn-token';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';

/** HMAC-SHA-256 with a server key; config: authn.token.generation.service = 'PepperedTokenProvider'. */
@Injectable(AccessTokenGenerationProvider)
export class PepperedTokenProvider extends AccessTokenGenerationProvider {
  @Config('authn.token.prefix')
  protected Prefix: string;

  @Config('authn.token.length')
  protected Length: number;

  public async generate(): Promise<IGeneratedToken> {
    checkTokenSize(this.Prefix, this.Length);
    const plaintext = `${this.Prefix}${randomBytes(this.Length).toString('base64url')}`;
    return { Plaintext: plaintext, Hash: this.hash(plaintext) };
  }

  public hash(plaintext: string): string {
    const key = process.env.TOKEN_HASH_KEY;
    if (!key) {
      throw new Error('TOKEN_HASH_KEY is not set');
    }
    // Hex of SHA-256 is 64 characters, the width of the Token column.
    return createHmac('sha256', key).update(plaintext).digest('hex');
  }
}
```

Import the file in the app's bootstrap after `@spinajs/authn-token`, and set the config key before `TokenService` is first resolved.

## Important behaviour

- **The hash is the lookup key.** Switching to a provider with another `hash()` makes every existing token unknown (`invalid_credentials`). Plan it as a token reset.
- **Picked once.** `authn.token.generation.service` is read when `DbTokenService` is built; a later change of the key does not switch the provider of a running service. A name that matches no registered provider fails that resolve with `ServiceNotFound`.
- **Prefix and length are checked twice.** Once in the provider (`checkTokenSize`) and again on its output in `DbTokenService`, so a custom provider that ignores the config fails loudly instead of minting weak or oversized tokens.
- **Boot check.** `TokenStrategy.resolve()` runs `checkTokenSize` at boot, so a prefix and length over 1024 characters stop the app, not the first request.
- **`length` is a floor of entropy.** The schema refuses less than 32 bytes; per-request strategies need unguessable credentials because a parallel burst is verified in full before the throttle applies.

## Best practices

- Keep the default prefix, or pick one unique to your product, and register it with your secret scanner (GitHub secret scanning, gitleaks).
- Keep `hash()` free of I/O; it runs on every token request.

## Related

- [Issuing and revoking tokens](01-token-service.md): where `generate()` is called.
- [API token authentication](02-token-authentication.md): where `hash()` is called.
- [Config-selected services](../configuration/08-config-selected-services.md): how the class name in config picks the provider.
