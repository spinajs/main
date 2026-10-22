# Domain lists and sync

The lists are sets of domains held by the store. Each entry has a kind and a source. `DomainListSync` fills the synced sources from URLs; the [CLI](05-cli.md) edits the `admin` source by hand.

| Kind | Read by | Meaning |
| --- | --- | --- |
| `block` | `ListVerifier` | Refuse addresses on this domain or its subdomains |
| `allow` | `ListVerifier` | Allow it, overriding every block entry and every later verifier |
| `block-mx` | `DnsVerifier` | Refuse domains whose MX host is on this domain, for throwaway-mail services |

The source `admin` is reserved for CLI entries. A sync never touches it, and a configured source cannot use that name.

> **Only add list sources you trust.** A synced `block` list can refuse any domain, `gmail.com` included, and the sync applies whatever the URL returns. A compromised or careless source can block real customers. Pin sources you control or review, and keep an `allow` entry for the domains you cannot lose: `npx spinajs email-verification:allow gmail.com`. An `allow` entry beats every block.

## How the sync works

`DomainListSync.run(only?)` syncs every source in `emailVerification.lists.sources`, one after another, or only the one named.

1. It throws `InvalidArgument` for duplicate source names, or when `only` names no source.
2. For each source it reads the stored origin (`<kind>|<url>`). If it differs from the configured one, the stored ETag and count are ignored and the list is fetched in full.
3. It sends a GET over `SafeFetch` with `If-None-Match` when it has an ETag (30 s timeout, 16 MiB cap, https only, no redirects). `304` gives `unchanged`. Any other status but `200` gives `failed`.
4. It parses the body. `lines`: one domain per line, blank lines and `#` lines skipped. `json`: an array of strings. Every entry is normalised; invalid ones are counted and dropped.
5. It refuses the update (status `refused`, old list kept) when the new list is empty, or has fewer domains than `minKeepRatio` times the stored count.
6. It calls `store.replaceSource(name, kind, domains)`. If the source's kind changed since the last run, the entries of the old kind are removed too.
7. It stores the count, the ETag (reset to empty when the response has none) and the origin.

Outcomes, per source: `updated`, `unchanged`, `refused` or `failed`, with `count`, `invalid` and `error` where they apply. A failed or refused source keeps its last good list. Errors are logged at warn.

A crash between the steps leaves the origin cleared, so the next run fetches the full list again instead of trusting a stale ETag.

## Scheduled sync

The scheduler task lives in a subpath because `@spinajs/scheduler` is an optional peer dependency. Import it once, anywhere that runs at boot, and install `@spinajs/scheduler`:

```ts
import '@spinajs/email-verification/scheduler';
```

This registers the `emailVerification` configuration schema, so the `lists.*` defaults apply even when nothing else imports the package, and `EmailDomainListSyncTask` under the schedule `email-verification.list-sync`: every 24 hours, `runOn: 'leader'` (one node in a cluster), `overlap: 'skip'`, `misfire: 'run-once'`. The scheduler is cluster-safe, so the stores need no lock.

The task calls `DomainListSync.run()`. If any source `failed`, it throws an error that names each failed source with its error (cut to 200 characters), so the scheduler records and retries the failure: `list sync failed: spam-list: answered 503`. `refused` and `unchanged` do not fail the run. A successful run stores the outcomes as the task result.

Without the scheduler, run `email-verification:sync` from cron.

The first sync is not automatic. Until it runs, the store holds no synced entries and `ListVerifier` has nothing to block with.

## Important behaviour

- `replaceSource` is atomic for readers: they see the old set or the new set, never a mix.
- Every list write changes `listVersion`; other processes reload within `lists.refreshSeconds`. `block` and `allow` changes apply from then on.
- `block-mx` changes act through the cached `dns` verdict. A domain checked before the entry was added (or before the first sync) keeps its `resolves` verdict until `dns.ttl.positive` (24 h by default) runs out. A domain refused with `disposable_mx` stays refused for up to `dns.ttl.negative` (1 h by default) after its entry is removed.
- `email-verification:sync` runs in the `spinajs` CLI process, which must import the store package. See [The store package in the CLI process](05-cli.md#the-store-package-in-the-cli-process).
- Changing a source's `kind` or `url` resets its sync state, so the next run re-downloads in full and removes the entries it wrote under the previous kind.
- Renaming a source does not remove the entries of the old name. Remove them with `email-verification:unlist --kind <kind> --source <old> <domains>`.

## Related

- [Verifiers](03-verifiers.md): how the lists are used.
- [Configuration](02-configuration.md): `lists.*`.
