# `@spinajs/templates`

The template rendering service of SpinaJS. `Templates` picks a renderer by file extension or by renderer type, renders a model to a string or a file, and times every render. Renderers are plugins: each engine package registers a `TemplateRenderer` subclass.

This package ships **no** renderer. Install at least one engine package, eg. `@spinajs/templates-handlebars` or `@spinajs/templates-pug`, or write your own.

## Install

```sh
npm install @spinajs/templates
```

## Features

| Feature | What it does |
| --- | --- |
| [Rendering templates](01-rendering-templates.md) | The `Templates` service: render by extension or by renderer type, to a string or a file |
| [Template sources](02-template-sources.md) | Bare local paths and `fs://<provider>/<path>` URIs from `@spinajs/fs` |
| [Compiled-template cache](03-compiled-template-cache.md) | `templates.cache.mode`: compile once, revalidate on change, or recompile always |
| [Render progress](04-render-progress.md) | `onProgress` callbacks, `RenderPhase`, and the CLI progress line |
| [Secret redaction](05-secret-redaction.md) | `redact` keeps tokens out of render errors and perf spans |
| [Custom renderers](06-custom-renderers.md) | Add an engine or output format with a `TemplateRenderer` subclass |
| [Compiled template renderer](07-compiled-template-renderer.md) | `CompiledTemplateRenderer`: the base for engines that compile a file into a delegate |
| [Replacing the `Templates` service](08-replacing-the-templates-service.md) | Subclass `Templates` and register it in its place |
| [CLI command and helpers](09-cli-command-and-helpers.md) | `template-render` and the helpers for your own render commands |

## Quick start

```ts sample
import '@spinajs/templates-handlebars';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';

async function main() {
  const templates = await DI.resolve(Templates);

  // the `.handlebars` extension selects HandlebarsRenderer
  const html = await templates.render('./views/mail/welcome.handlebars', { name: 'Alice' }, 'en');
  console.log(html);
}

void main();
```

## Related packages

- [`@spinajs/di`](../di/README.md): renderers are collected as a list of `TemplateRenderer` registrations.
- [`@spinajs/fs`](../fs/README.md): `fs://` template URIs and the change tokens of the cache.
- [`@spinajs/intl`](../intl/README.md): `Templates` initializes `Intl`; compiled engines resolve the render language through it.
- [`@spinajs/log`](../log/README.md): `template.render` and `template.compile` perf spans.
- [`@spinajs/cli`](../cli/README.md): runs the `template-render` command.
- Renderers: [`@spinajs/templates-handlebars`](../templates-handlebars/README.md), [`@spinajs/templates-pug`](../templates-pug/README.md), [`@spinajs/templates-mjml`](../template-mjml/README.md), [`@spinajs/templates-csv`](../templates-csv/README.md), [`@spinajs/templates-xlsx`](../templates-xlsx/README.md), [`@spinajs/templates-pdf`](../templates-pdf/README.md), [`@spinajs/templates-image`](../templates-image/README.md), and their base [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md).
- [`@spinajs/email`](../email/README.md): renders e-mail bodies through `Templates`.
- [`@spinajs/http`](../http/README.md): renders HTML responses through `Templates`.
- [`@spinajs/queue-templates-pdf`](../queue-templates-pdf/README.md): renders PDFs in a queue worker.
