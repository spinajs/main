# TimeSpan

A duration type modelled after .NET's `TimeSpan` — an **immutable** amount of time (stored internally as milliseconds) with rich construction, arithmetic, comparison and formatting. Every operation returns a **new** `TimeSpan`; instances are never mutated.

```ts
import { TimeSpan } from '@spinajs/util';
```

## The `TimeSpanLike` union

Most APIs (including the resilience strategies) accept a `TimeSpanLike`, which `TimeSpan.parse` normalizes:

```ts
type TimeSpanLike = number | string | TimeLike | TimeSpan;

interface TimeLike {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}
```

| Form | Meaning | Example |
|---|---|---|
| `number` | milliseconds | `5000` → 5 s |
| `string` | `"[d.]hh:mm[:ss[.fff]]"` | `"1.02:30:45.123"` |
| `TimeLike` | component object | `{ hours: 2, minutes: 30 }` |
| `TimeSpan` | returned as-is | `TimeSpan.fromHours(2)` |
| `Date` | *elapsed since that date* (via `parse`) | `new Date(Date.now() - 5000)` → ~5 s |

## Construction

```ts
new TimeSpan(1500);              // 1.5 s (raw milliseconds)

TimeSpan.fromMilliseconds(250);
TimeSpan.fromSeconds(30);
TimeSpan.fromMinutes(5);
TimeSpan.fromHours(2);
TimeSpan.fromDays(1);

// component form: (hours, minutes, seconds, milliseconds)
TimeSpan.fromTime(2, 30, 45);        // 02:30:45
TimeSpan.fromTime(2, 30, 45, 123);   // 02:30:45.123

// constants
TimeSpan.ZERO;
TimeSpan.MAX_VALUE;
TimeSpan.MIN_VALUE;
```

### Parsing

`parse` accepts any `TimeSpanLike` (or `Date`) and returns `TimeSpan | null` — `null` only for nullish input. Malformed **strings** throw:

```ts
TimeSpan.parse(5000)?.totalSeconds;        // 5
TimeSpan.parse('02:30:45')?.hours;         // 2
TimeSpan.parse('1.02:30:45.123')?.days;    // 1
TimeSpan.parse({ minutes: 90 })?.hours;    // 1

TimeSpan.parse(null);        // null
TimeSpan.parse('12:34');     // valid hh:mm (12 h 34 m)
TimeSpan.parse('invalid');   // throws 'Invalid TimeSpan format'
TimeSpan.parse('12');        // throws — a single token is not a span
```

> The string grammar is `"[d.]hh:mm[:ss[.fff]]"`. Two tokens (`hh:mm`) is the minimum; fewer throws. Fractional seconds are padded/truncated to milliseconds (`.1` → 100 ms, `.1234` → 123 ms).

## Component vs. total getters

Component getters give the *broken-down* part; `total*` give the *whole duration* in that unit:

```ts
const ts = TimeSpan.fromTime(1, 30, 0); // 1 h 30 m  (via hours, minutes)

ts.hours;         // 1     (component)
ts.minutes;       // 30    (component)
ts.totalHours;    // 1.5   (whole span in hours)
ts.totalMinutes;  // 90
ts.totalMilliseconds; // 5_400_000
```

Full set: `milliseconds`, `seconds`, `minutes`, `hours`, `days` (components) and `totalMilliseconds`, `totalSeconds`, `totalMinutes`, `totalHours`, `totalDays`.

## Arithmetic

All arithmetic returns a new `TimeSpan`:

```ts
const a = TimeSpan.fromHours(2);
const b = TimeSpan.fromMinutes(30);

a.add(b).totalHours;        // 2.5
a.subtract(b).totalHours;   // 1.5
a.multiply(3).totalHours;   // 6
a.divide(4).totalMinutes;   // 30
a.negate().totalHours;      // -2
a.abs();                    // absolute value (alias: duration())

// unit-specific helpers
a.addMinutes(15);
a.subtractSeconds(90);

TimeSpan.fromHours(6).divide(0); // throws 'Cannot divide TimeSpan by zero'
```

## Comparison

```ts
const a = TimeSpan.fromHours(1);
const b = TimeSpan.fromHours(2);

a.equals(b);                 // false
a.lessThan(b);               // true
a.greaterThanOrEqual(b);     // false
a.compareTo(b);              // -1  (a<b -> -1, equal -> 0, a>b -> 1)

// sort an array of spans
[b, a].sort((x, y) => x.compareTo(y)); // [a, b]

// is a span within an (inclusive) range of spans?
TimeSpan.fromMinutes(90).isBetween(TimeSpan.fromHours(1), TimeSpan.fromHours(2)); // true
```

Because `valueOf()` returns the raw milliseconds, the native `<`, `>`, `<=`, `>=` operators also work directly:

```ts
TimeSpan.fromHours(1) < TimeSpan.fromHours(2); // true
```

## Date / DateTime (Luxon) interop

```ts
import { DateTime } from 'luxon';

// duration between two instants
TimeSpan.between(new Date('2023-01-02'), new Date('2023-01-01')).totalDays; // 1
TimeSpan.between(DateTime.now(), DateTime.now().minus({ hours: 3 })).totalHours; // 3

// elapsed since a Date
TimeSpan.fromDate(new Date(Date.now() - 5000)).totalSeconds; // ~5

// project a span onto a base instant
const eta = TimeSpan.fromHours(2).toDateTime(DateTime.now()); // now + 2h
const at  = TimeSpan.fromHours(2).toDate(new Date());         // now + 2h (JS Date)

// wall-clock range check ("is this time-of-day within [start, end]?")
TimeSpan.fromTime(14, 30).isTimeInRange(new Date('2023-01-01T09:00:00'), new Date('2023-01-01T17:00:00'));
```

## Formatting & serialization

```ts
TimeSpan.fromTime(2, 30, 45).toString();       // '02:30:45'
TimeSpan.fromTime(2, 30, 45, 123).toString();  // '02:30:45.123'
TimeSpan.fromDays(1).add(TimeSpan.fromHours(2)).toString(); // '1.02:00:00'

TimeSpan.fromSeconds(10).valueOf();  // 10000  (milliseconds)
TimeSpan.fromTime(2, 30, 45).toJSON(); // '02:30:45'  (string, round-trips via parse)
TimeSpan.fromTime(1, 2, 3, 4).toObject(); // { days, hours, minutes, seconds, milliseconds }
```

`toString()` ⇄ `parse()` round-trips, so a `TimeSpan` survives `JSON.stringify`/`JSON.parse` when re-parsed.

## Using TimeSpan with resilience

Every resilience timing option is a `TimeSpanLike`, so all of these are equivalent:

```ts
new ResiliencePipelineBuilder()
  .addTimeout(5000)                        // ms
  .addTimeout('00:00:05')                  // string
  .addTimeout(TimeSpan.fromSeconds(5))     // TimeSpan
  .addRetry({ Delay: { seconds: 1 } });    // TimeLike
```

See [resilience.md](./resilience.md).
