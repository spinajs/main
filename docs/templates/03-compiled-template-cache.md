# Compiled-template cache

Renderers that compile templates (handlebars, pug and your own `CompiledTemplateRenderer` subclasses) keep the compiled result in memory. `templates.cache.mode` decides when a cached result is reused: always, until the source changes, or never.

## How it works

`TemplateRenderer.withCache(template, compile)` runs for every render of a caching renderer:

1. `CacheMode` picks the mode: `templates.cache.mode` when set; otherwise `always` when `configuration.isDevelopment` is `true`, else `cache`.
2. `always`: `compile()` runs and nothing is stored.
3. The key is `normalizeTemplate(template)`; the entry is read from the renderer's `Cache` map.
4. `cache`: an existing entry is returned. A miss runs `compile()` and stores `{ compiled, token: null }`.
5. `revalidate`: `changeToken(template)` reads the source's change token ([Template sources](02-template-sources.md#how-it-works)).
   - Entry exists and the token equals the stored one: the entry is returned.
   - Entry exists and the token is `null` (stat failed): the entry is returned and a `warn` is logged on the `renderer` logger.
   - Otherwise `compile()` runs and `{ compiled, token }` is stored.
6. The compiled result is returned to the renderer, which applies the model to it.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `templates.cache.mode` | `TemplateCacheMode` | not set | `'cache'`, `'revalidate'`, `'always'` | How compiled templates are reused. Explicit value wins over dev mode |
| `configuration.isDevelopment` | `boolean` | from `APP_ENV` / `NODE_ENV`; read as `false` when missing | `true`, `false` | With no `templates.cache.mode`, `true` means `always` and `false` means `cache` |

| Mode | Compiles | Picks up source edits | Cost per render |
| --- | --- | --- | --- |
| `cache` | once per key | no, until restart | a map lookup |
| `revalidate` | on first render and after each change | yes | one `stat()` (local or through the provider) |
| `always` | on every render | yes | a full read and compile |

The package config leaves `mode` unset on purpose: a shipped value would disable the dev and production fallback.

```ts
// config/templates.ts in your application: edit templates on a running server
export default {
  templates: {
    cache: {
      mode: 'revalidate',
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Cache policy | Protected `CacheMode` getter of `TemplateRenderer`; one `Cache` map per renderer instance | config, then dev mode | none shipped | Override `CacheMode` in a renderer subclass to fix the mode for one engine |
| Change token | Protected `changeToken()` and `tokenFromStat()` of `TemplateRenderer` | local `<mtimeMs>\|<size>`; provider `Version`, else `<ModifiedTime ms>\|<Size>` | none shipped | Override to use a content hash or a version from your store. Return `null` for "cannot tell" |
| Compiled-result cache | Protected `withCache(template, compile)` of `TemplateRenderer` | the flow above | none shipped | Call it from your renderer's `render()`; `CompiledTemplateRenderer` already does |

### Change token: revalidate by content hash

Filesystems with a coarse modification time can miss two edits of the same size within one tick. A content hash catches every edit, at the cost of reading the file on each render. The sample replaces the shipped handlebars renderer with a subclass that hashes local files.

```ts sample
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { HandlebarsRenderer } from '@spinajs/templates-handlebars';

@Injectable(TemplateRenderer)
export class HashedHandlebarsRenderer extends HandlebarsRenderer {
  protected async changeToken(template: string): Promise<string | null> {
    if (this.isUri(template)) {
      return await super.changeToken(template);
    }

    try {
      return createHash('sha1').update(await readFile(template)).digest('hex');
    } catch {
      return null;
    }
  }
}

// The original registers itself on import and would win `.handlebars`, so remove it
// before Templates is resolved for the first time.
DI.unregister(HandlebarsRenderer);

async function main() {
  const templates = await DI.resolve(Templates);
  console.log(templates.getRendererFor('.handlebars') instanceof HashedHandlebarsRenderer);
}

void main();
```

## Important behaviour

- Each renderer instance has its own `Cache`. Entries are never evicted; memory grows with the number of distinct template keys.
- Concurrent first renders of one template share a single `compile()` call. Entries are never evicted.
- `revalidate` prefers a stale entry over a failed render when `stat()` fails, and logs `Cannot stat template ...`.
- A miss in `revalidate` whose `stat()` failed stores the token `null`; the next successful `stat()` recompiles.
- Renderers that do not call `withCache()` do not cache: csv, xlsx, mjml (its handlebars step is cached by the handlebars renderer) and the puppeteer renderers (their pug step is cached by the pug renderer).
- `configuration.isDevelopment` and `templates.cache.mode` are read on every render, so changing them with `Configuration.set()` takes effect on the next render.

## Best practices

- Leave `templates.cache.mode` unset in most apps: development recompiles, production caches.
- Use `revalidate` when templates are edited on a running server, eg. on a shared provider.
- Generate templates with stable keys. A key built from user input, eg. a timestamp in the path, makes the cache grow without bound.

## Patterns and antipatterns

```ts
// Don't: forces every render in production to read and compile the file
export default { templates: { cache: { mode: 'always' } } };

// Do: let dev mode choose, or revalidate when templates change at runtime
export default { templates: { cache: { mode: 'revalidate' } } };
```

## Examples

### Pin one engine to `always` while others cache

A preview renderer for a template editor must show every save, while mail templates stay cached.

```ts sample
import { Injectable } from '@spinajs/di';
import { CompiledTemplateRenderer, TemplateCacheMode, TemplateRenderer } from '@spinajs/templates';

@Injectable(TemplateRenderer)
export class PreviewTextRenderer extends CompiledTemplateRenderer {
  public get Type() {
    return 'preview-text';
  }

  public get Extension() {
    return '.preview';
  }

  protected get CacheMode(): TemplateCacheMode {
    return 'always';
  }

  protected async compile(template: string) {
    const source = await this.resolveContent(template);
    return (locals: Record<string, unknown>) => source.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => String(locals[key] ?? ''));
  }

  protected buildContext(model: unknown): Record<string, unknown> {
    return { ...(model as object) };
  }
}
```

## Related

- [Template sources](02-template-sources.md): what the change token is read from.
- [Compiled template renderer](07-compiled-template-renderer.md): the renderer base that calls `withCache()`.
- [Environments](../configuration/02-environments.md): where `configuration.isDevelopment` comes from.
