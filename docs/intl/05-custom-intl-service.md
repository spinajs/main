# Custom `Intl` service

`Intl` is an abstract DI service: every caller (`__()` globals, `__translate*` helpers, templates, `@spinajs/cli`) goes through whatever is registered under the `Intl` key. Subclass the default to change one rule, or implement `Intl` from scratch to use another translation engine.

## How it works

1. Importing `@spinajs/intl` registers `SpineJsInternationalizationFromJson` with `@Injectable(Intl)`: key `Intl`, singleton (the DI default).
2. A later `DI.register(MyIntl).as(Intl)` adds a registration under the same key. A single resolve takes the **last** registration, so yours wins.
3. The first `await DI.resolve(Intl)` builds that class and awaits its `resolve()` (it is an `AsyncService`). The instance is cached.
4. `DI.get(Intl)` returns the cached instance. The globals and helpers call it on every translation, so they always reach your implementation.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Intl` | `Intl` key; singleton; `AsyncService` resolved with `await DI.resolve(Intl)`; registered by `@Injectable(Intl)` when `@spinajs/intl` is imported | `SpineJsInternationalizationFromJson` | `ElectronRendererIntl` in `@spinajs/electron`: a renderer proxy that only implements `__()` (see [Renderer services](../electron/03-renderer-services.md#intl-and-electronrendererintl)) | Replace: `DI.register(MyIntl).as(Intl)` after importing `@spinajs/intl` and before the first resolve. Extend: subclass `SpineJsInternationalizationFromJson` and override `__`, `__n`, `__l`, `__h` or `resolve()` |

### What the abstract class gives you

| Member | Kind | Meaning |
| --- | --- | --- |
| `__(text, ...args)` | abstract | Translate one phrase |
| `__n(text, count)` | abstract | Translate a plural phrase |
| `__l(text)` | abstract | The phrase in every locale, as an array |
| `__h(text)` | abstract | The phrase in every locale, as `{ key: value }` objects |
| `CurrentLocale` | getter and setter | Rejects an empty value with `InvalidArgument` |
| `Locales` | public field, `{}` | The phrase tables; yours to fill |
| `resolve()` | from `AsyncService` | Async initialisation; call `super.resolve()` first |

### What `SpineJsInternationalizationFromJson` adds

| Member | Override to |
| --- | --- |
| `resolve()` | Change how tables are loaded; call `super.resolve()` to keep `intl.defaultLocale` and the sources |
| `__()`, `__n()`, `__l()`, `__h()` | Change lookup, fallback or formatting; call `super` for the default |
| `Log` (protected, `@Logger('Intl')`) | Log from your overrides |
| `Configuration` (protected, `@Autoinject()`) | Read your own `intl.*` keys |

Register a subclass with `DI.register(MySubclass).as(Intl)`. A subclass that has its own `@Autoinject` or `@Logger` members gets the singleton default, which is what `Intl` needs (see [Lifetimes](../di/04-lifetimes.md)).

### Extend: fall back to the default locale per phrase

The default `__()` returns the original phrase when the current locale lacks it. This subclass tries `intl.defaultLocale` first and logs each missing phrase once.

```ts sample
import { DI } from '@spinajs/di';
import { IPhraseWithOptions, Intl, SpineJsInternationalizationFromJson } from '@spinajs/intl';

class FallbackIntl extends SpineJsInternationalizationFromJson {
  private reported = new Set<string>();

  public __(text: string | IPhraseWithOptions, ...args: any[]): string {
    const phrase = typeof text === 'string' ? text : text.phrase;
    const locale = typeof text === 'string' ? this.CurrentLocale : text.locale;
    const table = (this.Locales as Record<string, Record<string, unknown>>)[locale];

    if (phrase && table && table[phrase] === undefined) {
      const fallback = this.Configuration.get<string>('intl.defaultLocale', 'en');
      this.reportMissing(locale, phrase);
      return super.__({ phrase, locale: fallback }, ...args);
    }

    return super.__(text, ...args);
  }

  private reportMissing(locale: string, phrase: string) {
    const key = `${locale}:${phrase}`;
    if (!this.reported.has(key)) {
      this.reported.add(key);
      this.Log.warn(`Missing translation for "${phrase}" in ${locale}`);
    }
  }
}

DI.register(FallbackIntl).as(Intl);

async function main() {
  const intl = await DI.resolve(Intl);
  console.log(intl.__({ phrase: 'Checkout', locale: 'pl' }));
}

main();
```

### Reload phrases without a restart

Sources run once, in `resolve()`. To pick up edited files or database rows, re-run the sources and swap `Locales` in one assignment, so concurrent calls never see an empty table.

```ts sample
import _ from 'lodash';
import { DI } from '@spinajs/di';
import { Intl, SpineJsInternationalizationFromJson, TranslationSource } from '@spinajs/intl';

class ReloadableIntl extends SpineJsInternationalizationFromJson {
  public async reload(): Promise<void> {
    const sources = await DI.resolve(Array.ofType(TranslationSource));
    let locales = {};

    for (const source of sources) {
      // Same precedence as the initial load: earlier sources win.
      locales = _.merge(await source.load(), locales);
    }

    this.Locales = locales;
    this.Log.info(`Reloaded translations for ${Object.keys(locales).join(', ')}`);
  }
}

DI.register(ReloadableIntl).as(Intl);

