# Custom helpers and partials

`HandlebarsRenderer` compiles with the default environment of the `handlebars` module. Register a helper or a partial on that environment, and every template the renderer compiles can use it. Use this to add formatting the [built-in helpers](02-built-in-helpers.md) lack, to replace one of them, or to share a header and footer between templates.

The package does **not** load helpers or partials from directories; register them in code.

## How it works

1. Your module imports `handlebars` and calls `Handlebars.registerHelper(name, fn)` or `Handlebars.registerPartial(name, source)`.
2. `HandlebarsRenderer.resolve()` registers the 95 built-in helpers on the same environment the first time DI builds the renderer. A built-in **overwrites** a helper of the same name registered before it.
3. `Handlebars.compile()` produces a delegate. Helpers and partials are looked up when the delegate runs, not when it compiles.
4. A template calls the helper (`{{initials user.name}}`) or the partial (`{{> footer}}`). The last registration of that name wins, also for delegates already in the cache.

| You register | When | Result |
| --- | --- | --- |
| A new helper or partial name | Any time before the first render that uses it | Available to every template |
| A built-in helper name | Before `HandlebarsRenderer` resolves | Overwritten by the built-in |
| A built-in helper name | After `await DI.resolve(Templates)`, or in a subclass `resolve()` after `super.resolve()` | Replaces the built-in |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `templates.handlebars.knownHelpers` | `Record<string, boolean>` | unset | helper names | Helpers the compiler may call without a runtime lookup |
| `templates.handlebars.knownHelpersOnly` | `boolean` | unset | `true`, `false` | `true` makes a template that calls a helper missing from `knownHelpers` fail to compile with `IOFail` |

```ts
// config/templates.ts
export default {
  templates: {
    handlebars: {
      knownHelpersOnly: true,
      knownHelpers: { __: true, formatDate: true, initials: true },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Helper registry | Not in DI: `Handlebars.helpers` of the default `handlebars` module, process-wide | Handlebars' own helpers (`if`, `each`, `with`, `lookup`, `log`, ...) plus the 95 built-ins | Your helpers | `Handlebars.registerHelper(name, fn)` or `registerHelper({ name: fn, ... })`; `Handlebars.unregisterHelper(name)` removes one |
| Partial registry | Not in DI: `Handlebars.partials` of the default `handlebars` module, process-wide | None | Your partials | `Handlebars.registerPartial(name, source)`; `unregisterPartial(name)` removes one |
| Per-renderer helpers | A `HandlebarsRenderer` subclass | None | Helpers passed as runtime options | Wrap the compiled delegate; see [Customizing the renderer](04-customizing-the-renderer.md#compile-pre-process-sources-or-pass-runtime-options) |

### Helper registry: add a block helper

A helper receives the template arguments, then a `HelperOptions` object: `fn` renders the block, `inverse` renders `{{else}}`, `hash` holds named arguments, and `data.root` is the [template context](01-rendering-templates.md#template-context) with `lang`.

```ts sample
import Handlebars from 'handlebars';
import '@spinajs/templates-handlebars';

// {{#hasRole user "admin"}}<a href="/admin">Admin panel</a>{{else}}<span>Read-only</span>{{/hasRole}}
Handlebars.registerHelper('hasRole', function (this: unknown, user: { roles?: string[] }, role: string, options: Handlebars.HelperOptions) {
  return user?.roles?.includes(role) ? options.fn(this) : options.inverse(this);
});

// {{initials user.name}} -> "AK"
Handlebars.registerHelper('initials', (name: unknown) =>
  String(name ?? '')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase())
    .join(''),
);
```

## Important behaviour

- **One environment per process.** Helpers and partials are global to the `handlebars` module. Two parts of an app that register the same name overwrite each other.
- **Your `handlebars` import must resolve to the package's copy.** A second installed copy of `handlebars` has its own registry; helpers registered there are invisible to the renderer.
- **Handlebars appends `options` as the last argument.** A helper with an optional parameter receives `options` in its place when the template omits it; check for it before using the value.
- **Return values are HTML-escaped** under `{{ }}`. Return `new Handlebars.SafeString(html)` for markup you built from trusted parts.
- **A missing partial throws** `The partial <name> could not be found` on render.

## Best practices

- Register helpers and partials in a module your app imports at startup, next to `import '@spinajs/templates-handlebars'`.
- Prefix app helpers (`app_money`) when several packages register helpers, so names cannot collide with a future built-in.
- Read the render language from `options.data.root.lang`, not from a global, so the helper follows the language passed to `Templates.render()`.
- Escape user input with `Handlebars.escapeExpression()` before wrapping a result in `SafeString`.

## Patterns and antipatterns

```ts
// Don't: registered before the renderer resolves, the built-in currency overwrites it
Handlebars.registerHelper('currency', myCurrency);
const templates = await DI.resolve(Templates);

// Do: replace a built-in after the renderer has registered its helpers
const templates = await DI.resolve(Templates);
Handlebars.registerHelper('currency', myCurrency);
```

## Examples

### Format dates in the render language

```ts sample
import Handlebars from 'handlebars';
import '@spinajs/templates-handlebars';

// {{localDate order.placedAt "long"}} -> "17 października 2026" for lang "pl"
Handlebars.registerHelper('localDate', (value: string | Date, style: unknown, options?: Handlebars.HelperOptions) => {
  const opts = (options ?? style) as Handlebars.HelperOptions;
  const dateStyle = typeof style === 'string' ? (style as 'full' | 'long' | 'medium' | 'short') : 'medium';
  const date = value instanceof Date ? value : new Date(value);

  return new globalThis.Intl.DateTimeFormat(opts.data.root.lang, { dateStyle }).format(date);
});
```

### Share a header and footer between mail templates

Register every file in `templates/partials` under its file name, once at startup.

```ts sample
import Handlebars from 'handlebars';
import { readdir, readFile } from 'fs/promises';
import { basename, extname, join } from 'path';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-handlebars';

async function registerPartials(dir: string) {
  for (const file of await readdir(dir)) {
    if (extname(file) !== '.handlebars') continue;
    Handlebars.registerPartial(basename(file, '.handlebars'), await readFile(join(dir, file), 'utf-8'));
  }
}

async function main() {
  await registerPartials(join(process.cwd(), 'templates', 'partials'));

  // welcome.handlebars: {{> header title=(__ "Welcome")}} <p>...</p> {{> footer}}
  const templates = await DI.resolve(Templates);
  console.log(await templates.render(join(process.cwd(), 'templates', 'welcome.handlebars'), { name: 'Anna' }, 'en'));
}

void main();
```

### Make `currency` follow the render language

Replace the built-in after the renderer has registered it.

```ts sample
import Handlebars from 'handlebars';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-handlebars';

async function main() {
  const templates = await DI.resolve(Templates);

  // {{currency total "EUR"}} now formats in the language passed to render()
  Handlebars.registerHelper('currency', (value: unknown, code: unknown, options?: Handlebars.HelperOptions) => {
    const opts = (options ?? code) as Handlebars.HelperOptions;
    const currency = typeof code === 'string' ? code : 'EUR';
    return (Number(value) || 0).toLocaleString(opts.data.root.lang, { style: 'currency', currency });
  });

  return templates;
}

void main();
```

## Related

- [Built-in helpers](02-built-in-helpers.md): the names already taken.
- [Customizing the renderer](04-customizing-the-renderer.md): register helpers inside the renderer, or keep them private to one renderer.
- [Request language](../intl/04-request-language.md): the `__translate*` functions used above.
