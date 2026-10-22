# Configuration

All settings live under `emailVerification`. The JSON schema in `schema.ts` holds every default, so a key you leave out takes its default, and a wrong value (a bad enum, a non-https URL) fails the boot. Importing `@spinajs/email-verification` registers the schema; `@spinajs/email-verification/register-schema` registers it alone.

Two rules of `@spinajs/configuration` apply here:

- **Arrays are concatenated across config sources.** When two config files both set `lists.sources`, `http.providers` or `verifiers`, the result holds the items of both. Set each of these arrays in one config file only.
- **Unknown keys are dropped without an error.** A misspelled key, such as `lists.refreshSecond`, is removed and its setting takes the default. Only a wrong value fails the boot.

## Core

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `emailVerification.enabled` | `boolean` | `false` | | `false` makes `check()` allow everything; `ListVerifier` then loads no lists and does not poll the store |
| `emailVerification.store` | `string` | `'MemoryEmailVerificationStore'` | Class name of a registered `EmailVerificationStore` | [The store](06-choosing-a-store.md) |
| `emailVerification.verifiers` | `{ service: string }[]` | `[{ service: 'ListVerifier' }, { service: 'DnsVerifier' }]` | At least one item; each `service` is the class name of a registered `DomainVerifier` | Verifiers, in the order they run |
| `emailVerification.timeoutMs` | `integer` | `3000` | `>= 1` | Time limit of one verifier call, one store read, one store write, and one list load or refresh of `ListVerifier` |
| `emailVerification.onError` | `string` | `'allow'` | `'allow'`, `'refuse'` | Result when a verifier throws or times out |
| `emailVerification.refuseCode` | `string` | `'email_domain_refused'` | `^[a-z0-9][a-z0-9_.-]{0,58}$` | `code` of every refusal |
| `emailVerification.lru.maxEntries` | `integer` | `10000` | `>= 0`; `0` turns the LRU off | In-process verdict cache size |
| `emailVerification.lru.ttlSeconds` | `integer` | `300` | `>= 0` | Longest time a verdict stays in the LRU |

## Lists

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `emailVerification.lists.refreshSeconds` | `integer` | `30` | `>= 1` | How often `ListVerifier` compares `store.listVersion()` and reloads |
| `emailVerification.lists.minKeepRatio` | `number` | `0.5` | `0` to `1` | A sync that returns fewer domains than this share of the stored count is refused |
| `emailVerification.lists.sources` | `object[]` | one source, `disposable-email-domains` | Names must be unique | The lists to download |
| `emailVerification.lists.sources[].name` | `string` | required | `^[a-z0-9][a-z0-9_.-]{0,62}$`, not `admin` | Source name; also the `list:<name>` result source |
| `emailVerification.lists.sources[].url` | `string` | required | `https://` only | Where to download the list |
| `emailVerification.lists.sources[].kind` | `string` | required | `'block'`, `'allow'`, `'block-mx'` | What the list means |
| `emailVerification.lists.sources[].format` | `string` | `'lines'` | `'lines'`, `'json'` | One domain per line, or a JSON array of strings |

The default source is the `disposable_email_blocklist.conf` file of the `disposable-email-domains` project on GitHub, as `kind: 'block'`. A `sources` array you configure replaces it.

## DNS

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `emailVerification.dns.servers` | `string[]` | `[]` | Resolver addresses | Overrides the system resolvers when not empty |
| `emailVerification.dns.timeoutMs` | `integer` | `1500` | `>= 1` | Resolver timeout per try |
| `emailVerification.dns.tries` | `integer` | `2` | `>= 1` | Resolver tries |
| `emailVerification.dns.ttl.positive` | `integer` | `86400` | `>= 0` seconds | Cache time of `null_mx` and of a domain that resolves |
| `emailVerification.dns.ttl.negative` | `integer` | `3600` | `>= 0` seconds | Cache time of `domain_not_found`, `no_mail_host` and `disposable_mx` |

