# Customizing the renderer

`HandlebarsRenderer` is a DI service with protected hooks for each step of a render. Subclass it to add values to every template, change how sources compile, pass Handlebars runtime options, or serve another file extension. Swap the default out, or register your subclass next to it under another extension.

## How it works

1. Importing `@spinajs/templates-handlebars` runs `@Singleton()` and `@Injectable(TemplateRenderer)` on `HandlebarsRenderer`. It is registered twice: in the `TemplateRenderer` list and under its own class name.
2. `Templates` declares `@Autoinject(TemplateRenderer) Renderers: TemplateRenderer[]`, an [`Array.ofType`](../di/06-multiple-implementations.md) list. DI builds every registered engine, awaiting each `resolve()`, when `Templates` is first resolved.
3. `HandlebarsRenderer.resolve()` registers the built-in helpers, then calls `super.resolve()`.
4. On each render, `Templates` takes the **first** list element whose `Extension` (for `render()`) or `Type` (for `compile()`) matches. Registration order decides between two engines with the same extension.
5. The chosen renderer runs `render()` from `CompiledTemplateRenderer`, which calls the hooks below. See [Rendering templates](01-rendering-templates.md#how-it-works) for the full flow.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Handlebars engine | `TemplateRenderer` (list element) and `HandlebarsRenderer`; singleton (`@Singleton()`); registered when the package is imported | `HandlebarsRenderer` (`Type` `handlebars`, `Extension` `.handlebars`) | Engines for other extensions: `PugRenderer` (`@spinajs/templates-pug`), `MjmlRenderer` (`@spinajs/template-mjml`), `Csv` (`@spinajs/templates-csv`), `XlsxRenderer` (`@spinajs/templates-xlsx`), `PdfRenderer` (`@spinajs/templates-pdf`), `ImageRenderer` (`@spinajs/templates-image`) | Replace: subclass, decorate with `@Singleton()` and `@Injectable(TemplateRenderer)`, and call `DI.unregister(HandlebarsRenderer)` before `Templates` first resolves. Add: subclass with a different `Type` and `Extension` |
| Engine lookup | `Templates`, an `AsyncService` singleton | `Templates` | Your subclass of `Templates` | `DI.register(MyTemplates).as(Templates)`; `getRendererFor(extension)` is public, the lookups are private |
| Engine map | `ServiceName` returns `Extension` (`IMappableService`) | `.handlebars` | | Inject `@Autoinject(TemplateRenderer, { mapFunc: (r) => r.ServiceName }) Engines: Map<string, TemplateRenderer>` to look engines up by extension in your own service |

### Hooks

| Member | Defined in | Default | Override to |
| --- | --- | --- | --- |
| `Type` | `HandlebarsRenderer` | `'handlebars'` | Name the engine for `Templates.compile(path, type, ...)` |
| `Extension` | `HandlebarsRenderer` | `'.handlebars'` | Serve another extension, eg. `.hbs` |
| `resolve()` | `HandlebarsRenderer` | Registers the built-in helpers, then `super.resolve()` | Register more helpers or partials after `await super.resolve()`, so they win over built-ins |
| `compile(template)` | `HandlebarsRenderer` | `resolveContent()`, empty check (`IOFail`), `Handlebars.compile(content, Options)` | Pre-process the source, compile with another environment, or wrap the delegate to pass `RuntimeOptions` |
| `buildContext(model, language)` | `HandlebarsRenderer` | `_.merge({}, model ?? {}, { lang: language })` | Add values every template sees |
| `Options` | `HandlebarsRenderer` | `@Config('templates.handlebars')` | Read it, or adjust it in `compile()` |
| `resolveLanguage(language?)` | `CompiledTemplateRenderer` | Argument, else `guessLanguage()`, else `defaultLanguage()` | Pick the language another way, eg. from the model |
| `resolveContent(template)` | `TemplateRenderer` | Local `readFile()`, or `@spinajs/fs` for `fs://` | Read sources from elsewhere |
| `CacheMode`, `changeToken(template)` | `TemplateRenderer` | `templates.cache.mode`; `mtime` and size, or the provider's `Version` | Force a mode for this engine, or change what counts as an edit |
| `render()`, `renderToFile()` | `CompiledTemplateRenderer` | Validate, cache, compile, build context, run | Rarely; prefer the hooks above |

### `buildContext`: add globals to every template

Every mail shows the brand name, the support address and the current year. Put them in the context once instead of in every model.

```ts sample
import { Config } from '@spinajs/configuration';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { HandlebarsRenderer } from '@spinajs/templates-handlebars';

interface BrandSettings {
  name: string;
  supportEmail: string;
}

// The default would win the `.handlebars` lookup: it is registered first.
DI.unregister(HandlebarsRenderer);

@Singleton()
@Injectable(TemplateRenderer)
class BrandedHandlebarsRenderer extends HandlebarsRenderer {
  @Config('app.brand', { defaultValue: { name: 'Acme', supportEmail: 'support@acme.example' } })
  protected Brand: BrandSettings;

  protected buildContext(model: unknown, language: string): Record<string, unknown> {
    // Model values win over the globals; `lang` still comes last.
    return {
      brand: this.Brand,
      year: new Date().getFullYear(),
      ...super.buildContext(model, language),
    };
  }
}

async function main() {
  const templates = await DI.resolve(Templates);

  // footer: <p>© {{year}} {{brand.name}} · {{brand.supportEmail}}</p>
  console.log(await templates.render('/srv/app/templates/welcome.handlebars', { name: 'Anna' }, 'en'));
  console.log(templates.getRendererFor('.handlebars') instanceof BrandedHandlebarsRenderer); // true
}

void main();
```

### `compile`: pre-process sources or pass runtime options

Two needs the config key cannot cover:

- Handlebars `RuntimeOptions` (`allowProtoPropertiesByDefault`, per-call `helpers` and `partials`) go to the delegate, not to `Handlebars.compile()`.
- A source format with extra content, such as a front-matter block holding the mail subject.

Wrap or rebuild the delegate in `compile()`. The result is cached like the default one.

```ts sample
import Handlebars from 'handlebars';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { TemplateRenderer } from '@spinajs/templates';
import { HandlebarsRenderer } from '@spinajs/templates-handlebars';

DI.unregister(HandlebarsRenderer);

@Singleton()
@Injectable(TemplateRenderer)
class MailHandlebarsRenderer extends HandlebarsRenderer {
  // Visible to this renderer only; other code using `handlebars` does not see it.
  protected privateHelpers = {
    unsubscribeLink: (userId: string) => `https://acme.example/unsubscribe?u=${encodeURIComponent(userId)}`,
  };

  protected async compile(template: string): Promise<HandlebarsTemplateDelegate<any>> {
    // Drop a leading "---\nsubject: ...\n---" block; the mail sender reads it separately.
    const source = (await this.resolveContent(template)).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    if (source.trim().length === 0) {
      throw new IOFail(`Template file ${template} has no body`);
    }

    const compiled = Handlebars.compile(source, this.Options);

    return (context: any, options?: Handlebars.RuntimeOptions) =>
      compiled(context, {
        // ORM models keep their getters reachable from templates.
        allowProtoPropertiesByDefault: true,
        ...options,
        helpers: { ...this.privateHelpers, ...options?.helpers },
      });
  }
}

