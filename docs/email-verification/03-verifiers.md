# Verifiers

A verifier looks at one normalised ASCII domain and answers `allow`, `refuse` or `unknown`. `EmailVerification` runs the ones named in `emailVerification.verifiers`, in that order. Four ship with the package.

| Verifier (class) | `name` | Cached | Answers | Default |
| --- | --- | --- | --- | --- |
| `ListVerifier` | `list` | no | `allow`, `refuse`, `unknown` | on |
| `DnsVerifier` | `dns` | yes | `refuse`, `unknown` | on |
| `RdapVerifier` | `rdap` | yes | `refuse`, `unknown` | opt in |
| `HttpDomainVerifier` | `http` | yes | `refuse`, `unknown` | opt in |

Put cheap, local verifiers first: `ListVerifier`, then `DnsVerifier`, then the ones that call out.

## `ListVerifier`

Keeps the `allow`, `block` and `block-mx` lists in memory, loaded from `store.loadLists()`.

1. Domain or a parent domain in an `allow` list: `allow`, source `list:<source>`.
2. In a `block` list: `refuse`, reason `listed`, source `list:<source>`.
3. Otherwise `unknown`.

- Matching is by label suffix: `x.mailinator.com` matches `mailinator.com`, `notmailinator.com` does not. There is no Public Suffix List.
- An allow entry beats every block entry. The `admin` entry wins over a synced entry of the same domain and kind.
- It calls `store.listVersion()` every `lists.refreshSeconds` and reloads when the token changed.
- When the first load fails, it logs an error and answers `unknown` until a refresh succeeds, so the other verifiers decide.
- `block-mx` entries are read by `DnsVerifier`, not here.

## `DnsVerifier`

Uses its own `dns.promises.Resolver` with `dns.timeoutMs` and `dns.tries`.

| DNS answer | Verdict | Reason | Cached for |
| --- | --- | --- | --- |
| `ENOTFOUND` on the MX lookup | `refuse` | `domain_not_found` | `dns.ttl.negative` |
| No MX, and no A or AAAA record | `refuse` | `no_mail_host` | `dns.ttl.negative` |
| One MX with an empty or `.` exchange (null MX, RFC 7505) | `refuse` | `null_mx` | `dns.ttl.positive` |
| An MX host matches a `block-mx` entry | `refuse` | `disposable_mx` | `dns.ttl.negative` |
| MX records present | `unknown` | `resolves` | `dns.ttl.positive` |
| No MX but an A or AAAA record (implicit MX, RFC 5321 section 5.1) | `unknown` | `resolves` | `dns.ttl.positive` |
| `SERVFAIL`, timeout or any other error | `unknown` | none | not cached |

`disposable_mx` uses the short negative TTL because it comes from an editable list: a correction must take effect soon. When the MX lookup says the name exists, an `ENOTFOUND` on the A lookup is treated as a flaky resolver and answers `unknown`.

## `RdapVerifier`

Refuses domains registered less than `rdap.minAgeDays` ago.

1. Loads the IANA bootstrap file (`rdap.bootstrapUrl`) on first use and refreshes it every 24 h. After a failed load it waits 5 minutes before the next try and keeps the last good map. With no map yet, `verify()` throws, which `EmailVerification` treats as an error.
2. Finds the RDAP server of the TLD. No server: `unknown`.
3. Queries the full domain, then each parent down to two labels, at most `rdap.maxLookups` requests.
4. On `404` it tries the next parent; `429` answers `unknown` with reason `rate_limited`; any other non-`200` answers `unknown`.
5. On `200` it reads the earliest `registration` event. A missing event, or a date in the future, answers `unknown`.
6. Younger than `minAgeDays`: `refuse`, reason `domain_too_new`. Otherwise `unknown`, reason `registered`.

| Answer | Cached for |
| --- | --- |
| `domain_too_new` | `rdap.ttl.negative` |
| `registered` | `rdap.ttl.positive` |
| `rate_limited` | `rdap.rateLimitedTtlSeconds` |
| any other `unknown` | not cached |

A `404` never refuses: existence is the `dns` verifier's job, and a missing subdomain is normal. Responses are capped at 256 KiB, the bootstrap at 1 MiB.

## `HttpDomainVerifier`

Asks each configured provider in order; the first `refuse` wins.

1. Builds the URL by replacing `{domain}` with the percent-encoded domain, and sends `headers`.
2. A non-`200` status, a transport error, a body that is not JSON, or a missing `resultPath` answers `unknown`.
3. The value at `resultPath` must be a string, number or boolean of the same type as some `refuseWhen` item. Any other type (an object, an array, `null`) answers `unknown`.
4. A value equal to a `refuseWhen` item: `refuse` with the provider's `reason` and source `http:<name>`. Otherwise this provider is clean.
5. All providers clean: `unknown` with reason `clean`. If any provider failed and none refused: `unknown`, not cached.

Provider names must be unique; the verifier throws at boot on a duplicate. A refusal is cached for the refusing provider's `ttlSeconds`; a clean answer for the lowest `ttlSeconds` of all providers. With no providers it answers `unknown`. Answers are capped at 64 KiB. The log shows the provider name and the error, never a header value and never the response body.

## Best practices

- Add `RdapVerifier` after `DnsVerifier`: DNS rejects dead domains cheaply, so RDAP only sees domains that resolve.
- Keep `timeoutMs` above the slowest verifier you enable. A verifier that exceeds it counts as an error and is not cached.
- Send API keys through `headers` from secret config. They are not logged.

## Related

- [Checking an email](01-checking-an-email.md): how verdicts combine.
- [Domain lists and sync](04-domain-lists-and-sync.md): where the `block`, `allow` and `block-mx` entries come from.
- [Custom verifiers and stores](07-custom-verifiers-and-stores.md): add your own.
