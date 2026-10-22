# Checking an email

`EmailVerification` takes an address, extracts its domain and asks the configured verifiers in order. The first definite answer wins; if every verifier is unsure, the address is allowed.

## How it works

1. `check(email)` returns `{ allowed: true, domain }` at once when `emailVerification.enabled` is `false`.
2. `emailDomain(email)` takes the part after the last `@`, trims it, strips one trailing dot and converts it to lower-case ASCII (punycode). It gives `null` for an empty part, an IP literal (`[...]`), fewer than two labels, an invalid label or a numeric TLD. `null` is refused with reason `invalid_domain` and source `address`.
3. Concurrent checks of the same domain share one run (single flight per domain).
4. For each verifier in `emailVerification.verifiers` order, `verdictOf()`:
   - for a `cacheable` verifier, reads the in-process LRU, then `store.getVerdict()`. A hit is used as is. A store read error is logged and counts as a miss.
   - otherwise calls `verifier.verify(domain)` under `timeoutMs`.
   - a throw or timeout is logged at warn with the domain, and counts as `unknown`, or as `refuse` with reason `verifier_error` when `onError` is `'refuse'`. That verdict is not cached.
   - caches the answer when `verifier.ttlFor(verdict)` is above 0: in the LRU for `min(ttl, lru.ttlSeconds)` seconds and in the store for `ttl` seconds. A store write error is logged and ignored.
5. `allow` returns `{ allowed: true, domain, source }`. `refuse` returns a refusal. `unknown` moves on to the next verifier.
6. When every verifier answered `unknown`, the result is `{ allowed: true, domain }`.

Only `ListVerifier` answers `allow`, and only for an explicit allow entry. A domain with working MX records is not proof that it is clean.

## Result

```ts
type EmailCheckResult =
  | { allowed: true; domain: string | null; source?: string }
  | { allowed: false; code: string; domain: string | null; source: string; reason: string };
```

| Field | Meaning |
| --- | --- |
| `code` | `emailVerification.refuseCode` (default `email_domain_refused`). Send only this to the client. |
| `reason` | Why: `listed`, `domain_not_found`, `no_mail_host`, `null_mx`, `disposable_mx`, `domain_too_new`, `invalid_domain`, `verifier_error`, an HTTP provider's `reason` |
| `source` | What decided: `list:<source>`, `http:<provider>`, the verifier name (`dns`, `rdap`) or `address` |
| `domain` | The normalised domain, `null` for an unusable address |

`source` and `reason` are for logs and audit. Returning them to the client would reveal which checks are configured. Every refusal is logged at info with the domain, never the full address.

## `explain(email)`

`explain()` returns `{ domain, outcomes }` with each verifier's live answer in config order. It reads no cache and writes none, and it does not stop at the first answer. A throwing verifier shows as `unknown` with an `error`. The `email-verification:check` [command](05-cli.md) prints it.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `EmailVerification` | `@Injectable()`, singleton | This package | Your subclass | Subclass and override the protected `decide()`, `verdictOf()`, `readStore()`, `writeStore()` or `refused()` |
| Verifiers | `DomainVerifier`, resolved by class name from `emailVerification.verifiers` | `ListVerifier`, `DnsVerifier` | `RdapVerifier`, `HttpDomainVerifier`, your own | [Custom verifiers](07-custom-verifiers-and-stores.md#custom-domainverifier) |
| Store | `EmailVerificationStore`, resolved by class name from `emailVerification.store` | `MemoryEmailVerificationStore` | ORM, Redis, DynamoDB | [Choosing a store](06-choosing-a-store.md) |

At boot `resolve()` throws `InvalidOperation` when `emailVerification.verifiers` names a class that no `DomainVerifier` registers.

## Important behaviour

- A cache or store failure never blocks a check. Only a verifier failure is affected by `onError`.
- `onError: 'refuse'` turns every verifier error and timeout into a refusal. Use it only when a missed check costs more than a refused signup.
- Verdicts are cached per verifier and domain. The `list` verifier is never cached, so list edits apply within `lists.refreshSeconds`.
- The LRU is per process. With `lru.maxEntries: 0` it is off.
- Logs hold the domain only. Provider headers and API keys are never logged.

## Examples

### Refuse a signup and keep the reason in the audit log

```ts sample
import { DI } from '@spinajs/di';
import { EmailVerification } from '@spinajs/email-verification';

export async function assertEmailAcceptable(email: string): Promise<void> {
  const verification = await DI.resolve(EmailVerification);
  const result = await verification.check(email);
  if (!result.allowed) {
    console.warn(`signup refused: ${result.domain} by ${result.source} (${result.reason})`);
    throw new Error(result.code);
  }
}
```

## Related

- [Configuration](02-configuration.md): `enabled`, `timeoutMs`, `onError`, `refuseCode`, `lru`.
- [Verifiers](03-verifiers.md): what each verifier answers.
