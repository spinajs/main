# TimeSpan

`TimeSpan` is an immutable duration stored as milliseconds, modelled after .NET `TimeSpan`. Every operation returns a new instance. APIs across SpinaJS, including every resilience option, accept a `TimeSpanLike` and normalize it with `TimeSpan.parse`.

## How it works

1. Create a span with a factory (`fromSeconds`, `fromTime`, ...), the constructor (raw milliseconds), or `TimeSpan.parse(value)`.
2. `parse` normalizes a `TimeSpanLike`:

| Input | Result | Example |
| --- | --- | --- |
| `TimeSpan` | The same instance | `TimeSpan.fromHours(2)` |
| `number` | That many milliseconds | `5000` is 5 s |
| `string` `"[d.]hh:mm[:ss[.fff]]"` | Parsed components | `'1.02:30:45.123'` |
| `TimeLike` object `{ days?, hours?, minutes?, seconds?, milliseconds? }` | Sum of the components | `{ hours: 2, minutes: 30 }` |
| `Date` | Time elapsed from that date until now | `new Date(Date.now() - 5000)` is about 5 s |
| `''`, `null`, `undefined` | `null` | |

3. Read it with component getters or `total*` getters, combine it with arithmetic, compare it, or format it.

`type TimeSpanLike = number | string | TimeLike | TimeSpan`.

## API

### Construction

| Member | Behaviour |
| --- | --- |
| `new TimeSpan(millis)` | Raw milliseconds; no validation, no rounding |
| `fromMilliseconds(v)`, `fromSeconds(v)`, `fromMinutes(v)`, `fromHours(v)`, `fromDays(v)` | `v` times the unit, rounded half away from zero to whole milliseconds |
| `fromTime(hours, minutes, seconds)` | Three numbers: a time of day or a duration |
| `fromTime(days, hours, minutes, seconds, milliseconds)` | Five numbers |
| `fromDate(date)`, `fromDateTime(dateTime)` | Elapsed time from a JS `Date` or Luxon `DateTime` until now |
| `between(a, b)` | `a - b` for two `Date`s or two `DateTime`s |
| `parse(value)` | See the table above; returns `TimeSpan \| null` |
| `ZERO`, `MAX_VALUE`, `MIN_VALUE` | `0`, `Number.MAX_SAFE_INTEGER` and `Number.MIN_SAFE_INTEGER` milliseconds |
| `MILLIS_PER_SECOND`, `MILLIS_PER_MINUTE`, `MILLIS_PER_HOUR`, `MILLIS_PER_DAY` | Unit constants |
| `TIMEZONE_OFFSET` | The local UTC offset as a span, read once on first access and cached |

### Reading

| Getter | Meaning |
| --- | --- |
| `milliseconds`, `seconds`, `minutes`, `hours` | The component, truncated toward zero: `fromMinutes(90).minutes` is `30` |
| `days` | Whole days, truncated toward zero |
| `totalMilliseconds`, `totalSeconds`, `totalMinutes`, `totalHours`, `totalDays` | The whole span in that unit, with fractions: `fromMinutes(90).totalHours` is `1.5` |

### Arithmetic and comparison

| Member | Behaviour |
| --- | --- |
| `add(ts)`, `subtract(ts)` | Take a `TimeSpan`, not a `TimeSpanLike` |
| `addDays`, `addHours`, `addMinutes`, `addSeconds`, `addMilliseconds` and the `subtract*` pairs | Take a number of units |
| `multiply(factor)`, `divide(divisor)` | `InvalidArgument` for a non-number or `NaN`; `divide(0)` throws `Error('Cannot divide TimeSpan by zero')` |
| `negate()`, `abs()`, `duration()` | Sign change; `duration()` is `abs()` |
| `equals(other)` | `true` only for a `TimeSpan` with the same milliseconds |
| `compareTo(other)` | `-1`, `0` or `1`; use it to sort |
| `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual` | Comparisons with another `TimeSpan` |
| `isBetween(start, end)` | Treats all three as times of day (modulo 24 h); a range that crosses midnight, eg. 22:00 to 02:00, works |
| `isTimeInRange(start, end)` | Same check against the time of day of two `Date`s (local time) or two `DateTime`s |

### Conversion

| Member | Returns |
| --- | --- |
| `toString()` | `[-][d.]hh:mm:ss[.fff]`; the day part only when non-zero, the milliseconds only when non-zero |
| `toJSON()` | `toString()` |
| `valueOf()` | Total milliseconds, so `+span` and `a.valueOf() < b.valueOf()` work |
| `toObject()` | `{ days, hours, minutes, seconds, milliseconds }` |
| `toDate(base?)` | `base` (default now) plus the span, as a `Date` |
| `toDateTime(base?)` | `base` (default now) plus the span, as a Luxon `DateTime` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TimeSpanLike` input | Not registered in DI; a type | `TimeSpan.parse` | `_toTimeSpan(value, fallback)` from the resilience primitives | Type your own options as `TimeSpanLike` and normalize them once with `TimeSpan.parse` or `_toTimeSpan` |

### Accept `TimeSpanLike` in your own API

Type duration options as `TimeSpanLike` so callers can pass milliseconds, a string from configuration, or a `TimeSpan`. Normalize once, in the constructor, and keep a `TimeSpan`. `_toTimeSpan(value, fallback)` returns `fallback` for `null`, `undefined` and `''`; a malformed string still throws.

```ts sample
import { TimeSpan, TimeSpanLike, _toTimeSpan } from '@spinajs/util';

