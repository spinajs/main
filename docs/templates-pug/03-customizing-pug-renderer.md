# Customizing `PugRenderer`

`PugRenderer` is a DI-registered `TemplateRenderer`. Subclass it and swap it in to give every `.pug` template extra helpers, compute pug options per template, or post-process the compiled output, without changing any caller of `Templates`.

## How it works

1. Importing `@spinajs/templates-pug` runs `@Injectable(TemplateRenderer)` on `PugRenderer`: the class is registered under the `TemplateRenderer` key and under its own name. No lifetime decorator, so it is a singleton.
2. `Templates` declares `@Autoinject(TemplateRenderer) Renderers: TemplateRenderer[]`. The first resolve of `Templates` builds `Array.ofType(TemplateRenderer)`: one instance of every registered engine, in registration order. The list is cached.
3. `Templates.render()` takes the **first** engine whose `Extension` equals the file extension; `Templates.compile()` takes the first whose `Type` matches.
4. A subclass decorated `@Injectable(TemplateRenderer)` is appended to the list. `PugRenderer` stays in it and stays first for `.pug`, so `DI.unregister(PugRenderer)` must remove it.
5. Both steps must run before the first `DI.resolve(Templates)`. Registering later does not change the `Renderers` list `Templates` already holds.
6. At render time your overrides run in the base flow: `withCache()` calls `compile()` on a miss, then `buildContext()` builds the locals for each render. See [Rendering pug templates](01-rendering-pug-templates.md#how-it-works).

## Overridable members

| Member | Visibility | Called | Default | Override to |
| --- | --- | --- | --- | --- |
| `buildContext(model, language): Record<string, unknown>` | protected | every render | `_.merge({}, model, { __, __n, __l, __h })` | add helpers and globals (brand, formatters, feature flags); call `super.buildContext()` to keep the translation helpers |
| `compile(template): Promise<pug.compileTemplate>` | protected | on a cache miss only | `resolveLocalPath()` then `pug.compileFile(path, this.Options)` | compute options per template, wrap the delegate to post-process HTML, add compile-time checks |
| `Type: string` | public getter | by `Templates.compile()` | `'pug'` | register the subclass as another engine; see [Additional pug engines](04-additional-pug-engines.md) |
| `Extension: string` | public getter | by `Templates.render()` | `'.pug'` | claim another file extension |
| `render(templateName, model, language?)` | public | by `Templates` | validate, `withCache(compile)`, `buildContext`, run delegate, trace log with timing | wrap the whole render (audit log, metrics per template) |
| `renderToFile(templateName, model, filePath, language?)` | public | by `Templates` | `render()`, create the parent folder, `fs.writeFileSync` | write elsewhere, eg. through `@spinajs/fs` |
| `resolveLanguage(language?)` | protected | every render | argument, else `guessLanguage()`, else `defaultLanguage()` | force a language rule, eg. map `en-GB` to `en` |
| `resolveLocalPath(template)` | protected, from `TemplateRenderer` | inside `compile()` | bare path unchanged; `fs://` URI through `fs.download()` | resolve template names against your own folders |
| `changeToken(template)` | protected, from `TemplateRenderer` | `revalidate` mode, every render | `mtimeMs\|size`, or the remote `Version` | include partials in the token |
| `resolve()` | public, from `AsyncService` | once, when the singleton is built | no-op | one-time setup, eg. load filter modules; call `await super.resolve()` |
| `Options` | protected property | inside `compile()` | `@Config('templates.pug')` | read it, or redeclare it with another `@Config` path |
| `Log` | protected property | | logger `renderer` | log from your overrides |
| `Cache` | protected property | by `withCache()` | `Map` of compiled delegates keyed by normalized template path | clear it to drop compiled templates at runtime |

## Configuration

A subclass reads the same keys as `PugRenderer`: `templates.pug` and `templates.cache.mode`. See [Rendering pug templates](01-rendering-pug-templates.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `.pug` engine | `TemplateRenderer` and `PugRenderer`, singleton; registered by `@Injectable(TemplateRenderer)` at import; resolved as `Array.ofType(TemplateRenderer)` by `Templates` | `PugRenderer` | None shipped | Replace: `@Injectable(TemplateRenderer)` on a subclass plus `DI.unregister(PugRenderer)`, both before the first `DI.resolve(Templates)`. Extend: override the members above |
| Render context | `PugRenderer.buildContext()` hook | model plus translation helpers | | Override in the subclass |
| Compile step | `PugRenderer.compile()` hook | `pug.compileFile()` with `templates.pug` | | Override in the subclass; the result is cached per template |

### `PugRenderer`: add brand helpers to every template

Every mail and page needs the brand name, the support address and a date formatter. Override `buildContext()`, keep the translation helpers from `super`, and swap the class in at startup.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { PugRenderer } from '@spinajs/templates-pug';

const BRAND = {
  name: 'Acme',
  supportEmail: 'support@acme.com',
  logoUrl: 'https://cdn.acme.com/logo.png',
};

@Injectable(TemplateRenderer)
class BrandedPugRenderer extends PugRenderer {
  protected buildContext(model: unknown, language: string): Record<string, unknown> {
    const context = super.buildContext(model, language);
    const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'long' });

    return {
      ...context,
      brand: BRAND,
      formatDate: (value: Date | string) => dateFormat.format(new Date(value)),
    };
  }
}

// PugRenderer is first in the list for `.pug`; take it out so the subclass handles those files.
DI.unregister(PugRenderer);

