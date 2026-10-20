# Plural forms

`Intl.__n(text, count)` picks the plural form of a phrase for `count`, using the CLDR plural rules of the locale from `make-plural`. Use it for every phrase that contains a number of things.

## How it works

1. `__n()` resolves the locale and phrase table like `__()`: a string `text` uses `CurrentLocale`; an `IPhraseWithOptions` uses its `locale`, and its table falls back to `CurrentLocale`.
2. When the phrase has no `%`, the locale has no table or the table lacks the phrase, `__n()` returns `__(text, count)`.
3. Otherwise it reads `table[phrase]` and computes the category with the `make-plural` rule of the locale: `zero`, `one`, `two`, `few`, `many` or `other`. A region locale such as `en-US` uses `en_US` when `make-plural` has it, else its language (`en`); a locale with no rule at all gets `other`.
4. When the category is not `other` and the phrase object has it, it formats `phrase[category]` with `count`.
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

`other` can hold several segments separated by `|`, each with an optional interval prefix. `__n()` uses it when the category of `count` is `other` or is missing from the phrase (step 5).

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

In `pl`, `few` is missing here, so `3` gives `'3 nowe wiadomości'`; `0` and `5` (`many`, missing) take the last segment: `'5 nowych wiadomości'`. A segment without a placeholder is returned as written, so a `[0] brak wiadomości` segment renders as `'brak wiadomości'`.

## Configuration

`__n()` reads no keys of its own. The locale comes from `intl.defaultLocale` (through `CurrentLocale`) or the `IPhraseWithOptions.locale`; see [Translating text](01-translating-text.md#configuration).

## Services and extension points

`__n()` is a method of the `Intl` service. To change plural selection, subclass `SpineJsInternationalizationFromJson` and override `__n()`; see [Custom `Intl` service](05-custom-intl-service.md).

## Important behaviour

- **A missing plural phrase falls back to `__()`.** When the table lacks the phrase, `__n('%d dogs', 2)` is `__('%d dogs', 2)`: `'2 dogs'`.
- **Region locales use the language rule.** `make-plural` exports language codes (`en`, `pl`) and a few regions (`pt_PT`), not `en-US`. A table named `en-US` uses the `en` rule.
- **`count` is the only format argument.** A form or segment with a placeholder (`%d`, `%s`, ...) is formatted with `count`; one without is returned as written: `"[1] one dir"` gives `'one dir'`.
- A phrase without `%` is never treated as plural: `__n('cats', 2)` is `__('cats', 2)`.

## Best practices

- Write every category the locale has (`one`, `few`, `many` for `pl`) instead of relying on `other` intervals; the categories always apply.
- Keep `%d` in every plural form that shows the number, including `one`; a form without a placeholder drops the count.

## Patterns and antipatterns

```ts
// Don't: end `other` with a prefixed segment; when nothing matches it is returned with its prefix
// en.json: { "%d files": { "one": "%d file", "other": "[0] no files|[2,] %d files" } }
intl.__n('%d files', 1.5); // "[2,] 1.5 files"

// Do: end with a segment without a prefix
// en.json: { "%d files": { "one": "%d file", "other": "[0] no files|%d files" } }
intl.__n('%d files', 0); // "no files"
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
