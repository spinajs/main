# Custom renderers

`TemplateRenderer` is the plugin contract of this package. Subclass it and register it with `@Injectable(TemplateRenderer)` to add a template engine or an output format; `Templates` then selects it by its `Extension` or `Type`.

For an engine that compiles a template file into a reusable function, extend [`CompiledTemplateRenderer`](07-compiled-template-renderer.md) instead; it implements `render()` and `renderToFile()` for you.

## How it works

1. `@Injectable(TemplateRenderer)` runs when your module is imported: `DI.register(MyRenderer).as(TemplateRenderer)` and `.asSelf()`.
2. The first `DI.resolve(Templates)` resolves `Array.ofType(TemplateRenderer)` into `Templates.Renderers`, in registration order. Each renderer's `resolve()` runs, since `TemplateRenderer` is an `AsyncService`.
3. A call to `Templates.render()` / `renderToFile()` picks the first renderer whose `Extension` equals the template's extension; `compile()` / `compileToFile()` pick by `Type`.
4. `Templates` calls your `render(template, model, language, options)` or `renderToFile(template, model, filePath, language, options)` inside a perf span.

## Contract

| Member | Kind | Meaning |
| --- | --- | --- |
| `Type` | abstract getter | Engine name used by `compile()` / `compileToFile()` and as the perf label `engine` |
| `Extension` | abstract getter | File extension with the dot (`.ics`), used by `render()` / `renderToFile()` |
| `ServiceName` | getter | Returns `Extension`; implements `IMappableService` for map injection |
| `render(templatePath, model, language?, options?)` | abstract | Output as a string. Throw `NotSupported` for file-only formats |
| `renderToFile(templatePath, model, filePath, language?, options?)` | abstract | Writes the output to `filePath` |
| `Log` | protected, `@Logger('renderer')` | Logger shared by renderers; override with your own `@Logger(...)` |
| `ConfiguredCacheMode`, `DevMode`, `CacheMode`, `Cache`, `withCache()` | protected | [Compiled-template cache](03-compiled-template-cache.md) |
| `isUri()`, `normalizeTemplate()`, `resolveContent()`, `resolveLocalPath()`, `changeToken()`, `tokenFromStat()` | protected | [Template sources](02-template-sources.md) |
| `ensureParentDir(filePath)` | exported function | Creates the parent directory of an output file |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TemplateRenderer` | The abstract class `TemplateRenderer`, as a list. Each element keeps its own lifetime: no decorator means singleton; `HandlebarsRenderer` is `@Singleton()`; `PdfRenderer` and `ImageRenderer` are `@PerInstanceCheck()` | none in this package | handlebars, pug, mjml, csv, xlsx, pdf, image (see [Shipped renderers](01-rendering-templates.md#shipped-renderers)) | **Add**: `@Injectable(TemplateRenderer)`. **Replace a shipped one**: `DI.unregister(ShippedRenderer)` and register yours. **Extend a shipped one**: subclass it, register the subclass, unregister the parent |
| `CompiledTemplateRenderer` | abstract base, no token | — | `HandlebarsRenderer`, `PugRenderer` | See [Compiled template renderer](07-compiled-template-renderer.md) |

### `TemplateRenderer`: an output format built from the model

A renderer does not have to read a template file. `Csv` builds its output from the model and ignores the path; the sample does the same for calendar invites.

```ts sample
import { writeFile } from 'fs/promises';
import { DI, Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ensureParentDir, TemplateRenderer, Templates } from '@spinajs/templates';

interface IMeetingInvite {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  organizer: string;
}

function icsDate(d: Date) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

@Injectable(TemplateRenderer)
export class IcsRenderer extends TemplateRenderer {
  public get Type() {
    return 'ics';
  }

  public get Extension() {
    return '.ics';
  }

  public async render(_template: string, model: IMeetingInvite): Promise<string> {
    if (!model?.uid || !model.start || !model.end) {
      throw new InvalidArgument('ics model requires uid, start and end');
    }

    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//example//meetings//EN',
      'BEGIN:VEVENT',
      `UID:${model.uid}`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(model.start)}`,
      `DTEND:${icsDate(model.end)}`,
      `SUMMARY:${model.summary}`,
      `ORGANIZER:mailto:${model.organizer}`,
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
  }

  public async renderToFile(template: string, model: IMeetingInvite, filePath: string): Promise<void> {
    const content = await this.render(template, model);
    ensureParentDir(filePath);
    await writeFile(filePath, content, 'utf-8');
  }
}

async function main() {
  // the module above must be imported before Templates is resolved for the first time
  const templates = await DI.resolve(Templates);

  await templates.compileToFile(
    'meeting',
    'ics',
    {
      uid: 'sprint-review-42@example.com',
      summary: 'Sprint review',
      start: new Date('2026-10-20T10:00:00Z'),
      end: new Date('2026-10-20T11:00:00Z'),
      organizer: 'pm@example.com',
    },
    './out/sprint-review.ics',
  );
}

void main();
```

### `TemplateRenderer`: replace a shipped renderer

Two renderers with one extension do not merge: the first registered wins. To take over `.pug`, unregister the shipped class before `Templates` is first resolved, eg. in your app's entry module.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { PugRenderer } from '@spinajs/templates-pug';

@Injectable(TemplateRenderer)
export class FakePugRenderer extends TemplateRenderer {
  public get Type() {
    return 'pug';
  }

