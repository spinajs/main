# DynamoDB store

`DynamoDbEmailVerificationStore` implements `EmailVerificationStore` on a single table with the string hash key `pk`. Use it on AWS when you want a shared store without running a database.

## How it works

1. Importing the package registers `DynamoDbEmailVerificationStore` under the `EmailVerificationStore` token. Set `emailVerification.store` to `'DynamoDbEmailVerificationStore'`.
2. On `resolve()` the store creates a `DynamoDBClient` from `emailVerification.dynamodb.config`. When `createTable` is `true` it then provisions the table (see below).
3. A verdict is one item. A read ignores an item whose `ExpiresAt` has passed, even before DynamoDB's TTL deletes it.
4. A list source is a **manifest** plus **chunk items** of newline-joined domains, so a list larger than the 400 KB item limit still fits (a chunk is at most about 300 KB).
5. A list write (`upsertEntries`, `removeEntries`, `replaceSource`) works on one source at a time:
   1. read the manifest and, for an edit, the current chunks;
   2. put the new chunks under a fresh generation id;
   3. put the manifest with a conditional write on the old generation (`PrevGen` and `PrevChunks` record it);
   4. add the source to the index item (before the version bump, so a process that sees the new version finds the source);
   5. write a new `listVersion`;
   6. delete the replaced generation and the one before it.
6. If the conditional write fails, another writer won: the store drops its chunks, waits briefly and retries, up to 5 attempts, then throws `InvalidOperation`.
7. `loadLists()` reads the index, then each source. A chunk that vanished because a writer replaced the generation makes the reader read the manifest again, up to 5 attempts. A source that stays unreadable is logged and skipped.

## Table provisioning

With `createTable: true` the store:

1. describes the table, and creates it when it does not exist: hash key `pk` (string), on-demand billing. If another instance creates it first, that is accepted;
2. waits until the table exists (up to 120 s);
3. enables TTL on the attribute `ExpiresAt`. A table whose TTL already uses another attribute is left alone, with a warning that expired verdicts stay in the table.

With `createTable: false` the store assumes the table exists with that key and TTL, and the role needs no table-management permission.

## Item layout

| `pk` | Attributes | Meaning |
| --- | --- | --- |
| `V#<verifier>#<domain>` | `Verdict` (JSON), `ExpiresAt` (epoch seconds) | A cached verdict; removed by DynamoDB TTL |
| `S#<kind>#<source>` | `Gen`, `Chunks`, `PrevGen`, `PrevChunks` | The manifest of a list source: live generation and chunk count, and the replaced one |
| `C#<kind>#<source>#<gen>#<n>` | `Domains` | Chunk `n` of a generation: domains joined by newlines |
| `S#index` | `Sources` (JSON array of `<kind>#<source>`), `Ver` | Index of sources, updated with compare-and-set on `Ver` |
| `L#version` | `Value` | The `listVersion` token (a UUID) |
| `M#<key>` | `Value` | Sync state and other meta values |

An emptied source keeps a manifest with zero chunks and its index member, because removing either could race a writer that is re-creating the source.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `emailVerification.store` | `string` | `'MemoryEmailVerificationStore'` | `'DynamoDbEmailVerificationStore'` | Selects this store |
| `emailVerification.dynamodb.table` | `string` | `'email-verification'` | At least 3 characters | Table name |
| `emailVerification.dynamodb.config` | `DynamoDBClientConfig` | `{}` | AWS SDK client options | Region, credentials, endpoint |
| `emailVerification.dynamodb.createTable` | `boolean` | `true` | | Create the table and enable TTL when missing |

```ts
export default {
  emailVerification: {
    store: 'DynamoDbEmailVerificationStore',
    dynamodb: {
      table: 'shop-email-verification',
      createTable: false,
      config: { region: 'eu-central-1' },
    },
  },
};
```

## Damaged-source error

If a chunk is missing while the manifest has not changed, the data is damaged (for example an item was deleted by hand). `loadLists()` logs and skips that source, and `upsertEntries` or `removeEntries` on it throws (`replaceSource` does not read the old chunks):

```
email domain list S#block#disposable-email-domains is damaged (chunk 2 of generation <id> is missing); delete that item to reset the source
```

To recover, run `email-verification:sync` for the source (`replaceSource` writes a fresh generation), or delete the manifest item named in the message. A missing chunk found while the manifest *did* change is a race with another writer, not damage; it is retried silently.

## Important behaviour

- Reads of lists and manifests are strongly consistent; verdict reads are eventually consistent.
- A writer that crashes after its manifest swap leaves its replaced generation behind; the next write to that source deletes it. A crash before the swap leaks that generation's chunks.
- The role needs `GetItem`, `PutItem` and `DeleteItem`; with `createTable: true` also `DescribeTable`, `CreateTable`, `DescribeTimeToLive` and `UpdateTimeToLive`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Store | `EmailVerificationStore`, singleton, by class name | `DynamoDbEmailVerificationStore` | Memory, ORM, Redis | Subclass and override `createClient(cfg)` to build a custom `DynamoDBClient`; decorate with `@Injectable(EmailVerificationStore)` and set `emailVerification.store` to the subclass name. See [custom stores](../email-verification/07-custom-verifiers-and-stores.md#custom-emailverificationstore). |

## Related

- [Choosing a store](../email-verification/06-choosing-a-store.md)
- [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/02-client-and-table-provisioning.md): the same provisioning pattern for sessions.
