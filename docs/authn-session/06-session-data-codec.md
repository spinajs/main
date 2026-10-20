# Session data codec

`encodeSessionData` and `decodeSessionData` turn the `Data` map of a session into JSON text and back. Persistent stores (db, Redis, DynamoDB) use this one pair, so a value written by one store reads back the same in another, with `Map`, `Set` and luxon `DateTime` values intact. Use it in a store of your own; `MemorySessionStore` keeps live objects and does not use it.

## How it works

### Encode

1. `encodeSessionData(data)` wraps the map as `{ dataType: 'Map', value: [[key, value], ...] }`.
2. `JSON.stringify` runs with a replacer that tags luxon `DateTime` values as `{ dataType: 'DateTime', value: <ISO string> }`, and `Map` and `Set` values through the shared replacer of `@spinajs/util`.
3. The result is a string.

### Decode

`decodeSessionData(data)` accepts two inputs:

| Input | Where it comes from | How it is decoded |
| --- | --- | --- |
| A string | `encodeSessionData` output, read from a text column, Redis or DynamoDB | `JSON.parse` with the matching reviver |
| A non-null object | A MySQL `json` column, which `mysql2` hands back already parsed | A walk over the object graph that applies the same tags |

1. Tags are revived bottom-up, children before parents, in the same order on both paths: `DateTime` first, then `Map` and `Set`.
2. Values that are already live `Map`, `Set` or `DateTime` instances pass through unchanged.
3. A result that is not a `Map` (valid JSON of another shape) becomes an empty `Map`.
4. Any other input (`null`, `undefined`, a number) throws `InvalidArgument('Cannot decode session data: ...')`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `encodeSessionData(data: Map<string, unknown>): string` | exported function, no DI | | | Call it from your store's write path |
| `decodeSessionData(data: string \| unknown): Map<string, unknown>` | exported function, no DI | | | Call it from your store's read path with whatever the backend returns |

## Important behaviour

- **Symmetric.** What `encodeSessionData` writes, `decodeSessionData` reads back with the same types, from either the string or the parsed object form.
- **Fails loudly.** A missing or malformed payload throws instead of decoding as an empty session. An empty session would read as signed-in-but-anonymous on every request and log out the whole user base without an error.
- **`__proto__` is data.** A payload with a literal `__proto__` key gets it as an own property on both paths; the result's prototype never changes.
- **Plain JSON types only otherwise.** Class instances other than `Map`, `Set` and `DateTime` come back as plain objects. A JS `Date` comes back as its ISO string.

## Best practices

- Store `DateTime` values from luxon, not JS `Date`, when a session entry must come back as a date.
- Hand `decodeSessionData` the raw column value; do not `JSON.stringify` a parsed `json` column first.

## Patterns and antipatterns

```ts
// Don't: a null column becomes an empty session, and the user looks anonymous with no error
const data = row.Data ? decodeSessionData(row.Data) : new Map();

// Do: let a broken row fail
const data = decodeSessionData(row.Data);
```

## Examples

### Round-trip a session's data through a text column

```ts sample
import { DateTime } from 'luxon';
import { decodeSessionData, encodeSessionData } from '@spinajs/authn-session';

const data = new Map<string, unknown>([
  ['Cart', new Set(['SKU-1042', 'SKU-2210'])],
  ['CheckoutStartedAt', DateTime.fromISO('2026-10-20T09:15:00Z')],
]);

const column: string = encodeSessionData(data);
const restored = decodeSessionData(column);

export const cartIsSet = restored.get('Cart') instanceof Set;
export const startedIsDateTime = DateTime.isDateTime(restored.get('CheckoutStartedAt'));
```

## Related

- [Writing a session store](05-writing-a-session-store.md): where the codec fits in a store.
- [`@spinajs/session-provider-db`](../session-provider-db/01-db-session-store.md): reads `user_sessions.Data` as text or as a `json` column.
- [Session stores](04-session-stores.md): the `ISession.Data` field.
