# Built-in helpers

`HandlebarsRenderer` registers 95 helpers for translation, comparison, text, math and dates. They work in every template the renderer compiles, as plain expressions (`{{uppercase name}}`) and as subexpressions (`{{#if (gt total 100)}}`).

The helper functions are **not** exported from `@spinajs/templates-handlebars`; you call them only from templates.

## How it works

1. `HandlebarsRenderer.resolve()` runs once, when DI first builds the singleton (usually when `Templates` resolves its renderer list).
2. It walks every function exported by the package's internal `helpers` module and calls `Handlebars.registerHelper(name, fn)` on the default `handlebars` environment.
3. A template calls a helper by name. Handlebars passes the arguments, then its own `options` object as the last argument.
4. Helpers with an optional last parameter detect that `options` object and use their default instead (`{{truncate title 20}}` uses `"..."`).

## Translation

They translate with [`@spinajs/intl`](../intl/01-translating-text.md). `__` and `__n` use the render language (`@root.lang`); `__l` and `__h` list every loaded locale.

| Helper | Usage | Result |
| --- | --- | --- |
| `__` | `{{__ "Hello %s" name}}` | The phrase in the render language, extra arguments filling its placeholders; falls back as `Intl.__()` does |
| `__n` | `{{__n "%d unread messages" unread}}` | The plural form for `unread` in the render language; see [Plural forms](../intl/02-plural-forms.md) |
| `__l` | `{{__l "language.name"}}` | The phrase in every loaded locale, as an array (renders comma-joined) |
| `__h` | `{{__h "language.name"}}` | One `{ index: value }` object per locale; see [Translating text](../intl/01-translating-text.md#important-behaviour) |

`__` passes every argument after the phrase to `Intl.__()`, so `{{__ "Hello %s, you have %d new orders" user.name count}}` fills the `util.format` placeholders.

## Comparison and logic

| Helper | Usage | Result |
| --- | --- | --- |
| `eq`, `ne` | `{{#if (eq status "paid")}}` | `===`, `!==` |
| `lt`, `gt`, `lte`, `gte` | `{{#if (gte stock 1)}}` | `<`, `>`, `<=`, `>=` |
| `compare` | `{{#if (compare a ">=" b)}}` | `==`, `===`, `!=`, `!==`, `<`, `>`, `<=`, `>=`; any other operator gives `false` |
| `between` | `{{#if (between age 18 65)}}` | `min <= value <= max` |
| `and`, `or` | `{{#if (and isActive (not isBanned))}}` | Every / some argument truthy; takes any number of arguments |
| `not` | `{{#unless (not visible)}}` | `!value` |
| `isTruthy`, `isFalsy` | `{{#if (isFalsy note)}}` | `!!value`, `!value` |
| `isNil` | `{{#if (isNil deletedAt)}}` | `null` or `undefined` |
| `isEmpty`, `isNotEmpty` | `{{#if (isEmpty items)}}` | `null`, `undefined`, `""`, `[]` or an object with no own keys |
| `includes` | `{{#if (includes roles "admin")}}` | Array contains the value, or string contains the substring; `false` for other types |
| `startsWith`, `endsWith` | `{{#if (endsWith email "@example.com")}}` | `false` when either argument is not a string |
| `isOdd`, `isEven` | `{{#if (isOdd @index)}}` | Parity of a number; stripe table rows with `@index` |

## Text

| Helper | Usage | Result |
| --- | --- | --- |
| `uppercase`, `lowercase` | `{{uppercase code}}` | Case-converted string |
| `capitalize` | `{{capitalize "hello world"}}` | `Hello world` |
| `capitalizeWords` | `{{capitalizeWords "hello world"}}` | `Hello World` |
| `truncate` | `{{truncate title 20}}`, `{{truncate title 20 "…"}}` | First 20 characters plus the suffix (default `...`); the suffix is not counted in the length |
| `truncateWords` | `{{truncateWords summary 12}}` | First 12 words plus the suffix (default `...`) |
| `reverse` | `{{reverse "abc"}}` | `cba` |
| `repeat` | `{{repeat "*" 5}}` | `*****`; a negative count gives `""` |
| `replace` | `{{replace phone " " ""}}` | Every occurrence replaced; plain text, not a regular expression |
| `trim`, `trimLeft`, `trimRight` | `{{trim name}}` | Whitespace removed |
| `split` | `{{#each (split tags ",")}}` | An array of parts |
| `join` | `{{join tags " · "}}` | Array joined (default separator `, `); `""` for a non-array |
| `substring` | `{{substring sku 0 3}}` | `String.prototype.substring` |
| `length` | `{{length items}}` | Array length, or string length |
| `padLeft`, `padRight` | `{{padLeft invoiceNo 6 "0"}}` | Padded to the length (default pad character: space) |
| `__textRight` | `{{__textRight label 20}}` | Right-aligned in 20 columns; cut when longer |
| `__textCenter` | `{{__textCenter label 20}}` | Centered in 20 columns, extra space on the right; cut when longer |
| `stripHtml` | `{{stripHtml description}}` | Tags removed with `<[^>]*>` |
| `escapeHtml` | `{{escapeHtml snippet}}` | `&`, `<`, `>`, `"`, `'` escaped once, as a `SafeString`, so `{{ }}` does not escape it again |
| `slugify` | `{{slugify "Hello World!"}}` | `hello-world` |
| `camelCase`, `snakeCase`, `kebabCase` | `{{snakeCase "helloWorld"}}` | `helloWorld`, `hello_world`, `hello-world` |

`null` and `undefined` arguments become `""` in every text helper.

## Math

Non-numeric arguments count as `0`.

| Helper | Usage | Result |
| --- | --- | --- |
| `add`, `multiply`, `sum` | `{{add subtotal shipping tax}}` | Sum or product of any number of arguments |
| `subtract` | `{{subtract total discount}}` | `a - b` |
| `divide` | `{{divide total count}}` | `a / b`; `0` when the divisor is `0` |
| `modulo` | `{{modulo @index 3}}` | `a % b`; `0` when the divisor is `0` |
| `percentage` | `{{percentage done total}}` | `value / total * 100`; `0` when the total is `0` |
| `abs`, `round`, `floor`, `ceil`, `sqrt` | `{{round rating}}` | `Math.*` |
| `pow` | `{{pow 2 10}}` | `1024` |
| `toFixed` | `{{toFixed price 2}}` | A string with 2 decimals |
| `toInt` | `{{toInt "ff" 16}}` | `parseInt` with the radix (default 10); `0` when it fails |
| `min`, `max`, `avg` | `{{max a b c}}` | Of any number of arguments; `avg` of none is `0` |
| `clamp` | `{{clamp score 0 100}}` | Value limited to the range |
| `random` | `{{random}}` | `Math.random()` |
| `randomInt` | `{{randomInt 1 6}}` | Integer in the inclusive range |
| `formatNumber` | `{{formatNumber total @root.lang}}` | `toLocaleString(locale)`; default locale `en-US` |
| `currency` | `{{currency total "PLN" @root.lang}}` | Currency format; defaults `USD` and `en-US` |

## Dates

Date arguments accept a JS `Date`, a luxon `DateTime` or an ISO 8601 string. Formats are [luxon format tokens](https://moment.github.io/luxon/#/formatting?id=table-of-tokens). Helpers that return a date return an ISO string, so you can nest them.

| Helper | Usage | Result |
| --- | --- | --- |
| `formatDate` | `{{formatDate createdAt "dd.MM.yyyy HH:mm"}}` | Formatted date; an unparsable string is returned as is; other types give `""` |
| `now` | `{{now "yyyy"}}` | Current time, formatted, or ISO without a format |
| `dateRelative` | `{{dateRelative lastLoginAt}}` | `2 days ago`, `in 3 hours` |
| `dateAdd`, `dateSubtract` | `{{dateAdd createdAt 14 "days"}}` | ISO string; units `year(s)`, `month(s)`, `week(s)`, `day(s)`, `hour(s)`, `minute(s)`, `second(s)`; an unknown or missing unit means days |
| `dateDiff` | `{{dateDiff start end "hours"}}` | Whole units from the first date to the second, rounded down; default unit `days` |
| `dateBefore`, `dateAfter` | `{{#if (dateBefore dueAt (now))}}` | Compares the exact instants; `false` when either date is invalid |
| `dateBetween` | `{{#if (dateBetween day start end)}}` | `start` before `day` and `day` before `end` |
| `dateStartOf`, `dateEndOf` | `{{dateStartOf day "month"}}` | ISO string; units `year`, `month`, `week`, `day`, `hour`, `minute`, `second`; an unknown or missing unit means day |
| `dateISO` | `{{dateISO createdAt}}` | ISO string; an unparsable string is returned as is |
| `timestamp`, `unixTimestamp` | `{{timestamp createdAt}}` | Milliseconds / seconds since epoch; now without an argument |
| `fromTimestamp` | `{{fromTimestamp ts "dd.MM.yyyy"}}` | Formatted date from milliseconds, or ISO without a format |
| `year`, `month`, `day`, `hour`, `minute`, `weekday` | `{{year createdAt}}` | Component; `weekday` 1 = Monday; `0` for invalid input |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Helper registry | Default `handlebars` environment, filled by `HandlebarsRenderer.resolve()` | The 95 helpers above | Your own helpers | `Handlebars.registerHelper(name, fn)`; register after the renderer resolves to replace a built-in. See [Custom helpers and partials](03-custom-helpers-and-partials.md) |
| Translation backend | `Intl` from `@spinajs/intl`, read with `DI.get(Intl)` on every call | `SpineJsInternationalizationFromJson` | Any `Intl` subclass | See [Custom `Intl` service](../intl/05-custom-intl-service.md) |

## Important behaviour

- **Dates and numbers do not follow the render language.** `formatDate`, `dateRelative` and month names use luxon's default locale; `formatNumber` and `currency` default to `en-US`. Pass `@root.lang` to `formatNumber` and `currency`; for dates, add a [custom helper](03-custom-helpers-and-partials.md#format-dates-in-the-render-language).
- **Output is HTML-escaped.** Helper results under `{{ }}` are escaped, except `escapeHtml`, which returns a `SafeString`. `{{split ...}}` and `{{__l ...}}` render arrays comma-joined.
- **Division by zero does not fail.** `{{divide 10 0}}` renders `0`.
- **Missing required arguments can throw.** `{{dateAdd createdAt}}` throws: the amount position receives Handlebars' `options` object.
- **luxon `DateTime` values must come from the same luxon copy.** The helpers test `instanceof DateTime`; a value from another installed copy renders `""`. ISO strings and `Date` always work.
- **Helpers are global.** They are registered on the default `handlebars` module, so code elsewhere in the process that uses that module sees them too.

## Best practices

- Prefer subexpressions over nested `{{#if}}` blocks: `{{#if (and (gt stock 0) (not discontinued))}}`.
- Pass `@root.lang` to `currency` and `formatNumber` so amounts follow the mail's language.
- Store dates in the model as ISO strings or `Date`; they work with every date helper.
- Use `padLeft` for fixed-width numbers (`{{padLeft invoiceNo 6 "0"}}`) and `__textRight` / `__textCenter` for plain-text receipts.

## Patterns and antipatterns

```handlebars
{{!-- Don't: triple braces skip escaping --}}
<pre>{{{code}}}</pre>

{{!-- Do: plain {{ }} already escapes --}}
<pre>{{code}}</pre>
```

```handlebars
{{!-- Don't: a split phrase cannot change word order in translation --}}
{{__ "Hello"}} {{name}}

{{!-- Do --}}
{{__ "Hello %s" name}}
```

## Examples

### Render an order summary mail

```ts sample
import '@spinajs/templates-handlebars';
import { join } from 'path';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';

// order-summary.handlebars:
//   <h2>{{__ "Order"}} {{padLeft number 6 "0"}}</h2>
//   {{#each lines}}
//     <tr class="{{#if (isEven @index)}}even{{/if}}">
//       <td>{{truncate name 40}}</td>
//       <td>{{qty}} × {{currency price "PLN" @root.lang}}</td>
//     </tr>
//   {{/each}}
//   {{#if (gt shipping 0)}}<p>{{__ "Shipping"}}: {{currency shipping "PLN" @root.lang}}</p>{{/if}}
//   <p>{{__ "Delivery by"}} {{formatDate (dateAdd placedAt 3 "days") "dd.MM.yyyy"}}</p>
async function renderOrderSummary() {
  const templates = await DI.resolve(Templates);

  return await templates.render(
    join(process.cwd(), 'templates', 'order-summary.handlebars'),
    {
      number: 42,
      placedAt: new Date('2026-10-17T09:00:00Z'),
      shipping: 15,
      lines: [
        { name: 'Mechanical keyboard', qty: 1, price: 449 },
        { name: 'USB-C cable, 2 m', qty: 2, price: 39.9 },
      ],
    },
    'pl',
  );
}

void renderOrderSummary();
```

## Related

- [Custom helpers and partials](03-custom-helpers-and-partials.md): add helpers the list lacks, or replace one.
- [Rendering templates](01-rendering-templates.md#template-context): where `@root.lang` comes from.
- [Translating text](../intl/01-translating-text.md): fallback rules behind `__`.
