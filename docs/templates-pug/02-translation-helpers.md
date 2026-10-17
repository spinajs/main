# Translation helpers

Every pug template gets four functions from `@spinajs/intl`, bound to the render language: `__` for a phrase, `__n` for plural forms, `__l` and `__h` for a phrase in every loaded locale. You translate inside the template instead of in the model.

## How it works

1. `CompiledTemplateRenderer.resolveLanguage(language)` picks the render language:
   1. the `language` argument of `render()`, `renderToFile()`, `compile()` or `compileToFile()`;
   2. else `guessLanguage()`: the `language` field of the `AsyncLocalStorage` store, set per request by `@spinajs/intl-http` or by your own `storage.run({ language }, ...)`;
   3. else `intl.defaultLocale`.
2. `PugRenderer.buildContext(model, language)` merges the model with the helpers into a new object:

   | Local | Built by | Signature | Result |
   | --- | --- | --- | --- |
   | `__` | `__translate(language)` | `(text: string \| IPhraseWithOptions, ...args)` | `Intl.__()` of `text` in the render language; `args` fill `%s`, `%d`, `%j` placeholders |
   | `__n` | `__translateNumber(language)` | `(text: string \| IPhraseWithOptions, count: number)` | `Intl.__n()`: the plural form for `count` in the render language |
   | `__l` | `__translateL` | `(text: string)` | `Intl.__l()`: the phrase in every loaded locale, as an array |
   | `__h` | `__translateH` | `(text: string)` | `Intl.__h()`: one `{ [key]: value }` object per loaded locale |

3. Each helper looks up the `Intl` service with `DI.get(Intl)` when the template calls it. `Templates` is decorated `@Inject(Intl)`, so resolving `Templates` resolves `Intl` first.

## Configuration

The helpers read `@spinajs/intl` settings; this package adds none.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `intl.defaultLocale` | `string` | `'en'` | A loaded locale | Render language when neither the argument nor the async context gives one |
| `system.dirs.locales` | `string[]` | see [`@spinajs/intl`](../intl/README.md) | Folders | Where the locale JSON files are loaded from |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Translation service behind the helpers | `Intl`, singleton, looked up with `DI.get(Intl)` on each call | `SpineJsInternationalizationFromJson` from `@spinajs/intl` | See [`@spinajs/intl`](../intl/README.md) | Register your own `Intl`; the helpers use it without changes here |
| Helper set | `PugRenderer.buildContext()` | the four helpers above | | Override `buildContext()` to add or rename helpers; see [Customizing `PugRenderer`](03-customizing-pug-renderer.md) |

## Important behaviour

- **The object form ignores the render language.** `__({ phrase: 'invoice.title', locale: 'de' })` translates to `de` whatever the render language is.
- **`__h` keys are array indexes, not locale codes**, because `Intl.__h()` maps over the locale list with the index. See [`@spinajs/intl`](../intl/01-translating-text.md#important-behaviour).
- **A missing translation falls back** to the default locale, then to the text itself; see [`@spinajs/intl`](../intl/01-translating-text.md).
- **Resolving `PugRenderer` on its own** without ever resolving `Intl` makes the first `__` call throw a `TypeError`: `DI.get(Intl)` returns `undefined`. Render through `Templates`.
- **The helpers overwrite model keys** named `__`, `__n`, `__l` or `__h`.
- **The language is fixed per render.** The cached compile is shared by every language; only the helpers change.

## Best practices

- Pass the language explicitly in queue jobs and CLI commands, or open an `AsyncLocalStorage` store; without either, every render uses `intl.defaultLocale`.
- Keep phrases as keys (`invoice.total`) and pass numbers to `__n`, not pre-formatted strings, so the plural rules of each locale apply.
- Use `#{__('key')}` for escaped output; use `!{__('key')}` only for translations you control that contain markup.

## Patterns and antipatterns

```ts
// Don't: translating in code before rendering splits the copy between code and template, and ignores plural rules
await templates.render(cartTemplate, { label: `${items.length} items` }, 'pl');

// Do: pass the number and let the template pick the plural form
await templates.render(cartTemplate, { count: items.length }, 'pl');
//   cart.pug:  p= __n('%d items', count)
```

## Examples

### Render a cart summary in the request language

In an HTTP action, `@spinajs/intl-http` already put the request language in the async context, so `render()` needs no language argument.

```ts sample
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-pug';

async function renderCartSummary(itemCount: number, customerName: string): Promise<string> {
  const templates = await DI.resolve(Templates);

  return await templates.render('fs://shop-templates/cart-summary.pug', { itemCount, customerName });
}
```

```pug
//- cart-summary.pug
h2= __('Hello %s', customerName)
p= __n('%d items', itemCount)
```

```json
// pl.json
{
  "Hello %s": "Witaj %s",
  "%d items": { "one": "%d produkt", "few": "%d produkty", "many": "%d produktów", "other": "%d produktu" }
}
```

### Render a mail in the recipient's language from a queue job

```ts sample
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { IIntlAsyncStorage } from '@spinajs/intl';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-pug';

interface ShipmentNotice {
  orderNo: string;
  recipientLanguage: string;
}

async function renderShipmentMail(notice: ShipmentNotice): Promise<string> {
  const storage = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<IIntlAsyncStorage>;

  // every render awaited inside the store uses the recipient's language
  return await storage.run({ language: notice.recipientLanguage }, async () => {
    const templates = await DI.resolve(Templates);
    return await templates.render('fs://mail-templates/shipment.pug', { orderNo: notice.orderNo });
  });
}
```

### List a label in every language

```pug
//- language-switcher.pug: one option per loaded locale, in locale load order
select(name='lang')
  each label in __l('language.name')
    option= label
```

## Related

- [Rendering pug templates](01-rendering-pug-templates.md): where `buildContext()` runs in the render flow.
- [`@spinajs/intl`](../intl/README.md): `Intl.__`, `__n`, `__l`, `__h`, locale files, plural rules.
- [`@spinajs/intl-http`](../intl-http/README.md): sets the request language that `guessLanguage()` reads.
