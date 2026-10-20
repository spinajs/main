# `@spinajs/templates-pug`

Adds the [pug](https://pugjs.org) engine to [`@spinajs/templates`](../templates/README.md). Importing the package registers `PugRenderer`, so `Templates` renders every `.pug` file, with the `@spinajs/intl` translation helpers available inside the template.

It does **not** pick template folders for you: `system.dirs.templates` is not read, so pass an absolute path, a path relative to the process working directory, or an `fs://` URI. It does **not** render strings; pug always compiles from a file so that `include` and `extends` work.

## Install

```sh
npm install @spinajs/templates @spinajs/templates-pug
```

## Features

| Feature | What it does |
| --- | --- |
| [Rendering pug templates](01-rendering-pug-templates.md) | `Templates.render()` and `renderToFile()` for `.pug` files, `fs://` sources, pug options, compile caching. |
| [Translation helpers](02-translation-helpers.md) | `__`, `__n`, `__l` and `__h` inside templates, and how the render language is chosen. |
| [Customizing `PugRenderer`](03-customizing-pug-renderer.md) | The DI registration of `PugRenderer`; replace it with a subclass that adds template helpers or post-processes output. |
| [Additional pug engines](04-additional-pug-engines.md) | Register more pug-based engines beside the default one: another file extension, or another engine type with its own options. |

## Quick start

Import the package once, anywhere before `Templates` is first resolved, then render a `.pug` file:

```ts sample
import { join } from 'path';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-pug';

async function renderWelcomePage(userName: string): Promise<string> {
  const templates = await DI.resolve(Templates);

  return await templates.render(join(process.cwd(), 'templates', 'welcome.pug'), { user: { name: userName } }, 'en');
}
```

```pug
//- templates/welcome.pug
h1= __('welcome.title')
p Hello #{user.name}
```

## Related packages

- [`@spinajs/templates`](../templates/README.md): the `Templates` service, the `TemplateRenderer` and `CompiledTemplateRenderer` bases, and the `templates.cache.mode` setting.
- [`@spinajs/intl`](../intl/README.md): the translation functions bound to `__`, `__n`, `__l` and `__h`.
- [`@spinajs/fs`](../fs/README.md): resolves `fs://<provider>/<path>` template sources.
- [`@spinajs/http`](../http/README.md): renders HTML responses and error pages with pug through this package.
- [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md): renders a `.pug` template with this package, then prints it to PDF.
- [`@spinajs/email`](../email/README.md): mail bodies can be `.pug` templates.
