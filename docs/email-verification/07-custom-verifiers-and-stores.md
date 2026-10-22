# Custom verifiers and stores

Both extension points are abstract classes registered with `@Injectable(<Token>)` and picked by class name from config.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Verifier | `DomainVerifier`, singleton, listed in `emailVerification.verifiers` | `ListVerifier`, `DnsVerifier` | `RdapVerifier`, `HttpDomainVerifier` | Extend `DomainVerifier`, decorate with `@Injectable(DomainVerifier)`, add `{ service: '<ClassName>' }` to `verifiers` |
| Store | `EmailVerificationStore`, singleton, named by `emailVerification.store` | `MemoryEmailVerificationStore` | ORM, Redis, DynamoDB | Extend `EmailVerificationStore`, decorate with `@Injectable(EmailVerificationStore)`, set `store` to the class name |

Import the module that holds your class before `EmailVerification` is first resolved, so the decorator has registered it.

## Custom `DomainVerifier`

| Member | Meaning |
| --- | --- |
| `name` | Short name used in cache keys, results and logs (`dns`). Keep it unique and stable: changing it orphans cached verdicts. |
| `cacheable` | `true` to cache verdicts in the LRU and the store |
| `verify(domain)` | Gets the normalised ASCII domain only, never the address. Returns `{ result, reason?, source? }` |
| `ttlFor(verdict)` | Seconds to cache `verdict`; `0` keeps it out of every cache |

- Answer `UNKNOWN` (exported) when you cannot decide. Answer `allow` only for an explicit override: it ends the chain.
- Throw only for a real failure. The service logs it and applies `onError`; a thrown error is never cached.
- Set `source` (for example `partners:acme`) to replace the verifier name as the result source.
- Make outbound calls through `SafeFetch` (`@Autoinject(SafeFetch)`): https only, no redirects, a body cap.
- Return `ttlFor() > 0` only for answers that are stable. Do not cache `unknown` answers that came from a failure.

### Example: refuse a company's competitor domains

```ts sample
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { DomainVerifier, UNKNOWN, domainListed } from '@spinajs/email-verification';
import type { DomainVerdict } from '@spinajs/email-verification';

@Injectable(DomainVerifier)
export class CompetitorVerifier extends DomainVerifier {
  public readonly name = 'competitor';
  public readonly cacheable = false;

  @Config('shop.competitorDomains')
  protected Competitors: string[];

  public async verify(domain: string): Promise<DomainVerdict> {
    return domainListed(domain, new Set(this.Competitors)) ? { result: 'refuse', reason: 'competitor', source: 'competitor' } : UNKNOWN;
  }

  public ttlFor(): number {
    return 0;
  }
}
```

Enable it:

```ts
export default {
  shop: { competitorDomains: ['rival.example'] },
  emailVerification: {
    verifiers: [{ service: 'ListVerifier' }, { service: 'CompetitorVerifier' }, { service: 'DnsVerifier' }],
  },
};
```

## Custom `EmailVerificationStore`

Implement these methods. Domains reach the store already normalised.

| Method | Contract |
| --- | --- |
| `getVerdict(verifier, domain)` | The cached `CachedVerdict`, or `null` when missing or expired. Absent `reason` and `source` stay absent, never `null`. |
| `setVerdict(verifier, domain, verdict, ttlSeconds)` | Stores nothing when `ttlSeconds` is 0 or less |
| `loadLists()` | Every `ListEntry` (`domain`, `kind`, `source`) |
| `listVersion()` | An opaque token that changes on every list write |
| `upsertEntries(entries)` | Adds entries; an entry stored twice stays one entry |
| `removeEntries(kind, domains, source)` | Removes only that kind and source |
| `replaceSource(source, kind, domains)` | Readers see the old set or the new set, never a mix. No domains removes the source. Must cope with tens of thousands of domains. |
| `getMeta(key)` / `setMeta(key, value)` | String values for sync state (ETags, counts, origin) |

`replaceSource` is the hard part. The shipped stores each use a different technique: a generation pointer ([ORM](../email-verification-orm/README.md), [DynamoDB](../email-verification-dynamodb/README.md)) or a temporary set renamed over the live one ([Redis](../email-verification-redis/README.md)).

### Run the contract tests

`storeContract` from `@spinajs/email-verification/testing` is the shared mocha suite every shipped store passes. It covers verdict round trips and TTL expiry, upsert and remove, `replaceSource` (including a reader racing a replace), `listVersion` changes and meta values. It needs `mocha` and `chai`, which are optional peer dependencies.

```ts
import { MemoryEmailVerificationStore } from '@spinajs/email-verification';
import { storeContract } from '@spinajs/email-verification/testing';

// makeStore must return an empty store on every call.
storeContract('MemoryEmailVerificationStore', async () => new MemoryEmailVerificationStore(), {
  dispose: async () => undefined,
});
```

Run it with your normal mocha setup. `dispose` runs once after the suite.

### Example: a store that logs list writes

```ts sample
import { Injectable } from '@spinajs/di';
import { EmailVerificationStore, MemoryEmailVerificationStore } from '@spinajs/email-verification';
import type { ListKind } from '@spinajs/email-verification';

@Injectable(EmailVerificationStore)
export class AuditedMemoryStore extends MemoryEmailVerificationStore {
  public async replaceSource(source: string, kind: ListKind, domains: readonly string[]): Promise<void> {
    console.info(`list ${kind}/${source} replaced with ${domains.length} domains`);
    await super.replaceSource(source, kind, domains);
  }
}
```

Select it with `emailVerification.store: 'AuditedMemoryStore'`.

## Related

- [Verifiers](03-verifiers.md): the shipped implementations to read as examples.
- [Choosing a store](06-choosing-a-store.md)