void MailHandlebarsRenderer;
```

Runtime `helpers` win over helpers of the same name in the global environment, so `privateHelpers` can also shadow a built-in for this renderer only.

### `Type` and `Extension`: serve `.hbs` files

A second engine with its own extension does not compete with the default, so no `DI.unregister()` is needed. Both share the global helpers; each keeps its own compiled-template cache.

```ts sample
import { DI, Injectable, Singleton } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { HandlebarsRenderer } from '@spinajs/templates-handlebars';

@Singleton()
@Injectable(TemplateRenderer)
class HbsRenderer extends HandlebarsRenderer {
  public get Type() {
    return 'hbs';
  }

  public get Extension() {
    return '.hbs';
  }
}

async function main() {
  const templates = await DI.resolve(Templates);

  await templates.render('/srv/app/templates/invoice.hbs', { number: 'FV/2026/10/42' }, 'en'); // HbsRenderer
  await templates.render('/srv/app/templates/invoice.handlebars', { number: 'FV/2026/10/42' }, 'en'); // HandlebarsRenderer
  console.log(templates.getRendererFor('.hbs') instanceof HbsRenderer); // true
}

void main();
```

### `resolve`: register helpers that win over built-ins

```ts sample
import Handlebars from 'handlebars';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { TemplateRenderer } from '@spinajs/templates';
import { HandlebarsRenderer } from '@spinajs/templates-handlebars';

