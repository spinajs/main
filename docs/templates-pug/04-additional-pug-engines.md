# Additional pug engines

Register a `PugRenderer` subclass with its own `Type` or `Extension` to run a second pug engine beside the default one. Use it to render legacy `.jade` files, or to compile one set of templates with different pug options, without touching how `.pug` files render elsewhere.

## How it works

1. A subclass decorated `@Injectable(TemplateRenderer)` is appended to the `TemplateRenderer` list. `PugRenderer` stays registered; nothing is unregistered.
2. `Templates` gets every engine through `Array.ofType(TemplateRenderer)`, once, on its first resolve. Register the subclass before that.
3. `Templates.render()` and `renderToFile()` pick the first engine whose `Extension` matches the file. A subclass with a new extension (`.jade`) handles those files.
4. `Templates.compile(template, type, ...)` and `compileToFile()` pick the first engine whose `Type` matches. A subclass with a new type (`pug-mail`) is reached this way, whatever the file extension.
5. `PugRenderer` is always registered before a subclass, because the subclass module imports it. A subclass that keeps `Extension` `.pug` is therefore never picked by `render()`; it is reachable by type only.
6. Each engine is its own singleton with its own compile cache and its own `Options`.

## Configuration

Each engine reads the keys its `@Config` decorators name. A subclass inherits `templates.pug` unless it redeclares `Options`:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `templates.pug` | `pug.Options` | unset | pug options | Options of `PugRenderer` and of every subclass that does not redeclare `Options` |
| `<your key>`, eg. `templates.pugMail` | `pug.Options` | unset | pug options | Options of a subclass that redeclares `@Config('<your key>') protected Options` |
| `templates.cache.mode` | `'cache' \| 'revalidate' \| 'always'` | dev: `always`, else `cache` | | Shared by all engines; see [Rendering pug templates](01-rendering-pug-templates.md#configuration) |

```ts
// config/templates.ts in your app
export default {
  templates: {
    pug: { doctype: 'html' },
    pugMail: {
      doctype: 'html',
      // `:inlineCss` blocks in mail templates become a <style> element at compile time
      filters: { inlineCss: (css: string) => `<style>${css}</style>` },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Engine list | `TemplateRenderer`, each element a singleton; resolved by `Templates` as `Array.ofType(TemplateRenderer)` | `PugRenderer` plus the engines of other imported packages (`HandlebarsRenderer`, ...) | Your `PugRenderer` subclass | Add: `@Injectable(TemplateRenderer)` on a subclass with its own `Type` and/or `Extension`, before the first `DI.resolve(Templates)` |
| Engine selection | `Templates.render()` by `Extension`, `Templates.compile()` by `Type` | first match in registration order | | Give each engine a unique `Type`; give it a unique `Extension` when `render()` should reach it |
| Engine options | `@Config` on `Options` | `templates.pug` | | Redeclare `@Config('<key>') protected Options: pug.Options` in the subclass |

### Additional engine: render legacy `.jade` files

Pug is the renamed Jade, and most `.jade` files compile unchanged. Claim the extension and keep everything else.

```ts sample
import { join } from 'path';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { PugRenderer } from '@spinajs/templates-pug';

@Injectable(TemplateRenderer)
class JadeRenderer extends PugRenderer {
  public get Type() {
    return 'jade';
  }

  public get Extension() {
    return '.jade';
  }
}

async function renderLegacyReport(reportId: string): Promise<string> {
  const templates = await DI.resolve(Templates);

  // `.jade` goes to JadeRenderer, `.pug` still goes to PugRenderer
  return await templates.render(join(process.cwd(), 'legacy', 'reports', 'monthly.jade'), { reportId }, 'en');
}
```

### Additional engine: mail templates with their own pug options

Mail and web pages share `.pug` files and partials but need different options. Register a type-only engine, give it its own config key, and select it by type.

```ts sample
import * as pug from 'pug';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { PugRenderer } from '@spinajs/templates-pug';

@Injectable(TemplateRenderer)
class MailPugRenderer extends PugRenderer {
  @Config('templates.pugMail')
  protected Options: pug.Options;

  public get Type() {
    return 'pug-mail';
  }
}

async function renderWelcomeMail(firstName: string, language: string): Promise<string> {
  const templates = await DI.resolve(Templates);

  // render() would pick PugRenderer for `.pug`; compile() selects this engine by type
  return await templates.compile('fs://mail-templates/welcome.pug', 'pug-mail', { firstName }, language);
}
```

## Important behaviour

- **Duplicate extension, first wins.** Two engines with `Extension` `.pug`: `render()` always uses the one registered first, which is `PugRenderer`.
- **Duplicate type, first wins.** Keep `Type` unique; a subclass that keeps `'pug'` is unreachable by `compile()` too.
- **Each engine compiles separately.** The same file rendered through two engines is compiled and cached twice.
- **Registration after the first `DI.resolve(Templates)` is ignored** by that `Templates` instance.
- **`ServiceName` is `Extension`.** `TemplateRenderer` implements `IMappableService` with the extension as the name; `Templates` does not use it.

## Best practices

- Name the type after the purpose (`pug-mail`, `pug-pdf`), not the options, so call sites read as intent.
- Keep shared partials engine-agnostic: both engines compile them, with their own options.
- Use a type-only engine instead of passing options per call; `Templates` has no per-call options for pug.

## Patterns and antipatterns

```ts
// Don't: a second engine with the default type and extension is unreachable
@Injectable(TemplateRenderer)
class PrettyPugRenderer extends PugRenderer {}

// Do: give it its own type and select it with compile()
@Injectable(TemplateRenderer)
class PrettyPugRenderer extends PugRenderer {
  public get Type() {
    return 'pug-pretty';
  }
}
// await templates.compile(path, 'pug-pretty', model);
```

## Examples

### Write mail previews to disk with the mail engine

```ts sample
import { join } from 'path';
import * as pug from 'pug';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { PugRenderer } from '@spinajs/templates-pug';

@Injectable(TemplateRenderer)
class MailPugRenderer extends PugRenderer {
  @Config('templates.pugMail')
  protected Options: pug.Options;

  public get Type() {
    return 'pug-mail';
  }
}

async function writeMailPreviews(templateNames: string[], language: string): Promise<string[]> {
  const templates = await DI.resolve(Templates);
  const outDir = join(process.cwd(), 'storage', 'mail-previews', language);
  const written: string[] = [];

  for (const name of templateNames) {
    const output = join(outDir, `${name}.html`);
    await templates.compileToFile(`fs://mail-templates/${name}.pug`, 'pug-mail', { firstName: 'Preview' }, output, language);
    written.push(output);
  }

  return written;
}
```

## Related

- [Customizing `PugRenderer`](03-customizing-pug-renderer.md): replace the default engine instead of adding one.
- [Rendering pug templates](01-rendering-pug-templates.md): `render()` versus `compile()`.
- [`@spinajs/templates`](../templates/README.md): `Templates` and the engines of other packages.
- [`@spinajs/di`](../di/06-multiple-implementations.md): how `Array.ofType` builds the engine list.