async function main() {
  await DI.resolve(Intl);

  // eg. from an admin endpoint after translators publish changes
  const intl = DI.get(Intl) as ReloadableIntl;
  await intl.reload();
}

main();
```

### Replace: a pseudo-localisation `Intl` for UI testing

Implement `Intl` directly when the lookup has nothing in common with the default. This one wraps every phrase in brackets and accents, so untranslated or truncated UI text stands out during QA.

```ts sample
import * as util from 'util';
import { DI, Injectable } from '@spinajs/di';
import { IPhraseWithOptions, Intl } from '@spinajs/intl';

const ACCENTS: Record<string, string> = { a: 'á', e: 'é', i: 'í', o: 'ö', u: 'ü', A: 'Å', E: 'É', O: 'Ö' };

@Injectable(Intl)
class PseudoLocaleIntl extends Intl {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.CurrentLocale = 'en-XA';
  }

  public __(text: string | IPhraseWithOptions, ...args: any[]): string {
    const phrase = typeof text === 'string' ? text : text.phrase;
    if (!phrase) return '';

    const accented = phrase.replace(/%[sdjifoO%]|[aeiouAEO]/g, (m) => ACCENTS[m] ?? m);
    return `[${util.format(accented, ...args)}]`;
  }

  public __n(text: string | IPhraseWithOptions, count: number): string {
    return this.__(text, count);
  }

  public __l(text: string): string[] {
    return [this.__(text)];
  }

  public __h(text: string): any[] {
    return [{ [this.CurrentLocale]: this.__(text) }];
  }
}

async function main() {
  // Import this module only in the QA build; it registers after @spinajs/intl and wins.
  const intl = await DI.resolve(Intl);
  console.log(intl.__('Order %s shipped', 'A-1042')); // "[Ördér A-1042 shíppéd]"
}

main();
```

## Important behaviour

- **Register before the first resolve.** `Intl` is a cached singleton; a registration after `await DI.resolve(Intl)` changes nothing for callers that use `DI.get(Intl)`.
- **Your module must load after `@spinajs/intl`.** The last registration under `Intl` wins. Importing `@spinajs/intl` in your module before the `DI.register()` call guarantees the order.
- **Every abstract method is reachable.** The globals, the `__translate*` helpers and template engines call `__`, `__n`, `__l` and `__h`; implement all four, even when one only forwards to another.
- **`resolve()` must call `super.resolve()`.** It marks the service as resolved for the container.
- **`CurrentLocale` setter rejects empty values** with `InvalidArgument`; set it from a config key with a default.
- The DI key is the class name `Intl`. `@spinajs/electron` relies on this: its own abstract `Intl` lands on the same key in the renderer.

## Best practices

- Subclass `SpineJsInternationalizationFromJson` when you change one method; you keep the sources, `intl.defaultLocale` and the plural rules.
- Keep overrides synchronous: `__()` and the others return `string`, and template engines call them synchronously.
- Put loading in `resolve()` or a method like `reload()`, never in `__()`.

## Patterns and antipatterns

```ts
// Don't: resolves the default first, then registers; DI.get(Intl) keeps returning the old instance
await DI.resolve(Intl);
DI.register(FallbackIntl).as(Intl);

// Do: register during boot, then resolve once
DI.register(FallbackIntl).as(Intl);
await DI.resolve(Intl);
```

## Examples

### Translate in a test without locale files

```ts sample
import { DI } from '@spinajs/di';
import { IPhraseWithOptions, Intl } from '@spinajs/intl';

class InMemoryIntl extends Intl {
  public Locales: Record<string, Record<string, string>> = {
    en: { 'Order %s shipped': 'Order %s shipped' },
    pl: { 'Order %s shipped': 'Zamówienie %s zostało wysłane' },
  };

  public async resolve(): Promise<void> {
    await super.resolve();
    this.CurrentLocale = 'en';
  }

  public __(text: string | IPhraseWithOptions, ...args: any[]): string {
    const locale = typeof text === 'string' ? this.CurrentLocale : text.locale;
    const phrase = typeof text === 'string' ? text : text.phrase;
    const template = this.Locales[locale]?.[phrase] ?? phrase;
    return template.replace('%s', String(args[0] ?? ''));
  }

  public __n(text: string | IPhraseWithOptions, count: number): string {
    return this.__(text, count);
  }

  public __l(text: string): string[] {
    return Object.values(this.Locales).map((table) => table[text]);
  }

  public __h(text: string): any[] {
    return Object.entries(this.Locales).map(([locale, table]) => ({ [locale]: table[text] }));
  }
}

async function shippedNotificationTest() {
  DI.register(InMemoryIntl).as(Intl);
  const intl = await DI.resolve(Intl);

  const subject = intl.__({ phrase: 'Order %s shipped', locale: 'pl' }, 'A-1042');
  console.assert(subject === 'Zamówienie A-1042 zostało wysłane', subject);

  DI.clearCache();
}

shippedNotificationTest();
```

## Related

- [Translating text](01-translating-text.md): the default lookup and fallback rules.
- [Translation sources](03-translation-sources.md): what `resolve()` loads.
- [Registering services](../di/01-registering-services.md): which registration wins under one key.
- [Service lifecycle](../di/10-service-lifecycle.md): `AsyncService.resolve()`.
- [Renderer services](../electron/03-renderer-services.md#intl-and-electronrendererintl): the Electron renderer `Intl`.
