# Collections, objects and JSON

Helpers for arrays, `Map` caches, plain-data objects, and JSON that keeps `Map`, `Set` and `Date` or sorts keys. All are plain functions with no state and no Node.js imports.

## How it works

### Arrays

| Function | Returns | Notes |
| --- | --- | --- |
| `toArray(val)` | `val` when it is an array, `[val]` for a truthy value, `[]` otherwise | `0`, `''` and `false` become `[]` |
| `chunk(arr, size)` | Consecutive slices of at most `size` | Takes a `readonly` array. Throws `Error('chunk size must be >= 1')` |
| `unique(arr)` | Duplicates removed, first occurrence kept | `Set` equality (`SameValueZero`) |
| `uniqueBy(arr, keyFn)` | Duplicates by `keyFn(item)` removed, first kept | Like lodash `uniqBy` |
| `groupBy(arr, keyFn)` | `Map<K, T[]>`, keys in first-seen order | `keyFn(item, index)` |
| `sortedUnique(items, compare?)` | A sorted copy without elements that compare equal to their predecessor | Takes any iterable. Default order is `<` / `>` (code units for strings); pass `compareCodePoints` for code-point order |

### `Map` get-or-create

| Function | Behaviour |
| --- | --- |
| `tryGetHash(map, key, onMissing)` | Async: when `key` is missing, awaits `onMissing()`, stores and returns the value |
| `tryGetHashSync(map, key, onMissing)` | Synchronous variant |
| `getOrInsert(map, key, factory)` | Same as `tryGetHashSync` |

### Objects

