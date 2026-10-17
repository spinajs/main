# `@spinajs/templates-image`

Renders Pug templates and raw HTML to screenshot images (PNG, JPEG, WebP) in headless Chromium. It adds the `ImageRenderer` template engine to `@spinajs/templates` and the `render-image` CLI command.

It does **not** render to a string: `render()` throws `NotSupported`. It does **not** compile Handlebars or other engines through `renderToFile()`: the source is always a sibling `.pug` file. It does **not** compare images; the CLI only produces them.

## Install

```sh
npm install @spinajs/templates-image
```

The package pulls in `puppeteer`, which downloads a Chromium build on install. Point `templates.image.executablePath` at an installed Chrome when the download is not possible ([Configuration](02-configuration.md)).

## Features

| Feature | What it does |
| --- | --- |
| [Image renderer](01-image-renderer.md) | `ImageRenderer`: renders `<name>.pug` or raw HTML to an image file through `Templates` or a directly resolved renderer |
| [Configuration](02-configuration.md) | `templates.image`: browser launch options, asset server ports, timeouts, debug mode |
| [`render-image` command](03-render-image-command.md) | CLI command that turns an HTML file or a template into a PNG or JPEG, for CI visual checks |
| [Custom image renderers](04-custom-image-renderers.md) | Subclass `ImageRenderer`, add renderers for new extensions, replace the default one, override the Puppeteer hooks |

## Quick start

A template `templates/welcome-card.pug`:

```pug
div.card
  h1 Welcome, #{name}
```

Render it to a PNG:

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-image';

async function renderWelcomeCard(name: string): Promise<void> {
  await DI.resolve(Configuration);
  const templates = await DI.resolve(Templates);

  // `.png` selects ImageRenderer, which compiles the sibling `welcome-card.pug`.
  await templates.renderToFile('templates/welcome-card.png', { name }, `out/welcome-${name}.png`);

  // Closes the pooled Chromium so the process can exit.
  await DI.dispose();
}

void renderWelcomeCard('anna');
```

## Related packages

- [`@spinajs/templates`](../templates/README.md): the `Templates` facade and the `TemplateRenderer` base that `ImageRenderer` plugs into.
- [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md): `PuppeteerRenderer`, the browser pool, the asset server and progress reporting `ImageRenderer` inherits.
- [`@spinajs/templates-pdf`](../templates-pdf/README.md): the PDF sibling of this package, built on the same base.
- [`@spinajs/templates-pug`](../templates-pug/README.md): compiles the `.pug` source before the screenshot.
- [`@spinajs/cli`](../cli/README.md): runs the `render-image` command.
- [`@spinajs/di`](../di/README.md): registration, `@PerInstanceCheck()` and list resolution used by the renderer.