interface CacheOptions {
  ttl?: TimeSpanLike;
}

class TtlCache<V> {
  private readonly ttl: TimeSpan;
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(options: CacheOptions = {}) {
    this.ttl = _toTimeSpan(options.ttl, TimeSpan.fromMinutes(5));
  }

  public set(key: string, value: V): void {
    this.entries.set(key, { value, expiresAt: this.ttl.toDate().getTime() });
  }

  public get(key: string): V | undefined {
    const e = this.entries.get(key);
    return e && e.expiresAt > Date.now() ? e.value : undefined;
  }
}

const fromConfig = new TtlCache<string>({ ttl: '00:10:00' });
const fromMs = new TtlCache<string>({ ttl: 30_000 });
const fromParts = new TtlCache<string>({ ttl: { hours: 1 } });

fromConfig.set('greeting', 'hello');
console.log(fromConfig.get('greeting'), fromMs, fromParts);
```

## Important behaviour

- `fromTime` has two overloads only. A call with four numbers does not compile; at runtime the fourth number is ignored.
- `parse` throws on a string without `:` (`Error('Invalid TimeSpan format...')`) and on non-numeric parts (`InvalidArgument`, code `NAN_VALUE`). It returns `null` only for empty input.
- Factories and `parse` throw `Error('TimeSpanTooLong')` beyond `Number.MAX_SAFE_INTEGER` milliseconds.
- `parse('1.5')`, a decimal without `:`, throws: one token is not a span.
- Fractional seconds are padded or truncated to three digits: `'00:00:01.1'` is 1100 ms, `'00:00:01.1234'` is 1123 ms.
- A leading `-` negates the whole span: `'-01:30:00'` is minus 90 minutes, so negative spans round-trip through `toString()` and `parse()` like positive ones.
- `toJSON()` produces a string. After `JSON.parse` you get the string back; call `TimeSpan.parse` on it.
- `TIMEZONE_OFFSET` is cached on first access and does not follow a later daylight saving change.
- Methods return `new TimeSpan(...)`: a subclass loses its type after any arithmetic. Write functions that take a `TimeSpan` instead of subclassing.

## Best practices

- Store and pass `TimeSpan`, convert to milliseconds only at the boundary (`setTimeout(fn, span.totalMilliseconds)`).
- Put human-readable strings such as `'00:00:30'` in configuration files; they parse into the same type.
- Compare with `compareTo` or `lessThan`; `equals` returns `false` for a number even when the milliseconds match.

## Patterns and antipatterns

```ts
// Don't: the fourth argument is not milliseconds; this does not compile and 123 is dropped at runtime
TimeSpan.fromTime(2, 30, 45, 123);

// Do
TimeSpan.fromTime(0, 2, 30, 45, 123);
```

## Examples

### Format durations and check a delivery window

```ts sample
import { TimeSpan } from '@spinajs/util';
import { DateTime } from 'luxon';

const transfer = TimeSpan.fromHours(2).add(TimeSpan.fromMinutes(30));
console.log(transfer.toString(), transfer.totalMinutes); // '02:30:00' 150

const parsed = TimeSpan.parse('1.02:30:45.123');
console.log(parsed?.days, parsed?.hours, parsed?.totalHours); // 1 2 26.51...

const spans = [TimeSpan.fromSeconds(90), TimeSpan.fromMinutes(1), TimeSpan.parse({ seconds: 30 })!];
console.log(spans.sort((a, b) => a.compareTo(b)).map((s) => s.toString())); // ['00:00:30', '00:01:00', '00:01:30']

const nightWindowStart = TimeSpan.fromTime(22, 0, 0);
const nightWindowEnd = TimeSpan.fromTime(2, 0, 0);
const now = DateTime.now();
const nowOfDay = TimeSpan.fromTime(now.hour, now.minute, now.second);
console.log('night delivery:', nowOfDay.isBetween(nightWindowStart, nightWindowEnd));

const eta = transfer.toDateTime(now);
console.log(eta.toISO(), TimeSpan.between(eta, now).totalHours); // ... 2.5
```

## Related

- [Resilience pipeline](07-resilience-pipeline.md): every delay and timeout option is a `TimeSpanLike`.
- [Process helpers](06-process-helpers.md): `sleep` and `withTimeout` take a `TimeSpanLike`.
- [Argument validation](01-argument-validation.md): `TimeSpan` validates its numeric inputs with `_is_number` and `_non_NaN`.
