# `@spinajs/templates-handlebars`

The Handlebars engine for `@spinajs/templates`. Importing the package registers `HandlebarsRenderer`, which renders `.handlebars` files through the `Templates` service and adds 95 helpers: translation, comparison, text, math and date.

It does **not** register partials and does **not** load helpers or partials from files. It does **not** localize dates and numbers to the render language on its own; see [Built-in helpers](02-built-in-helpers.md#important-behaviour).

## Install

```sh
npm install @spinajs/templates-handlebars
```

The renderer needs `@spinajs/templates` (the `Templates` facade and the cache), `@spinajs/intl` (translation helpers and the render language) and `@spinajs/configuration`. `fs://` template URIs also need `@spinajs/fs` with a configured provider.

## Features

| Feature | What it does |
| --- | --- |
| [Rendering templates](01-rendering-templates.md) | `HandlebarsRenderer`: how `Templates` picks it, the render flow, the template context and `lang`, `fs://` sources, compile options, caching and errors |
| [Built-in helpers](02-built-in-helpers.md) | Every helper the renderer registers, its arguments, its output and its edge cases |
| [Custom helpers and partials](03-custom-helpers-and-partials.md) | Adding or overriding helpers and partials on the shared Handlebars environment, and when to register them |
| [Customizing the renderer](04-customizing-the-renderer.md) | `HandlebarsRenderer` in DI: replacing it, extending `buildContext()`, `compile()` and `resolve()`, serving another extension |

## Extension points at a glance

| Extension point | Mechanism | Page |
| --- | --- | --- |
| The Handlebars engine itself | `HandlebarsRenderer`, a singleton registered under `TemplateRenderer`; subclass it, `DI.unregister` the default, register yours | [Customizing the renderer](04-customizing-the-renderer.md#services-and-extension-points) |
| Template context | Override `buildContext(model, language)` | [Customizing the renderer](04-customizing-the-renderer.md#buildcontext-add-globals-to-every-template) |
| Compilation and runtime options | Override `compile(template)`; wrap the delegate to pass `RuntimeOptions` | [Customizing the renderer](04-customizing-the-renderer.md#compile-pre-process-sources-or-pass-runtime-options) |
| File extension and engine type | Override `Extension` and `Type` | [Customizing the renderer](04-customizing-the-renderer.md#type-and-extension-serve-hbs-files) |
| Helpers and partials | `Handlebars.registerHelper()` / `registerPartial()` on the default `handlebars` environment | [Custom helpers and partials](03-custom-helpers-and-partials.md) |
| Compile options | `templates.handlebars` config key | [Rendering templates](01-rendering-templates.md#configuration) |

## Quick start

Import the package once, then render through `Templates`. The engine is chosen by the `.handlebars` extension.

```ts sample
import '@spinajs/log';
import '@spinajs/templates-handlebars';
import { join } from 'path';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Templates } from '@spinajs/templates';

// templates/welcome.handlebars:
//   <h1>{{__ "Welcome"}}, {{capitalize user.name}}!</h1>
//   <p>{{__n "%d unread messages" unread}}</p>
class AppConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      system: { dirs: { locales: [join(process.cwd(), 'locales')] } },
      intl: { defaultLocale: 'en', locales: ['en', 'pl'] },
    };
  }
}

async function main() {
  DI.register(AppConfiguration).as(Configuration);
  await DI.resolve(Configuration);

  const templates = await DI.resolve(Templates);
  const html = await templates.render(join(process.cwd(), 'templates', 'welcome.handlebars'), { user: { name: 'anna' }, unread: 3 }, 'pl');

  console.log(html);
}

void main();
```

## Related packages

- `@spinajs/templates` (no docs folder yet): the `Templates` facade, the `TemplateRenderer` and `CompiledTemplateRenderer` bases, and the `templates.cache.mode` cache this renderer uses.
- [`@spinajs/intl`](../intl/README.md): `__`, `__n`, `__l`, `__h` call its `__translate*` functions; the render language comes from [`guessLanguage()`](../intl/04-request-language.md).
- [`@spinajs/fs`](../fs/README.md): reads `fs://provider/path.handlebars` template sources.
- [`@spinajs/email`](../email/README.md): renders email bodies through `Templates`, so `.handlebars` mail templates use this engine.
- `@spinajs/template-mjml` (no docs folder yet): `MjmlRenderer` runs every `.mjml` file through this engine (`Templates.compile(..., 'handlebars', ...)`) before converting MJML to HTML.
- [`@spinajs/queue-templates-pdf`](../queue-templates-pdf/06-custom-worker-entry.md): a render worker imports this package to compile Handlebars before printing a PDF.
- [`@spinajs/di`](../di/06-multiple-implementations.md): `TemplateRenderer` is a multi-implementation list; every engine package adds one element.
