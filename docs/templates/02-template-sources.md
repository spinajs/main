# Template sources

A template argument is either a bare path on local disk or an `fs://<provider>/<path>` URI that names an `@spinajs/fs` provider. URIs let you keep templates on S3, FTP or any other provider without changing the render call.

## How it works

`TemplateRenderer` decides with `isUri(template)`: a string that starts with `fs://` is a URI, anything else is a bare path.

| Helper (protected on `TemplateRenderer`) | Bare path | `fs://` URI |
| --- | --- | --- |
| `normalizeTemplate(template)` | `path.normalize(template)` | returned unchanged |
| `resolveContent(template)` | `readFile(template, 'utf-8')` from `fs/promises` | `fs.read(new URI(template), 'utf-8')`; a `Buffer` is decoded as UTF-8 |
| `resolveLocalPath(template)` | returned unchanged | `fs.download(new URI(template))`: a local provider returns the resolved path, a remote one downloads a copy first |
| `changeToken(template)` | `stat()`: `<mtimeMs>\|<size>` | `fs.stat(uri)`: `Version`, else `<ModifiedTime ms>\|<Size>` |

Engines use the helper that fits them:

1. An engine that compiles from a string (handlebars) calls `resolveContent()`.
2. An engine that compiles from a file and resolves `include` / `extends` itself (pug) calls `resolveLocalPath()`.
3. The [compiled-template cache](03-compiled-template-cache.md) keys entries by `normalizeTemplate()` and revalidates them with `changeToken()`.

`Templates` selects the renderer from the extension of the whole string, so `fs://mail/welcome.handlebars` selects the handlebars renderer like `./views/welcome.handlebars` does.

## Configuration

`fs://` URIs need a provider registered in `@spinajs/fs`. The provider name is the URI host.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.providers` | `array` | set by `@spinajs/fs` | `{ service, name, basePath, ... }` entries | A provider named `templates` serves `fs://templates/...` |

```ts
// config/fs.ts in your application
export default {
  fs: {
    providers: [{ service: 'fsNative', name: 'templates', basePath: '/srv/app/views' }],
  },
};
```

See [Providers and configuration](../fs/01-providers-and-configuration.md) for every provider option.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Source loading | Protected methods of `TemplateRenderer`; each renderer is its own singleton | `resolveContent()`, `resolveLocalPath()` as above | none shipped | Override them in your renderer subclass, eg. to read from a database. See [Custom renderers](06-custom-renderers.md) |
| Template storage | An `@spinajs/fs` provider, by name from `fs.providers` | `fsNative` | `fsS3`, `fsFTP`, `fsOneDrive` and your own provider | Register a provider and use its name in the URI. See [Custom providers](../fs/06-custom-providers.md) |

### Source loading: read templates from your own store

Override `resolveContent()` when templates live in a store that is not an `@spinajs/fs` provider. Keep the default for every other source, so local and `fs://` paths still work.

```ts sample
import { Injectable } from '@spinajs/di';
import { CompiledTemplateRenderer, TemplateRenderer } from '@spinajs/templates';

// Stand-in for a CMS or database table that holds editable mail templates.
const editableTemplates = new Map<string, string>([['cms://reset-password.txt', 'Hi {{name}}, open {{link}} to set a new password.']]);

@Injectable(TemplateRenderer)
export class CmsTextRenderer extends CompiledTemplateRenderer {
  public get Type() {
    return 'cms-text';
  }

  public get Extension() {
    return '.txt';
  }

  protected async resolveContent(template: string): Promise<string> {
    const stored = editableTemplates.get(template);
    return stored ?? (await super.resolveContent(template));
  }

  protected async compile(template: string) {
    const source = await this.resolveContent(template);
    return (locals: Record<string, unknown>) => source.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => String(locals[key] ?? ''));
  }

  protected buildContext(model: unknown, language: string): Record<string, unknown> {
    return { ...(model as object), lang: language };
  }
}
```

A `cms://` key is not an `fs://` URI, so `changeToken()` cannot stat it. Use the `cache` mode for such sources, or override `changeToken()` too.

## Important behaviour

- A bare path is read straight from local disk, relative to the process working directory. It is **never** routed through `fs.defaultProvider`.
- An `fs://` URI with an unregistered provider name rejects; the error comes from `@spinajs/fs`.
- `normalizeTemplate()` keeps URIs as they are: `path.normalize()` would turn `fs://name/x` into `fs:\name\x` on Windows.
- `./views/a.pug` and `views/a.pug` normalize to the same cache key; a relative and an absolute path to one file are two keys.
- For a remote provider, `resolveLocalPath()` downloads the named file only. A pug `include` of a sibling file resolves against the downloaded copy's folder.

## Best practices

- Name a dedicated provider for templates (`fs://templates/...`) instead of building absolute paths from `__dirname`; deployments then move templates by changing config only.
- Keep pug templates that use `include` or `extends` on a local provider.

## Patterns and antipatterns

```ts
// Don't: concatenating a provider base path couples code to one deployment layout
await templates.render(`${process.env.VIEWS_DIR}/mail/welcome.handlebars`, model);

// Do: address the provider by name and let config place it
await templates.render('fs://templates/mail/welcome.handlebars', model);
```

## Examples

### Render an invoice template stored on a named provider

```ts sample
import '@spinajs/templates-handlebars';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';

async function renderInvoice(invoiceNo: string, total: number) {
  const templates = await DI.resolve(Templates);

  // `templates` is a provider configured in fs.providers
  return await templates.render('fs://templates/billing/invoice.handlebars', { invoiceNo, total }, 'en');
}

void renderInvoice('FV/2026/10/17', 1230);
```

## Related

- [File operations](../fs/02-file-operations.md): `read`, `download` and `stat` used by the helpers.
- [Compiled-template cache](03-compiled-template-cache.md): how `changeToken()` decides a recompile.
- [Custom renderers](06-custom-renderers.md): use the helpers in your own engine.