## RDAP

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `emailVerification.rdap.bootstrapUrl` | `string` | `'https://data.iana.org/rdap/dns.json'` | `https://` only | IANA map from TLD to RDAP server |
| `emailVerification.rdap.requestTimeoutMs` | `integer` | `2000` | `>= 1` | Timeout of one RDAP or bootstrap request |
| `emailVerification.rdap.minAgeDays` | `integer` | `7` | `>= 0` | A domain registered more recently than this is refused |
| `emailVerification.rdap.maxLookups` | `integer` | `4` | `>= 1` | Most RDAP requests for one domain |
| `emailVerification.rdap.rateLimitedTtlSeconds` | `integer` | `3600` | `>= 0` | Cache time of a `429` answer |
| `emailVerification.rdap.ttl.positive` | `integer` | `2592000` | `>= 0` seconds | Cache time of an old enough domain |
| `emailVerification.rdap.ttl.negative` | `integer` | `3600` | `>= 0` seconds | Cache time of `domain_too_new` |

## HTTP providers

`emailVerification.http.providers` is an array, default `[]`. Provider `name` values must be unique; `HttpDomainVerifier` throws `InvalidOperation` at boot on a duplicate.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `...providers[].name` | `string` | required | `^[a-z0-9][a-z0-9_.-]{0,62}$` | Provider name; the result source is `http:<name>` |
| `...providers[].url` | `string` | required | `https://` and contains `{domain}` | URL template; `{domain}` becomes the percent-encoded domain |
| `...providers[].headers` | `Record<string,string>` | `{}` | Names are HTTP field-name tokens (RFC 9110); values hold no control character (CR, LF, NUL, tab, DEL) | Request headers, for example an API key. Never logged |
| `...providers[].resultPath` | `string` | required | Dot path into the JSON answer | Where the value to test sits |
| `...providers[].refuseWhen` | `(boolean \| string \| number)[]` | `[true]` | At least one scalar | Values at `resultPath` that mean refuse |
| `...providers[].reason` | `string` | `'refused_by_provider'` | `^[a-z0-9_]{1,64}$` | `reason` of the refusal |
| `...providers[].ttlSeconds` | `integer` | `86400` | `>= 0` | Cache time of the provider's answer |

## Store settings

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `emailVerification.orm.connection` | `string` | `'email-verification-connection'` | A connection name known to the ORM | [ORM store](../email-verification-orm/README.md) connection |
| `emailVerification.orm.cleanupIntervalMs` | `integer` | `600000` | `>= 1000` | How often the ORM store deletes expired rows |
| `emailVerification.redis` | `object` | `{}` | ioredis `RedisOptions` | [Redis store](../email-verification-redis/README.md) connection; `keyPrefix` defaults to `ev:` |
| `emailVerification.dynamodb.table` | `string` | `'email-verification'` | At least 3 characters | [DynamoDB store](../email-verification-dynamodb/README.md) table |
| `emailVerification.dynamodb.config` | `object` | `{}` | AWS SDK `DynamoDBClientConfig` | Client configuration |
| `emailVerification.dynamodb.createTable` | `boolean` | `true` | | Create the table and enable TTL when missing |

## Example

```ts
export default {
  emailVerification: {
    enabled: true,
    store: 'RedisEmailVerificationStore',
    verifiers: [{ service: 'ListVerifier' }, { service: 'DnsVerifier' }, { service: 'RdapVerifier' }, { service: 'HttpDomainVerifier' }],
    onError: 'allow',
    lists: {
      sources: [
        { name: 'disposable-email-domains', kind: 'block', format: 'lines', url: 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf' },
      ],
    },
    http: {
      providers: [
        {
          name: 'kickbox-open',
          url: 'https://open.kickbox.com/v1/disposable/{domain}',
          resultPath: 'disposable',
          refuseWhen: [true],
          reason: 'disposable',
        },
      ],
    },
    redis: { host: '10.0.0.12', port: 6379, password: process.env.REDIS_PASSWORD },
  },
};
```

## Important behaviour

- Every outbound URL (list sources, RDAP, HTTP providers) is `https://` only. Redirects are not followed, and each response has a size cap.
- `store` and `verifiers[].service` are **class names** (`DnsVerifier`), while results, cache keys and logs use the short verifier `name` (`dns`).
- `RdapVerifier` and `HttpDomainVerifier` run only when listed in `verifiers`.
