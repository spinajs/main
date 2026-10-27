# `@spinajs/intl`

Translates text phrases for SpinaJS apps. The `Intl` service loads phrase tables from translation sources (JSON and JS files by default), then answers `__()`, `__n()`, `__l()` and `__h()` calls, also exposed as global functions.

It does **not** detect the request language: [`@spinajs/intl-http`](#related-packages) writes it into the request store, and this package only reads it through `guessLanguage()`. It does **not** format numbers, dates or currencies; use the native ECMAScript `Intl` for that.

## Install

```sh
npm install @spinajs/intl
```

The package needs `@spinajs/configuration` (for `intl.defaultLocale` and `system.dirs.locales`) and a logger implementation from `@spinajs/log`: import `@spinajs/log` once in your app. Without it, the file sources throw `this.Log.trace is not a function` as soon as they find a locale file.

## Features

| Feature | What it does |
| --- | --- |
| [Translating text](01-translating-text.md) | The `Intl` service, `__()`, `__l()`, `__h()`, the global functions, `intl.defaultLocale` and the fallback rules |
| [Plural forms](02-plural-forms.md) | `__n()`: CLDR plural categories per locale and the interval syntax inside `other` |
| [Translation sources](03-translation-sources.md) | `TranslationSource`, the shipped JSON and JS file sources, `system.dirs.locales`, merge order, adding your own source |
| [Request language](04-request-language.md) | `guessLanguage()`, `defaultLanguage()`, `IIntlAsyncStorage` in `AsyncLocalStorage`, and the language-bound helpers `__translate*` for templates |
| [Custom `Intl` service](05-custom-intl-service.md) | Replacing or extending the `Intl` service: DI registration, which methods to override, shipped alternatives |

## Quick start

Put `en.json` and `pl.json` in a `locales` directory, list it in `system.dirs.locales`, and resolve `Intl`.

```ts sample
import '@spinajs/log';
import { join } from 'path';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';

// locales/pl.json: { "hello %s": "witaj %s", "%d cats": { "one": "%d kot", "few": "%d koty", "other": "%d kotów" } }
class AppConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      system: { dirs: { locales: [join(process.cwd(), 'locales')] } },
      intl: { defaultLocale: 'pl' },
    };
  }
}

async function main() {
  DI.register(AppConfiguration).as(Configuration);
  const intl = await DI.resolve(Intl);

  console.log(intl.__('hello %s', 'Anna')); // "witaj Anna"
  console.log(intl.__({ phrase: 'hello %s', locale: 'en' }, 'Anna')); // "hello Anna", from en.json
  console.log(intl.__n('%d cats', 3)); // "3 koty"
}

main();
```

## Related packages

- [`@spinajs/configuration`](../configuration/README.md): supplies `intl.*` and `system.dirs.locales`; this package ships its own `config/locales` file with the `intl` defaults.
- [`@spinajs/di`](../di/README.md): `Intl` is an `AsyncService` registered under the `Intl` key; sources are a [multi-implementation list](../di/06-multiple-implementations.md).
- `@spinajs/intl-http` (no docs folder yet): `IntHttpMiddleware` sets `req.storage.language` from the `lang` query parameter, cookie or `x-lang` header; `@Lang()` injects it into an action.
- `@spinajs/intl-orm` (no docs folder yet): `DbTranslationSource` adds phrases from the `IntlTranslation` model; `IntlQueryMiddleware` translates model queries to `guessLanguage()`.
- `@spinajs/templates`, `@spinajs/templates-pug`, `@spinajs/templates-handlebars` (no docs folders yet): render with `guessLanguage()` and expose `__`, `__n`, `__l`, `__h` built from the `__translate*` helpers.
- [`@spinajs/electron`](../electron/03-renderer-services.md#intl-and-electronrendererintl): `ElectronRendererIntl`, a renderer-side `Intl` that forwards `__()` to main over IPC.
- [`@spinajs/cli`](../cli/07-cli-service.md): `Cli.translate()` uses the global `__` when it exists.
