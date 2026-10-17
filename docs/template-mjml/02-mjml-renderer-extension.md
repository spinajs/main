# Replacing or extending `MjmlRenderer`

`MjmlRenderer` is one element of the `TemplateRenderer` plugin list of `@spinajs/templates`. Replace it to post-process every MJML mail, add a second MJML renderer with its own options, or hook into the MJML compiler through config.

## How it works

1. Importing `@spinajs/templates-mjml` runs `@Injectable(TemplateRenderer)` on `MjmlRenderer`, adding it to the `TemplateRenderer` list of the root container. No lifetime decorator: it is a singleton.
2. The first `DI.resolve(Templates)` resolves `Array.ofType(TemplateRenderer)` through `@Autoinject(TemplateRenderer)` and keeps that array in `Templates.Renderers`.
3. On `Templates.render()` and `renderToFile()`, `Templates` picks the **first** element whose `Extension` equals the template's extension. On `Templates.compile()` and `compileToFile()`, it picks the first whose `Type` equals the given name.
4. `MjmlRenderer.render()` resolves `Templates` through `@LazyInject(Templates)` (root container, at call time) and calls `Templates.compile(template, 'handlebars', ...)`: the Handlebars pre-pass is found by `Type`, registered when this package is imported.
5. `MjmlRenderer` reads `templates.mjml` through `@Config` on every render and hands it to `mjml2html()`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| MJML renderer | `TemplateRenderer` list (`Array.ofType`), singleton; `@Injectable(TemplateRenderer)` at import | `MjmlRenderer`: `Type` `'mjml'`, `Extension` `'.mjml'`, `ServiceName` `'.mjml'` | none shipped | Replace: subclass, `@Injectable(TemplateRenderer)`, `DI.unregister(MjmlRenderer)`. Extend: subclass with a new `Type` and `Extension`, redeclare `Options` with another `@Config` key |
| Handlebars pre-pass | first `TemplateRenderer` with `Type` `'handlebars'`, looked up on every render | `HandlebarsRenderer` (`@spinajs/templates-handlebars`), singleton | none shipped | Replace or configure it in `@spinajs/templates-handlebars`; or override `MjmlRenderer.render()` to use another engine |
| MJML compiler hooks | config `templates.mjml`, read per render | MJML defaults | `preprocessors`, `skeleton`, `fonts`, `mjmlConfigPath` (custom components) | Set the keys; see [Configuration](01-rendering-mjml-templates.md#configuration) |

### Members meant for overriding

| Member | Kind | Default | Override to |
| --- | --- | --- | --- |
| `Type` | getter | `'mjml'` | Give a variant its own name for `Templates.compile()`. |
| `Extension` | getter | `'.mjml'` | Give a variant its own file extension for `Templates.render()`. Single segment: `extname()` of `invoice.print.mjml` is `.mjml`. |
| `Options` | `@Config('templates.mjml')` property | not set | Read MJML options from another key: redeclare it with `@Config('<key>')`. |
| `render(templateName, model, language?)` | method | Handlebars pass, then `mjml2html()` | Pre- or post-process; call `super.render()` to keep the pipeline. |
| `renderToFile(template, model, filePath, language?)` | method | `render()`, then write the file | Change where or how the HTML is stored. It calls `this.render()`, so a `render()` override applies to files too. |
| `Templates` | `@LazyInject(Templates)` property | root `Templates` | Rarely needed; use it to run another engine as the pre-pass. |

Inherited from `TemplateRenderer` and usable in a subclass: `Log` (`renderer` logger), `resolveContent()`, `resolveLocalPath()`, `isUri()`, `CacheMode`, `withCache()`. `MjmlRenderer` itself does not cache; `withCache()` caches by template path, so do not use it for the final HTML, which depends on the model.

### Replace the renderer: add an open-tracking pixel to every MJML mail

Do it when every `.mjml` render must change, eg. a tracking pixel, a legal footer or link rewriting.

- Register the subclass and unregister `MjmlRenderer` **before** the first `DI.resolve(Templates)`. `Templates` keeps the list it got on first resolve.
- Without `DI.unregister(MjmlRenderer)`, both have `Extension` `'.mjml'` and `Templates` keeps picking `MjmlRenderer`, which registered first.
- `DI.register(TrackedMjmlRenderer).as(TemplateRenderer)` works the same as the decorator.

```ts sample
import '@spinajs/templates-handlebars';
import { MjmlRenderer } from '@spinajs/templates-mjml';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';

interface TrackedModel {
  trackingId?: string;
}

@Injectable(TemplateRenderer)
class TrackedMjmlRenderer extends MjmlRenderer {
  public async render(templateName: string, model: unknown, language?: string): Promise<string> {
    const html = await super.render(templateName, model, language);
    const trackingId = (model as TrackedModel | undefined)?.trackingId;

    if (!trackingId) {
      return html;
    }

    const pixel = `<img src="https://mail.acme.com/open/${encodeURIComponent(trackingId)}.gif" width="1" height="1" alt="" />`;
    return html.replace('</body>', `${pixel}</body>`);
  }
}

// MjmlRenderer registered itself on import and would win the `.mjml` lookup.
DI.unregister(MjmlRenderer);

export async function renderCampaign(recipientId: string): Promise<string> {
  const templates = await DI.resolve(Templates);
  return await templates.render('./templates/spring-sale.mjml', { trackingId: recipientId, firstName: 'Ada' }, 'en');
}

console.log(TrackedMjmlRenderer.name);
```

### Extend: a print-ready MJML variant next to the default one

Keep `MjmlRenderer` for mail and add a renderer for documents that are also printed (invoices, tickets). The variant gets its own `Type`, `Extension` and options key, so both live in the list without clashing.

```ts sample
import '@spinajs/templates-handlebars';
import '@spinajs/templates-mjml';
import { MjmlRenderer } from '@spinajs/templates-mjml';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import type { MJMLParsingOptions } from 'mjml-core';

@Injectable(TemplateRenderer)
class PrintMjmlRenderer extends MjmlRenderer {
  @Config('templates.mjmlPrint', { defaultValue: { printerSupport: true, validationLevel: 'strict' } })
  protected Options: MJMLParsingOptions;

  public get Type() {
    return 'mjml-print';
  }

  public get Extension() {
    return '.pmjml';
  }
}

export async function renderInvoice(invoiceNo: string, total: string): Promise<string[]> {
  const templates = await DI.resolve(Templates);
  const model = { invoiceNo, total };

  // by extension: invoice.pmjml goes to PrintMjmlRenderer
  const printable = await templates.render('./templates/invoice.pmjml', model, 'en');

  // by type: an ordinary .mjml file compiled with the print options
  const fromMailTemplate = await templates.compile('./templates/invoice.mjml', 'mjml-print', model, 'en');

  return [printable, fromMailTemplate];
}

console.log(PrintMjmlRenderer.name);
```

### The Handlebars pre-pass

`MjmlRenderer` never imports `@spinajs/templates-handlebars`; it calls `Templates.compile(template, 'handlebars', model, language)`. So:

- importing this package registers the Handlebars renderer; a replacement must register a renderer with `Type` `'handlebars'`, or `.mjml` renders throw `InvalidOperation: No renderer for handlebars`;
- Handlebars helpers, options (`templates.handlebars`) and its delegate cache (`templates.cache.mode`) apply to `.mjml` files too;
- to use another engine as the pre-pass, override `render()` and call `this.Templates.compile(template, '<type>', ...)` with that engine's `Type`. The engine must read any file path, not only its own extension; `HandlebarsRenderer` does.

### MJML compiler hooks through config

`templates.mjml` is passed to `mjml2html()` as is, so MJML's own hooks need no subclass. Use `preprocessors` to expand house shorthands after the Handlebars pass and before MJML parses the markup:

```ts sample
import type { MJMLParsingOptions } from 'mjml-core';

const legalFooter = `<mj-section><mj-column><mj-text font-size="11px">Acme Ltd, 1 Main St. You get this mail because you have an Acme account.</mj-text></mj-column></mj-section>`;

const mjml: MJMLParsingOptions = {
  validationLevel: 'strict',
  preprocessors: [(xml) => xml.replace(/<acme-legal-footer\s*\/>/g, legalFooter)],
};

// config/templates.ts in your app
export default {
  templates: { mjml },
};
```

For whole custom components (`<mj-acme-card>`), point `templates.mjml.mjmlConfigPath` at a `.mjmlconfig` file; MJML registers its `packages` on every call.

## Important behaviour

- **First match wins.** `Templates` uses `Array.find()` on `Extension` and on `Type`. Two renderers with the same value never both run; the earlier registration wins.
- **Register before `Templates` resolves.** `Templates` is a singleton and keeps the array it got on first resolve. A renderer registered later is not seen by it.
- **`ServiceName` is the extension.** `TemplateRenderer.ServiceName` returns `Extension`, so a `Map` of renderers keyed by `ServiceName` holds one renderer per extension. Give a variant its own extension even when you call it only by `Type`.
- **Root container only.** `@LazyInject(Templates)` resolves from the root container, and the `TemplateRenderer` list is owned by the container that registered it. Register renderers in the root, not in a child container.
- **A subclass inherits the injections.** `Log`, `Options` (`@Config`) and `Templates` (`@LazyInject`) are defined on the base prototype, so a subclass gets them without redeclaring.

## Best practices

- Call `super.render()` in overrides; it keeps the Handlebars pass, MJML validation logging and timing.
- Name variants after their purpose (`'mjml-print'`, `'.pmjml'`) and give each its own config key, so mail and print options never mix.
- Keep `DI.unregister(MjmlRenderer)` next to the replacement class, in the module that imports `@spinajs/templates-mjml`.

## Patterns and antipatterns

```ts
// Don't: a second `.mjml` renderer without removing the default one; it is never picked
@Injectable(TemplateRenderer)
class BrandedMjmlRenderer extends MjmlRenderer {}

// Do: remove the default, or give the subclass its own Extension and Type
@Injectable(TemplateRenderer)
class BrandedMjmlRenderer extends MjmlRenderer {}
DI.unregister(MjmlRenderer);
```

```ts
// Don't: register after the facade was resolved; Templates keeps the old list
const templates = await DI.resolve(Templates);
DI.register(BrandedMjmlRenderer).as(TemplateRenderer);

// Do: register at module load, before any DI.resolve(Templates)
DI.register(BrandedMjmlRenderer).as(TemplateRenderer);
const templates = await DI.resolve(Templates);
```

## Related

- [Rendering MJML templates](01-rendering-mjml-templates.md): the render flow and `templates.mjml` keys.
- [`@spinajs/templates`](../templates/README.md): `TemplateRenderer`, `Templates` and the renderer lookup.
- [`@spinajs/templates-handlebars`](../templates-handlebars/README.md): the pre-pass engine and its helpers.
- [Multiple implementations](../di/06-multiple-implementations.md): how `Array.ofType` builds the renderer list.
- [Registering services](../di/01-registering-services.md): `DI.register().as()` and `DI.unregister()`.
