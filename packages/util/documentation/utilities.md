# Core utilities (`array`, `hash`, `json`, `string`, `func`, `types`)

Small, dependency-free helpers grouped by scope.

## `array`

```ts
import { toArray, chunk, unique, groupBy } from '@spinajs/util';

toArray(1);              // [1]
toArray([1, 2]);         // [1, 2]
toArray(null);           // []           (nil -> empty array)

chunk([1, 2, 3, 4, 5], 2); // [[1, 2], [3, 4], [5]]
unique([1, 1, 2, 3, 2]);   // [1, 2, 3]  (first-seen order)

// dedupe by a derived key (the key-based counterpart of unique; ~ lodash uniqBy)
uniqueBy([{ id: 1 }, { id: 1 }, { id: 2 }], (o) => o.id); // [{ id: 1 }, { id: 2 }]

groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'odd' : 'even'));
// Map { 'odd' => [1, 3], 'even' => [2, 4] }
```

`groupBy` returns a `Map` (keys keep insertion order) and passes the element index as a second argument to the key function.

## `hash` (Map get-or-compute)

```ts
import { tryGetHash, tryGetHashSync, getOrInsert } from '@spinajs/util';

// async: compute + cache a missing value
const conn = await tryGetHash(pool, key, async () => await connect(key));

// sync variants
const counter = tryGetHashSync(counters, 'hits', () => 0);
const bucket = getOrInsert(index, id, () => []); // alias of tryGetHashSync
bucket.push(item);
```

The factory runs **only** when the key is absent, and its result is stored before being returned.

## `json` (Map/Set-aware JSON)

Standard `JSON` drops `Map` and `Set`. These helpers preserve them via a tagged encoding.

```ts
import { jsonStringify, jsonParse, safeParse, replacer, reviver } from '@spinajs/util';

const state = { seen: new Set(['a', 'b']), counts: new Map([['a', 2]]) };

const text = jsonStringify(state);          // Map/Set encoded as tagged objects
const back = jsonParse<typeof state>(text); // Set and Map restored as real instances

// use the raw replacer/reviver with native JSON if you prefer
JSON.parse(JSON.stringify(state, replacer), reviver);

// never-throws parse with a fallback (also restores Map/Set on success)
safeParse<number[]>(req.query.ids, []); // [] on malformed / non-string input
```

## `string`

```ts
import { trimChar, capitalize, truncate, isNullOrWhitespace } from '@spinajs/util';

trimChar('__x__', '_');          // 'x'   (trim a specific char from both ends)
capitalize('hello');             // 'Hello'
capitalizeWords('hello world');  // 'Hello World'  (each word, spacing preserved)
truncate('the quick brown fox', 9);       // 'the quic…'
truncate('the quick brown fox', 9, '...'); // 'the qu...'
truncateWords('the quick brown fox', 2);  // 'the quick…'  (by word count)
isNullOrWhitespace('   ');       // true   (null/undefined/empty/whitespace)
```

`truncate`'s suffix (default `…`) counts toward the target length, so the result is never longer than `length`.

## `func`

```ts
import { Lazy, once, memoize, noop, identity } from '@spinajs/util';

// defer a computation until .call()
const config = Lazy.oF(() => readConfigFileSync());
config.call(null); // evaluated here

// run at most once, cache the result
const init = once(() => expensiveSetup());
init(); init(); // expensiveSetup runs a single time

// memoize by argument (or a custom key)
const fib = memoize((n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2)));
const byId = memoize((u: User) => render(u), (u) => u.id);

noop();        // does nothing
identity(x);   // returns x  (handy as a default callback)
```

## `types` (guards)

```ts
import { isPromise, isDefined, isFunction } from '@spinajs/util';

isPromise(fetch(url));   // true  (native Promises only)
isDefined(value);        // false for null/undefined — narrows away nil
[1, null, 2].filter(isDefined); // number[]
isFunction(cb);          // true for functions/classes
```