DI.unregister(HandlebarsRenderer);

@Singleton()
@Injectable(TemplateRenderer)
class PlnHandlebarsRenderer extends HandlebarsRenderer {
  public async resolve(): Promise<void> {
    // Built-ins first, so the registrations below replace them.
    await super.resolve();

    Handlebars.registerHelper('currency', (value: unknown) => (Number(value) || 0).toLocaleString('pl-PL', { style: 'currency', currency: 'PLN' }));
    Handlebars.registerPartial('footer', '<p>{{__ "Thank you for shopping with us"}}</p>');
  }
}

void PlnHandlebarsRenderer;
```

## Important behaviour

- **Without `DI.unregister(HandlebarsRenderer)` a replacement for `.handlebars` is never used.** `Templates` takes the first match, and the package registers its class at import time.
- **Unregister and register before `Templates` is first resolved.** The renderer list is cached on first resolve; a later change does not reach an existing `Templates` instance.
- **Decorate the subclass itself.** `@Injectable(TemplateRenderer)` registers only the class it decorates; an undecorated subclass is not in the renderer list.
- **`HandlebarsRenderer.resolve()` touches global state.** Every instance, including subclasses, re-registers the built-ins on the shared environment, and overwrites built-in names you registered before it.
- **`compile()` runs only on a cache miss.** Per-render logic belongs in `buildContext()` or in a delegate wrapper, not in the body of `compile()`.
- **Keep `lang` in the context.** `__` and `__n` read `@root.lang`; a `buildContext()` that drops it breaks translation.

## Best practices

- Call `super.buildContext()` and `super.resolve()` instead of copying their bodies; the defaults carry the `lang` key and the built-in helpers.
- Keep `DI.unregister()` and the subclass in one module your app imports once at startup, next to the other DI registrations.
- Give an added engine its own `Type` as well as its own `Extension`, so `Templates.compile(path, type, ...)` can reach it.
- Prefer a runtime-options wrapper over `allowProtoPropertiesByDefault` everywhere: list the exact properties in `allowedProtoProperties` when you can.

## Patterns and antipatterns

```ts
// Don't: registered next to the default, never picked for .handlebars
@Singleton()
@Injectable(TemplateRenderer)
class MyRenderer extends HandlebarsRenderer {}

// Do: remove the default first
DI.unregister(HandlebarsRenderer);

@Singleton()
@Injectable(TemplateRenderer)
class MyRenderer extends HandlebarsRenderer {}
```

## Examples

### Swap the renderer for a test double

Check that a service renders the right template with the right model, without reading files.

```ts sample
import { DI, Injectable, Singleton } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { HandlebarsRenderer } from '@spinajs/templates-handlebars';

@Singleton()
@Injectable(TemplateRenderer)
class RecordingHandlebarsRenderer extends HandlebarsRenderer {
  public calls: { template: string; model: unknown; language?: string }[] = [];

  public async render(template: string, model: unknown, language?: string): Promise<string> {
    this.calls.push({ template, model, language });
    return `<rendered ${template}>`;
  }
}

// Runs in a test after the test configuration is registered; `Templates` needs `Intl`, which needs it.
async function main() {
  DI.clearCache();
  DI.unregister(HandlebarsRenderer);

  const templates = await DI.resolve(Templates);
  await templates.render('mail/welcome.handlebars', { name: 'Anna' }, 'pl');

  const recorder = templates.getRendererFor('.handlebars') as RecordingHandlebarsRenderer;
  console.log(recorder.calls); // [ { template: 'mail/welcome.handlebars', model: { name: 'Anna' }, language: 'pl' } ]
}

void main();
```

## Related

- [Multiple implementations](../di/06-multiple-implementations.md): how the `TemplateRenderer` list is built and cached.
- [Registering services](../di/01-registering-services.md): `@Injectable`, `@Singleton` and `DI.unregister`.
- [Custom helpers and partials](03-custom-helpers-and-partials.md): helpers without a subclass.
- [Rendering templates](01-rendering-templates.md#caching): the cache that stores what `compile()` returns.
