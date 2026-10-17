# `@spinajs/templates-mjml`

MJML renderer for `@spinajs/templates`: renders `.mjml` files through Handlebars and MJML into responsive, email-ready HTML.

## Usage

```ts
import '@spinajs/templates-handlebars';
import '@spinajs/templates-mjml';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';

const templates = await DI.resolve(Templates);
const html = await templates.render('./templates/welcome.mjml', { name: 'Ada' }, 'en');
```

## Documentation

- [Package overview](../../docs/template-mjml/README.md)
- [Rendering MJML templates](../../docs/template-mjml/01-rendering-mjml-templates.md)
- [Replacing or extending `MjmlRenderer`](../../docs/template-mjml/02-mjml-renderer-extension.md)
