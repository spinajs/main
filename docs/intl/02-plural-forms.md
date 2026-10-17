# Plural forms

`Intl.__n(text, count)` picks the plural form of a phrase for `count`, using the CLDR plural rules of the locale from `make-plural`. Use it for every phrase that contains a number of things.

## How it works

1. `__n()` resolves the locale and phrase table like `__()`: a string `text` uses `CurrentLocale`; an `IPhraseWithOptions` uses its `locale`, and its table falls back to `CurrentLocale`.
2. When the phrase has no `%` or the locale has no table, `__n()` returns `__(text, count)`.
3. Otherwise it reads `table[phrase]` and computes the category: `MakePlural[locale](count)` gives `zero`, `one`, `two`, `few`, `many` or `other`.
4. When the phrase object has that category, it returns `util.format(phrase[category], count)`.
5. Otherwise, when it has `other`, it parses `other` with the [interval syntax](#interval-syntax) and formats the chosen segment with `count`.
6. Otherwise it returns `__(text, count)`.

A plural phrase is an object keyed by category:

```json
{
  "%d cats": {
    "one": "%d kot",
    "few": "%d koty",
    "other": "%d kotów"
  }
}
```

With `pl` as the locale: `__n('%d cats', 1)` gives `'1 kot'`, `3` gives `'3 koty'`, and `10` (category `many`, missing) falls to `other`: `'10 kotów'`.

### Categories per locale

The category names come from `make-plural`. A few examples:

| Locale | Categories | Example counts |
| --- | --- | --- |
| `en` | `one`, `other` | `1` is `one`; `0`, `2`, `5` are `other` |
| `pl` | `one`, `few`, `many`, `other` | `1` is `one`; `2` to `4` are `few`; `0`, `5` to `21` are `many`; fractions are `other` |
| `de` | `one`, `other` | as `en` |

A key the locale never produces is ignored (for example `two` in a `pl` phrase).

### Interval syntax

`other` can hold several segments separated by `|`, each with an optional interval prefix. `__n()` uses it only when the category of `count` is **missing** from the phrase (step 5).

| Prefix | Matches |
| --- | --- |
| `[0]` | exactly `0` |
| `[2,4]` | `2` to `4`, both included |
| `]0,3[` | `1`, `2` (both bounds excluded) |
| `[20,]` | `20` and more |
| `[,20]` | up to `20` |

1. Segments are tried left to right; the first segment whose interval contains `count` wins, without its prefix.
2. When none matches, the **last** segment is used as written, prefix included. End with a segment without a prefix.

```json
{
  "%d messages": {
    "one": "%d nowa wiadomość",
    "other": "[2,4] %d nowe wiadomości|[22,24] %d nowe wiadomości|%d nowych wiadomości"
  }
}
```

In `pl`, `few` is missing here, so `3` gives `'3 nowe wiadomości'`; `0` and `5` (`many`, missing) take the last segment: `'5 nowych wiadomości'`. A segment without `%d` still gets `count` appended (see [Important behaviour](#important-behaviour)), so a `[0] brak wiadomości` segment would render as `'brak wiadomości 0'`.

## Configuration

`__n()` reads no keys of its own. The locale comes from `intl.defaultLocale` (through `CurrentLocale`) or the `IPhraseWithOptions.locale`; see [Translating text](01-translating-text.md#configuration).

## Services and extension points

`__n()` is a method of the `Intl` service. To change plural selection (for example to support region codes or to parse intervals for every category), subclass `SpineJsInternationalizationFromJson` and override `__n()`; see [Custom `Intl` service](05-custom-intl-service.md).

## Important behaviour

- **A missing plural phrase throws.** When the locale has a table, the phrase contains `%` and the table lacks it, `__n()` reads a category of `undefined` and throws `TypeError: Cannot read properties of undefined`. `__()` returns the original phrase in the same case.
- **Region locales throw.** `make-plural` exports language codes (`en`, `pl`), not `en-US`. A loaded table named `en-US` makes `__n()` throw `TypeError: MakePlural[locale] is not a function`.
- **Intervals in `other` are skipped for `other` counts.** When `count` falls in the `other` category, `__n()` returns `phrase.other` as written, `|` and prefixes included. In `en` this is every count except `1`.
- **Upper bound inclusion follows the lower bound.** A `count` equal to the upper bound matches when the **lower** bound is inclusive: `[1,3[` matches `3`, `]1,3]` does not.
- **`count` is the only format argument.** A segment without `%d` gets `count` appended by `util.format`: `"[1] one dir"` formats to `'one dir 1'`.
- A phrase without `%` is never treated as plural: `__n('cats', 2)` is `__('cats', 2)`.

## Best practices

- Write every category the locale has (`one`, `few`, `many` for `pl`) instead of relying on `other` intervals; the categories always apply.
- Keep `%d` in every plural form, including `one`, so the count is placed and not appended.
- Name locale files by language code (`pl.json`, not `pl-PL.json`) when the phrases use `__n()`.

## Patterns and antipatterns

```ts
// Don't: in `en`, every count except 1 is `other`, so the interval text is returned raw
// en.json: { "%d files": { "one": "%d file", "other": "[0] no files|%d files" } }
intl.__n('%d files', 0); // "[0] no files|0 files"

// Do: handle zero in code, keep `other` plain
// en.json: { "%d files": { "one": "%d file", "other": "%d files" }, "no files": "no files" }
const label = count === 0 ? intl.__('no files') : intl.__n('%d files', count);
```

## Examples

### Show an unread-messages badge in the user's language

```ts sample
import { DI } from '@spinajs/di';
import { Intl } from '@spinajs/intl';

// pl.json: { "%d unread messages": { "one": "%d nieprzeczytana wiadomość", "few": "%d nieprzeczytane wiadomości", "many": "%d nieprzeczytanych wiadomości", "other": "%d nieprzeczytanej wiadomości" } }
// en.json: { "%d unread messages": { "one": "%d unread message", "other": "%d unread messages" } }
async function unreadBadge(count: number, locale: string): Promise<string> {
  const intl = await DI.resolve(Intl);

  if (count === 0) {
    return intl.__({ phrase: 'No unread messages', locale });
  }

  return intl.__n({ phrase: '%d unread messages', locale }, count);
}

unreadBadge(3, 'pl').then((badge) => console.log(badge)); // "3 nieprzeczytane wiadomości"
```

## Related

- [Translating text](01-translating-text.md): `__()`, the fallback rules and `CurrentLocale`.
- [Request language](04-request-language.md): `__translateNumber(lang)` binds `__n()` to a request language.
- [Custom `Intl` service](05-custom-intl-service.md): override `__n()`.
