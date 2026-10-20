# `@spinajs/templates-mjml`

Renders `.mjml` files into responsive, email-ready HTML. It plugs one renderer, `MjmlRenderer`, into the [`@spinajs/templates`](../templates/README.md) facade: a template is first run through Handlebars with your model, then compiled by [MJML](https://mjml.io).

Importing it also registers the Handlebars renderer it depends on (`@spinajs/templates-handlebars`). It does **not** send mail: [`@spinajs/email-smtp-transport`](../email-smtp-transport/README.md) renders a `.mjml` template through `Templates` and sends the result.

The package directory is `packages/template-mjml`; the npm name is `@spinajs/templates-mjml`.

## Install

```sh
npm install @spinajs/templates-mjml @spinajs/templates-handlebars
```

## Features

| Feature | What it does |
| --- | --- |
| [Rendering MJML templates](01-rendering-mjml-templates.md) | `Templates.render()` on a `.mjml` file: the Handlebars pass, the MJML compile, `templates.mjml` options, validation and `mj-include`. |
| [Replacing or extending `MjmlRenderer`](02-mjml-renderer-extension.md) | The `TemplateRenderer` plugin registration, the Handlebars pre-pass lookup, swapping the renderer, adding a second MJML variant and MJML-level hooks. |

## Extension points at a glance

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| MJML renderer | `TemplateRenderer` (list element), singleton, registered by `@Injectable(TemplateRenderer)` on import | `MjmlRenderer` (`Type` `mjml`, `Extension` `.mjml`) | your subclass | `DI.unregister(MjmlRenderer)` plus your `@Injectable(TemplateRenderer)` subclass, or a variant with its own `Type` and `Extension`; see [02](02-mjml-renderer-extension.md) |
| Handlebars pre-pass | the `TemplateRenderer` whose `Type` is `'handlebars'`, looked up on every render | `HandlebarsRenderer` from `@spinajs/templates-handlebars` | any renderer with `Type` `'handlebars'` | register or replace it in `@spinajs/templates-handlebars`; see [02](02-mjml-renderer-extension.md#the-handlebars-pre-pass) |
| MJML compiler hooks | config key `templates.mjml`, read on every render | MJML defaults | `preprocessors`, `skeleton`, `fonts`, `mjmlConfigPath` | set the key; see [01](01-rendering-mjml-templates.md#configuration) |

## Quick start

`templates/welcome.mjml`:

```xml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Welcome, {{name}}!</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```

```ts sample
import '@spinajs/templates-handlebars';
import '@spinajs/templates-mjml';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Templates } from '@spinajs/templates';

export async function renderWelcome(name: string): Promise<string> {
  await DI.resolve(Configuration);
  const templates = await DI.resolve(Templates);

  // picked by the `.mjml` extension
  return await templates.render('./templates/welcome.mjml', { name }, 'en');
}
```

## Related packages

- [`@spinajs/templates`](../templates/README.md): the `Templates` facade and the `TemplateRenderer` base class this package implements.
- [`@spinajs/templates-handlebars`](../templates-handlebars/README.md): runs the Handlebars pass and supplies its helpers (`__`, dates, math, text).
- [`@spinajs/email-smtp-transport`](../email-smtp-transport/README.md): renders `IEmail.template` through `Templates`, so a `.mjml` mail template works there.
- [`@spinajs/fs`](../fs/README.md): serves `fs://` template URIs.
- [`@spinajs/di`](../di/README.md): [multiple implementations](../di/06-multiple-implementations.md) explains the `TemplateRenderer` list.
- [`@spinajs/configuration`](../configuration/README.md): supplies `templates.mjml`.
