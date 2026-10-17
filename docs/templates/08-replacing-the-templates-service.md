# Replacing the `Templates` service

`Templates` is an ordinary DI class, so an app can register a subclass in its place. Every consumer, including `@spinajs/http`, `@spinajs/email-smtp-transport` and `@spinajs/queue-templates-pdf`, resolves the key `Templates` and gets your class.

Replace it to change how a renderer is chosen or what happens around every render. To add an engine, write a [custom renderer](06-custom-renderers.md) instead.

## How it works

1. You call `DI.register(MyTemplates).as(Templates)` before anything resolves `Templates`.
2. A consumer resolves `Templates` (`DI.resolve`, `@Autoinject`, `@Inject`, `@LazyInject` or `DI.get`). The container returns the last registration under the key: `MyTemplates`.
3. `MyTemplates` inherits the `@Inject(Intl)` dependency and the `@Autoinject(TemplateRenderer)` list.
4. The instance is a singleton, cached under the concrete class name; `DI.get(Templates)` returns it too.

## Contract

| Member | Overridable | Meaning |
| --- | --- | --- |
| `render()`, `renderToFile()`, `compile()`, `compileToFile()` | yes | The four render entry points; call `super` to keep selection, perf spans and redaction |
| `getRendererFor(extname)` | yes | Lookup by extension, without a perf span |
| `Renderers` | protected property | The injected renderer list, in registration order |
| `Log` | protected property | Logger `templates` |
| `engineByType()`, `engineByExtension()` | **no**, private | Selection used by the four entry points |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Templates` | The class `Templates`; singleton (default lifetime); resolved by type in every consumer | `Templates` | none shipped | `DI.register(MyTemplates).as(Templates)` before the first resolve; `@spinajs/http` resolves it while the server boots |

### `Templates`: add a default extension

Consumers that build template names from config, eg. `mail/welcome`, fail with `InvalidOperation` because the name has no extension. The subclass appends `templates.defaultExtension` when it is missing, then delegates to the shipped logic.

```ts sample
import '@spinajs/templates-handlebars';
import { extname } from 'path';
import { Config } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { IRenderOptions, Templates } from '@spinajs/templates';

export class DefaultExtensionTemplates extends Templates {
  @Config('templates.defaultExtension', { defaultValue: '.handlebars' })
  protected DefaultExtension: string;

  protected withExtension(template: string) {
    return extname(template) ? template : `${template}${this.DefaultExtension}`;
  }

  public async render(template: string, model: unknown, language?: string, options?: IRenderOptions): Promise<string> {
    return await super.render(this.withExtension(template), model, language, options);
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string, options?: IRenderOptions): Promise<void> {
    return await super.renderToFile(this.withExtension(template), model, filePath, language, options);
  }
}

// in the app entry module, before the HTTP server or a mailer resolves Templates
DI.register(DefaultExtensionTemplates).as(Templates);

async function main() {
  const templates = await DI.resolve(Templates);
  console.log(await templates.render('./views/mail/welcome', { name: 'Alice' }, 'en'));
}

void main();
```

## Important behaviour

- Register before the first resolve. An instance of the original `Templates` already cached stays in use by consumers that injected it.
- The private selection methods cannot be overridden. To change selection itself, filter `this.Renderers` in your override and call the renderer, then wrap the call in `Perf.measure()` if you need the span.
- A replacement that skips `super` also skips redaction and perf spans; reproduce them or keep `super`.

## Best practices

- Prefer wrapping (`super.render(...)`) over reimplementing; selection errors, spans and redaction stay consistent with the rest of the framework.
- Keep cross-cutting behaviour (default extension, tenant-specific template folders) here, and engine behaviour in renderers.

## Patterns and antipatterns

```ts
// Don't: registered after the HTTP server booted, so it keeps the original instance
await DI.resolve(HttpServer);
DI.register(DefaultExtensionTemplates).as(Templates);

// Do: register first, then boot
DI.register(DefaultExtensionTemplates).as(Templates);
await DI.resolve(HttpServer);
```

## Examples

### Serve per-tenant template overrides

A tenant can override any mail template by placing a file with the same name in its own provider. The subclass tries the tenant path first and falls back to the shared one.

```ts sample
import '@spinajs/templates-handlebars';
import { DI } from '@spinajs/di';
import { fs, URI } from '@spinajs/fs';
import { IRenderOptions, Templates } from '@spinajs/templates';

interface ITenantModel {
  tenantId?: string;
}

export class TenantTemplates extends Templates {
  public async render(template: string, model: unknown, language?: string, options?: IRenderOptions): Promise<string> {
    return await super.render(await this.tenantTemplate(template, model), model, language, options);
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string, options?: IRenderOptions): Promise<void> {
    return await super.renderToFile(await this.tenantTemplate(template, model), model, filePath, language, options);
  }

  // fs://templates/mail/x.handlebars -> fs://tenant-<id>/mail/x.handlebars, when that file exists
  protected async tenantTemplate(template: string, model: unknown): Promise<string> {
    const tenantId = (model as ITenantModel)?.tenantId;
    if (!tenantId || !template.startsWith('fs://templates/')) {
      return template;
    }

    const override = template.replace('fs://templates/', `fs://tenant-${tenantId}/`);
    return (await fs.exists(new URI(override))) ? override : template;
  }
}

DI.register(TenantTemplates).as(Templates);

async function main() {
  const templates = await DI.resolve(Templates);
  console.log(await templates.render('fs://templates/mail/invoice.handlebars', { tenantId: 'acme', total: 120 }, 'en'));
}

void main();
```

Each tenant needs a provider named `tenant-<id>` in `fs.providers`; an unknown provider name makes the render fail.

## Related

- [Rendering templates](01-rendering-templates.md): the methods you override.
- [Registering services](../di/01-registering-services.md): `register().as()` and when it takes effect.
- [Lifetimes](../di/04-lifetimes.md): how the singleton is cached.