async function renderOrderConfirmation(orderNo: string, placedAt: Date, language: string): Promise<string> {
  const templates = await DI.resolve(Templates);
  return await templates.render('fs://mail-templates/order-confirmation.pug', { orderNo, placedAt }, language);
}
```

```pug
//- order-confirmation.pug
img(src=brand.logoUrl alt=brand.name)
p= __('Order %s placed on %s', orderNo, formatDate(placedAt))
p= __('Questions? Write to %s', brand.supportEmail)
```

### `PugRenderer`: strip comments from compiled mail HTML

Override `compile()` to wrap the delegate pug returns. The wrapper is cached with the template, so the regex is built once and the cost is paid only per render.

```ts sample
import * as pug from 'pug';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { PugRenderer } from '@spinajs/templates-pug';

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

@Injectable(TemplateRenderer)
class MailPugRenderer extends PugRenderer {
  protected async compile(template: string): Promise<pug.compileTemplate> {
    const compiled = await super.compile(template);
    this.Log.trace({ template }, 'Compiled mail template ${template}');

    return (locals?: pug.LocalsObject) => compiled(locals).replace(HTML_COMMENT, '');
  }
}

DI.unregister(PugRenderer);

async function renderNewsletter(issue: number): Promise<string> {
  const templates = await DI.resolve(Templates);
  return await templates.render('fs://mail-templates/newsletter.pug', { issue }, 'en');
}
```

### `PugRenderer`: per-tenant `basedir`

Absolute includes resolve against `basedir`. Override `compile()` to pick the folder from the template's location, so each tenant's `include /partials/footer` finds its own partials.

```ts sample
import { dirname, join } from 'path';
import * as pug from 'pug';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer } from '@spinajs/templates';
import { PugRenderer } from '@spinajs/templates-pug';

@Injectable(TemplateRenderer)
class TenantPugRenderer extends PugRenderer {
  protected async compile(template: string): Promise<pug.compileTemplate> {
    const path = await this.resolveLocalPath(template);

    // eg. /srv/tenants/acme/mail/invoice.pug -> basedir /srv/tenants/acme
    const tenantRoot = join(dirname(path), '..');

    return pug.compileFile(path, { ...this.Options, basedir: tenantRoot });
  }
}

DI.unregister(PugRenderer);
```

## Important behaviour

- **Without `DI.unregister(PugRenderer)` your subclass is never used for `.pug`.** It sits after `PugRenderer` in the list and `Templates` takes the first match.
- **Registering a class named `PugRenderer` does not replace it.** The registry skips a class whose name is already in the list.
- **Order matters.** Register and unregister before anything resolves `Templates` (eg. `HttpServer` of `@spinajs/http` injects it with `@Inject(Templates)`). A later change leaves the cached list as it was.
- **`compile()` runs once per template in `cache` mode.** Per-render data (language, model) belongs in `buildContext()`, never in `compile()`.
- **`buildContext()` must return a new object.** The base merges into `{}`; mutating `model` leaks helpers into the caller's object.
- **`DI.unregister(PugRenderer)` removes both registrations** (`TemplateRenderer` and `PugRenderer`), so `DI.resolve(PugRenderer)` afterwards builds a fresh instance outside the list.
- **The subclass inherits `@Config('templates.pug')`** and the `renderer` logger; redeclare `Options` with another `@Config` path for separate options.

## Best practices

- Call `super.buildContext()` and spread its result; dropping it removes `__`, `__n`, `__l` and `__h` from every template.
- Do the swap in the module that bootstraps your app, next to the `@spinajs/templates-pug` import, so the order is visible in one place.
- Keep helpers pure functions of their arguments and the render language; a helper that reads request state breaks when the render runs in a queue worker.
- Prefer `templates.pug` config for static pug options; override `compile()` only when the options depend on the template.

## Patterns and antipatterns

```ts
// Don't: the subclass is appended after PugRenderer and never handles a .pug file
@Injectable(TemplateRenderer)
class BrandedPugRenderer extends PugRenderer {}

// Do: remove the default from the list as well
@Injectable(TemplateRenderer)
class BrandedPugRenderer extends PugRenderer {}
DI.unregister(PugRenderer);
```

```ts
// Don't: compile() is cached; the first caller's language sticks for every later render
protected async compile(template: string) {
  const fn = await super.compile(template);
  const language = this.resolveLanguage();
  return (locals?: pug.LocalsObject) => fn({ ...locals, language });
}

// Do: per-render values go through buildContext()
protected buildContext(model: unknown, language: string) {
  return { ...super.buildContext(model, language), language };
}
```

## Examples

### Count renders per template

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { PugRenderer } from '@spinajs/templates-pug';

@Injectable(TemplateRenderer)
class CountingPugRenderer extends PugRenderer {
  public readonly Renders = new Map<string, number>();

  public async render(templateName: string, model: unknown, language?: string): Promise<string> {
    const html = await super.render(templateName, model, language);
    this.Renders.set(templateName, (this.Renders.get(templateName) ?? 0) + 1);
    return html;
  }
}

DI.unregister(PugRenderer);

async function mostRenderedTemplate(): Promise<string | undefined> {
  const templates = await DI.resolve(Templates);
  const renderer = templates.getRendererFor('.pug') as CountingPugRenderer;

  return [...renderer.Renders.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
```

`renderToFile()` calls `render()`, so it is counted too.

## Related

- [Rendering pug templates](01-rendering-pug-templates.md): the render flow the overrides plug into.
- [Additional pug engines](04-additional-pug-engines.md): register a subclass beside `PugRenderer` instead of replacing it.
- [`@spinajs/templates`](../templates/README.md): `TemplateRenderer`, `CompiledTemplateRenderer` and writing an engine for another language.
- [`@spinajs/di`](../di/06-multiple-implementations.md): `Array.ofType`, `DI.unregister` and plugin lists.