| Function | Behaviour |
| --- | --- |
| `isPlainObject(v)` | `true` for a non-null object that is not an array; class instances match |
| `isStrictPlainObject(v)` | `true` only when the prototype is `Object.prototype` or `null`: no arrays, no class instances |
| `UNSAFE_KEYS`, `isUnsafeKey(key)` | `__proto__`, `prototype` and `constructor`: keys that reach a prototype through assignment or a path |
| `defineOwn(target, key, value)` | Sets an own enumerable data property with `Object.defineProperty`, so `__proto__` becomes a plain key and no inherited setter runs |
| `getOwnPath(from, path)` | Reads a dotted path (or a segment list) over own properties only; inherited members and unsafe segments read as `undefined` |
| `copyPlainData(v, { maxDepth = 32, maxValues = 10_000 })` | A deep copy of primitives, arrays, Dates (any realm) and strict plain objects; unsafe keys dropped. Throws `TypeError` on a cycle or a non-data value (Map, class instance, function, symbol) and `RangeError` past a limit |
| `deepEqual(a, b, { maxWork = 10_000, maxDepth = 64 })` | Bounded structural equality of plain data; see [Important behaviour](#important-behaviour) |
| `deepMerge(base, over, { arrays = 'replace' })` | A new object: strict plain objects merge recursively, `undefined` in `over` keeps the base value, anything else replaces. `arrays: 'concat'` appends `over` items to base items, as configuration files merge. Unsafe keys dropped; throws `TypeError` on a cycle |
| `deepFreeze(v, { skipDates? })` | Freezes `v` and everything reachable through own enumerable properties, in place, and returns `v`. Buffers and typed arrays stay mutable; with `skipDates: true` Dates do too |
| `frozenCopy(v, maxDepth = 16)` | A frozen deep copy of plain data. `Date`s are copied and their setters throw. Values nested deeper than `maxDepth` become `undefined` |

### JSON with `Map`, `Set` and `Date`

| Function | Behaviour |
| --- | --- |
| `replacer(key, value)` | `JSON.stringify` replacer: a `Map` becomes `{ dataType: 'Map', value: [[k, v], ...] }`, a `Set` becomes `{ dataType: 'Set', value: [...] }`, a `Date` becomes `{ dataType: 'Date', value: iso }` (`value: null` for an invalid Date) |
| `reviver(key, value)` | `JSON.parse` reviver: restores those tagged objects |
| `jsonStringify(value, space?)` | `JSON.stringify(value, replacer, space)` |
| `jsonParse<T>(text)` | `JSON.parse(text, reviver)` |
| `safeParse<T>(text, fallback)` | `jsonParse`, but returns `fallback` for invalid JSON or a non-string input |
| `stableStringify(value)` | `JSON.stringify` with object keys sorted by code unit, so key order does not change the text; a stable input for a hash or cache key. A top-level `undefined` gives `'null'`; throws `TypeError` on a cycle or a `bigint` |

`ICustomDataType` is the tagged shape `{ dataType: string; value: any }`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| JSON replacer and reviver | Not registered in DI; functions | `replacer`, `reviver` (`Map`, `Set`, `Date`) | Your own pair | Wrap them: handle your types first, then delegate to `replacer` / `reviver`, using the same `{ dataType, value }` tag |
| `Map` cache factory | Argument | none | | Pass `onMissing` / `factory`; for a shared async cache store the promise, not the value (below) |

### Custom JSON types: add `BigInt` next to `Map` and `Set`

Use the same tag so one reviver restores every type. Check your types first, then delegate to the built-in functions. Pass `this` on with `replacer.call`: the Date tag reads the raw value from the holder.

```ts sample
import { ICustomDataType, replacer, reviver } from '@spinajs/util';

function appReplacer(this: unknown, key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { dataType: 'BigInt', value: value.toString() } satisfies ICustomDataType;
  }
  return replacer.call(this, key, value);
}

function appReviver(key: string, value: ICustomDataType): unknown {
  if (typeof value === 'object' && value !== null && value.dataType === 'BigInt') {
    return BigInt(value.value);
  }
  return reviver(key, value);
}

const ledger = { balances: new Map([['ann', 12_345_678_901_234_567_890n]]), tags: new Set(['vip']) };

const text = JSON.stringify(ledger, appReplacer);
const back = JSON.parse(text, appReviver) as typeof ledger;

console.log(text);
console.log(back.balances.get('ann'), back.tags.has('vip'));
```

## Important behaviour

- `reviver` converts **any** object with `dataType: 'Map'`, `'Set'` or `'Date'`, including your own data that happens to use that field name.
- `JSON.stringify` calls `toJSON()` before the replacer, so `replacer` reads a Date from the holder (`this`). Called as a plain function (`replacer(key, value)`, no holder) it cannot see the Date, which stays an ISO string. A `TimeSpan` always reaches it as a string and comes back as a string.
- `deepEqual` compares primitives by `Object.is` (`0` and `-0` differ), Dates by time, and arrays and plain objects by own enumerable data properties with equal key sets (`{ x: undefined }` is not `{}`); both sides must share a prototype. A Map, Set, typed array, boxed primitive or class instance is equal only to itself. It never runs a getter (a Proxy still runs its traps) and answers `false` past `maxWork` or `maxDepth`.
- `deepFreeze` does not freeze `Map` or `Set` contents: they are not own enumerable properties.
- `frozenCopy` turns a `Map`, `Set`, typed array or class instance into a plain object of its own enumerable properties; a `Map` or `Set` becomes `{}`. Its `Readonly<T>` type is only true for plain data.
- A frozen copy's `Date` blocks its setters, but `Date.prototype.setTime.call(d, 0)` still changes it.
- `tryGetHash` is not guarded against parallel calls: two callers missing the same key both run `onMissing`, and the second result overwrites the first.

## Best practices

- Use `frozenCopy` for configuration or audit payloads you hand to other code, so later mutation cannot change what you already passed.
- For a shared async cache use `getOrInsert(map, key, () => load(key))` with a `Map<K, Promise<V>>`: parallel callers then share one load.
- Use `safeParse` for untrusted input such as query parameters; it never throws.

## Patterns and antipatterns

```ts
// Don't: both concurrent requests load the same user
const user = await tryGetHash(users, id, () => db.loadUser(id));

// Do: cache the promise, so the second caller awaits the first load
const user = await getOrInsert(userLoads, id, () => db.loadUser(id));
```

## Examples

### Group, de-duplicate and batch records for an import

```ts sample
import { chunk, frozenCopy, getOrInsert, groupBy, jsonParse, jsonStringify, safeParse, uniqueBy } from '@spinajs/util';

type Row = { email: string; team: string; joined: Date };

const raw: Row[] = [
  { email: 'ann@example.com', team: 'core', joined: new Date('2026-01-10') },
  { email: 'ann@example.com', team: 'core', joined: new Date('2026-01-10') },
  { email: 'bob@example.com', team: 'web', joined: new Date('2026-02-01') },
];

const rows = uniqueBy(raw, (r) => r.email);
const byTeam = groupBy(rows, (r) => r.team);
const batches = chunk(rows, 500);

const loads = new Map<string, Promise<number>>();
const teamSize = (team: string) => getOrInsert(loads, team, async () => byTeam.get(team)?.length ?? 0);

const snapshot = frozenCopy({ teams: [...byTeam.keys()], batches: batches.length, at: new Date() });
const wire = jsonStringify({ seen: new Set(rows.map((r) => r.email)) });

teamSize('core').then((n) => console.log(n, snapshot, jsonParse<{ seen: Set<string> }>(wire).seen.size, safeParse<number[]>('not json', [])));
```

## Related

- [Strings, functions and type guards](13-strings-functions-and-type-guards.md): `memoize`, `once`, `isDefined` and other small helpers.
- [Async combinators](04-async-combinators.md): `_batch` and `_to_array`, the chainable counterparts of `chunk` and `toArray`.
