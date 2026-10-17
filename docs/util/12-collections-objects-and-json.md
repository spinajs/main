# Collections, objects and JSON

Helpers for arrays, `Map` caches, immutable objects, and JSON that keeps `Map` and `Set`. All are plain functions with no state.

## How it works

### Arrays

| Function | Returns | Notes |
| --- | --- | --- |
| `toArray(val)` | `val` when it is an array, `[val]` for a truthy value, `[]` otherwise | `0`, `''` and `false` become `[]` |
| `chunk(arr, size)` | Consecutive slices of at most `size` | Throws `Error('chunk size must be >= 1')` |
| `unique(arr)` | Duplicates removed, first occurrence kept | `Set` equality (`SameValueZero`) |
| `uniqueBy(arr, keyFn)` | Duplicates by `keyFn(item)` removed, first kept | Like lodash `uniqBy` |
| `groupBy(arr, keyFn)` | `Map<K, T[]>`, keys in first-seen order | `keyFn(item, index)` |

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
| `deepFreeze(v)` | Freezes `v` and everything reachable through own enumerable properties, in place, and returns `v`. Buffers and typed arrays stay mutable |
| `frozenCopy(v, maxDepth = 16)` | A frozen deep copy of plain data. `Date`s are copied and their setters throw. Values nested deeper than `maxDepth` become `undefined` |

### JSON with `Map` and `Set`

| Function | Behaviour |
| --- | --- |
| `replacer(key, value)` | `JSON.stringify` replacer: a `Map` becomes `{ dataType: 'Map', value: [[k, v], ...] }`, a `Set` becomes `{ dataType: 'Set', value: [...] }` |
| `reviver(key, value)` | `JSON.parse` reviver: restores those tagged objects |
| `jsonStringify(value, space?)` | `JSON.stringify(value, replacer, space)` |
| `jsonParse<T>(text)` | `JSON.parse(text, reviver)` |
| `safeParse<T>(text, fallback)` | `jsonParse`, but returns `fallback` for invalid JSON or a non-string input |

`ICustomDataType` is the tagged shape `{ dataType: string; value: any }`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| JSON replacer and reviver | Not registered in DI; functions | `replacer`, `reviver` (`Map`, `Set`) | Your own pair | Wrap them: handle your types first, then delegate to `replacer` / `reviver`, using the same `{ dataType, value }` tag |
| `Map` cache factory | Argument | none | | Pass `onMissing` / `factory`; for a shared async cache store the promise, not the value (below) |

### Custom JSON types: add `BigInt` next to `Map` and `Set`

Use the same tag so one reviver restores every type. Check your types first, then delegate to the built-in functions.

```ts sample
import { ICustomDataType, replacer, reviver } from '@spinajs/util';

function appReplacer(key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { dataType: 'BigInt', value: value.toString() } satisfies ICustomDataType;
  }
  return replacer(key, value);
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

- `reviver` converts **any** object with `dataType: 'Map'` or `'Set'`, including your own data that happens to use that field name.
- `JSON.stringify` calls `toJSON()` before the replacer: a `Date` or `TimeSpan` reaches the replacer as a string and comes back as a string.
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
