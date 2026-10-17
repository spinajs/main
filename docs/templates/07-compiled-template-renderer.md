# Compiled template renderer

`CompiledTemplateRenderer<TDelegate>` is the base for engines that compile a template file into a function and call it with locals: `HandlebarsRenderer` and `PugRenderer` extend it. A subclass supplies two methods, `compile()` and `buildContext()`; the base handles validation, caching, language, timing and writing files.

## How it works

`render(templateName, model, language?)`:

1. An empty `templateName` throws `InvalidArgument` `template parameter cannot be null or empty`.
2. `Log.trace` and `Log.timeStart('<ClassName>.render.<templateName>')` start the timing.
3. `withCache(templateName, () => this.compile(templateName))` returns the cached delegate or compiles one ([Compiled-template cache](03-compiled-template-cache.md)).
4. `resolveLanguage(language)` picks the language: the argument, else `guessLanguage()` (the language of the current request), else `defaultLanguage()` (`intl.defaultLocale`).
5. `buildContext(model, language)` builds the locals; the delegate is called with them.
6. `Log.timeEnd()` and a `trace` entry `Rendering template ... ended, (<ms> ms)` close the timing; the string is returned.

`renderToFile(template, model, filePath, language?)` calls `render()`, then `ensureParentDir(filePath)` and `fs.writeFileSync(filePath, content)`.

## Contract

| Member | Kind | Meaning |
| --- | --- | --- |
| `TDelegate` | type parameter | The compiled function; must extend `CompiledTemplate` = `(locals: any) => string` |
| `compile(template)` | abstract, protected | Compile a bare path or `fs://` URI into a delegate. Runs only on a cache miss |
| `buildContext(model, language)` | abstract, protected | The locals passed to the delegate: the model merged with engine helpers |
| `resolveLanguage(language?)` | protected | Overridable language fallback |
| `render()`, `renderToFile()` | public | Implemented as above; override `renderToFile()` when output is not a string written as is |
| `Type`, `Extension` | abstract | Inherited from [`TemplateRenderer`](06-custom-renderers.md#contract) |

| Shipped subclass | `compile()` reads the source with | `buildContext()` adds |
| --- | --- | --- |
| `HandlebarsRenderer` | `resolveContent()`; an empty file throws `IOFail` | `lang` |
| `PugRenderer` | `resolveLocalPath()` and `pug.compileFile()` | `__`, `__n`, `__l`, `__h` translation helpers |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `CompiledTemplateRenderer` | Abstract base; a subclass registers under `TemplateRenderer` with `@Injectable(TemplateRenderer)` | none | `HandlebarsRenderer`, `PugRenderer` | Implement `compile()` and `buildContext()`. Override `resolveLanguage()` for another language fallback, `renderToFile()` for another write |
| Locals of a shipped engine | `buildContext()` of `HandlebarsRenderer` / `PugRenderer` | as in the table above | — | Subclass the engine, override `buildContext()`, `DI.unregister()` the parent |

### `CompiledTemplateRenderer`: a plain-text engine with translations

Plain-text alternatives of HTML mails need placeholders and translations, not markup. The sample compiles `{{ name }}` placeholders and `{{ __ "phrase" }}` translations.

```ts sample
import { Injectable } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { __translate } from '@spinajs/intl';
import { CompiledTemplateRenderer, TemplateRenderer } from '@spinajs/templates';

type TextDelegate = (locals: Record<string, unknown>) => string;

@Injectable(TemplateRenderer)
export class PlainTextRenderer extends CompiledTemplateRenderer<TextDelegate> {
  public get Type() {
    return 'text';
  }

  public get Extension() {
    return '.txt';
  }

  protected async compile(template: string): Promise<TextDelegate> {
    const source = await this.resolveContent(template);
    if (source.length === 0) {
      throw new IOFail(`Template file ${template} is empty`);
    }

    return (locals) =>
      source
        .replace(/\{\{\s*__\s+"([^"]+)"\s*\}\}/g, (_, phrase: string) => (locals.__ as (p: string) => string)(phrase))
        .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => String(locals[key] ?? ''));
  }

  protected buildContext(model: unknown, language: string): Record<string, unknown> {
    // a fresh object, so the caller's model is never mutated
    return { ...(model as object), lang: language, __: __translate(language) };
  }
}
```

### Extend a shipped engine

Every handlebars template of an app needs the product name and the current year. Override `buildContext()` in a `HandlebarsRenderer` subclass and remove the parent from the list.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { HandlebarsRenderer } from '@spinajs/templates-handlebars';

@Injectable(TemplateRenderer)
export class BrandedHandlebarsRenderer extends HandlebarsRenderer {
  protected buildContext(model: unknown, language: string): Record<string, unknown> {
    return {
      appName: 'Acme Billing',
      year: new Date().getFullYear(),
      ...super.buildContext(model, language),
    };
  }
}

// before the first DI.resolve(Templates)
DI.unregister(HandlebarsRenderer);

async function main() {
  const templates = await DI.resolve(Templates);
  console.log(await templates.render('./views/mail/footer.handlebars', { name: 'Alice' }, 'en'));
}

void main();
```

The model's own `appName` or `year` wins, because `super.buildContext()` is spread last.

## Important behaviour

- `render()` and `renderToFile()` of this base take no `options` argument: `onProgress` is ignored. `redact` still applies, since `Templates` redacts around the renderer.
- `renderToFile()` writes synchronously with `fs.writeFileSync` after rendering the whole string.
- The timer label is per template name; two concurrent renders of the same template share it.
- Locals come from `buildContext()` only. The shipped engines merge into a fresh object, so the caller's model is never mutated; keep that in your override.
- A compile error is not cached: the next render compiles again.

## Best practices

- Compile from a string with `resolveContent()` when the engine allows it; it reads both local paths and `fs://` URIs.
- Use `resolveLocalPath()` only for engines that resolve includes from disk, like pug.
- Put engine options under `templates.<type>` and read them with `@Config`, as `templates.handlebars` and `templates.pug` do.

## Patterns and antipatterns

```ts
// Don't: mutates the caller's model, which may be reused for the next recipient
protected buildContext(model: any, language: string) {
  model.lang = language;
  return model;
}

// Do: build fresh locals
protected buildContext(model: unknown, language: string) {
  return { ...(model as object), lang: language };
}
```

## Examples

### Render the plain-text part of a mail in the request language

```ts sample
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';

// PlainTextRenderer from the sample above is imported by the application entry module.
async function textBody(name: string) {
  const templates = await DI.resolve(Templates);

  // no language: the request language, else intl.defaultLocale
  return await templates.compile('fs://templates/mail/welcome.txt', 'text', { name });
}

void textBody('Alice');
```

## Related

- [Custom renderers](06-custom-renderers.md): the `TemplateRenderer` contract and registration.
- [Compiled-template cache](03-compiled-template-cache.md): what `withCache()` does with the delegate.
- [Request language](../intl/04-request-language.md): `guessLanguage()` and the `__translate*` helpers.