  public get Extension() {
    return '.pug';
  }

  // Stub for tests: records the call instead of rendering
  public readonly calls: Array<{ template: string; model: unknown }> = [];

  public async render(template: string, model: unknown): Promise<string> {
    this.calls.push({ template, model });
    return `<rendered ${template}>`;
  }

  public async renderToFile(template: string, model: unknown): Promise<void> {
    await this.render(template, model);
  }
}

DI.unregister(PugRenderer);

async function main() {
  const templates = await DI.resolve(Templates);
  console.log(await templates.render('views/welcome.pug', { name: 'Alice' }));
}

void main();
```

### `TemplateRenderer`: extend a shipped renderer

Subclass the shipped class when you need its behaviour plus a change. The parent stays registered under `TemplateRenderer` by its own decorator, so unregister it; `unregister()` matches by class name and leaves your subclass in place. A full example is the hashed change token in [Compiled-template cache](03-compiled-template-cache.md#change-token-revalidate-by-content-hash); for compiled engines see [Compiled template renderer](07-compiled-template-renderer.md#extend-a-shipped-engine).

## Important behaviour

- Register every renderer before the first `DI.resolve(Templates)`. `Templates.Renderers` is filled once.
- Do **not** decorate a renderer with `@NewInstance()`. `Array.ofType` builds such a registration but leaves it out of the list, so `Templates` never sees it.
- A renderer registered with a factory (`DI.register(() => ...)`) is left out of the list for the same reason.
- `Extension` is compared with `path.extname()`, which returns only the last extension: `report.html.pug` matches `.pug`.
- `render()` receives `options` but nothing enforces its use; document whether your renderer reports progress.

## Best practices

- Give `Type` and `Extension` distinct, specific names; they are global for the whole app.
- Throw `InvalidArgument` from `@spinajs/exceptions` for a bad model, as `Csv` does, instead of letting a library throw a bare `TypeError`.
- Call `ensureParentDir()` before writing in `renderToFile()`; `Templates` does not create directories.
- Read config with `@Config('templates.<type>')`, the convention of the shipped renderers (`templates.pug`, `templates.handlebars`, `templates.csv`).

## Patterns and antipatterns

```ts
// Don't: a second `.handlebars` renderer is silently ignored while the shipped one is registered
@Injectable(TemplateRenderer)
class BrandedHandlebars extends HandlebarsRenderer {}

// Do: remove the shipped class so the subclass owns the extension
@Injectable(TemplateRenderer)
class BrandedHandlebars extends HandlebarsRenderer {}
DI.unregister(HandlebarsRenderer);
```

## Examples

### Pick a renderer by name from a `Map`

`TemplateRenderer` implements `IMappableService` with `ServiceName` = `Extension`, so a service can inject the renderers keyed by extension.

```ts sample
import '@spinajs/templates-handlebars';
import '@spinajs/templates-pug';
import { Autoinject, DI } from '@spinajs/di';
import { TemplateRenderer } from '@spinajs/templates';

class TemplateCatalog {
  @Autoinject(TemplateRenderer, { mapFunc: (r: TemplateRenderer) => r.ServiceName })
  protected Renderers: Map<string, TemplateRenderer>;

  public supported(): string[] {
    return [...this.Renderers.keys()];
  }
}

async function main() {
  const catalog = await DI.resolve(TemplateCatalog);
  console.log(catalog.supported()); // [ '.handlebars', '.pug' ]
}

void main();
```

## Related

- [Compiled template renderer](07-compiled-template-renderer.md): the base for file-compiling engines.
- [Multiple implementations](../di/06-multiple-implementations.md): list registration and its limits.
- [Registering services](../di/01-registering-services.md): `@Injectable` and `DI.unregister()`.
- [Render progress](04-render-progress.md#progress-reporting-in-a-renderer-report-phases-from-your-own-engine): report phases from a renderer.
