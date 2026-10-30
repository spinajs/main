# Controller cache and CLI

`DefaultControllerCache` reads each controller's compiled `.d.ts` with the TypeScript compiler once and stores two JSON entries: the parameter names of every action (route argument binding needs them) and the JSDoc documentation of the controller (`@spinajs/http-swagger` builds OpenAPI from it). The `http:controllers:cache` command builds the entries ahead of time, for example in a Docker image, so the first start does not pay the parsing cost.

`DefaultControllerCache` is on the `@spinajs/http/cache` subpath, and `typescript` is an optional peer dependency of `@spinajs/http`: install it when an app runs without a manifest. With a manifest (`system.manifest.mode` `prefer` or `require`), parameter names and documentation come from the manifest, and a process that never needs the cache never loads `typescript`.

## Metadata providers

`Controllers.register()` and `@spinajs/http-swagger` ask a `ControllerMetadataProvider` for a controller's parameter names and documentation. Every provider registered as `ControllerMetadataProvider` is tried by `Priority`, lowest first; the first whose `supports(controller)` is true answers.

| Provider | Priority | Supports | Reads |
| --- | --- | --- | --- |
| `ManifestControllerMetadata` | 10 | controllers the effective manifest lists (by class name, and by mount path when a name is taken twice); none in `off` mode | `RouteEntry.params` (names by `index`) and `RouteEntry.doc` (summary, description, tags, deprecated, responses) |
| `CacheControllerMetadata` | 100 | every controller | `DefaultControllerCache`, imported on the first controller with a source file |

In `require` mode a controller with a source file that the manifest does not list throws `NoControllerMetadata` instead of falling back to the cache. In `prefer` mode it falls back. A controller without a source file (`<di>`, `<dynamic>`) never loads the cache: its names come from the function.

## How it works

**At startup**, `DefaultControllerCache.resolve()` removes entries written by other versions of `@spinajs/http`, then logs the cache directory.

**Per controller**, when `CacheControllerMetadata` answers, it calls `getCache(controllerInfo)` once per controller:

1. A controller without a real source file (`file` is `<di>` or `<dynamic>`) gets its parameter names from `Function.prototype.toString()` of each action; no documentation.
2. Otherwise it takes the file, replaces `.js` with `.d.ts`, and hashes it with `FileHasher` (`@spinajs/fs`).
3. The keys are `<package version>_<hash>` (parameters) and `doc_<package version>_<hash>` (documentation), in the `__fs_controller_cache__` provider.
4. A missing entry is generated: `ts.createProgram()` parses the file, finds the class **by name**, and walks its method declarations.
5. It returns the parameter map `{ [method]: string[] }`.

A route whose method is not in the parsed class (inherited from a base class in another file) falls back to `Function.prototype.toString()` in `Controllers.register()`.

**Documentation** extracted per controller:

| Source | Field |
| --- | --- |
| class JSDoc text | `classDescription` |
| class `@tags` or `@category` (comma-separated) | `classTags` |
| method JSDoc: first line / rest | `summary` / `description` |
| `@param name description` | `params[name]` |
| `@returns` / `@return` | `returns.description`, `returns.type` |
| method return type annotation | `returns.schema` (`Promise<T>`, `Ok<T>`, `Created<T>`, ... unwrapped to `T`) |
| `@response 404 {string} message` | `responses['404']` |
| `@body {LoginBody} description` | `body.type`, `body.description` |
| `@example` with optional `<caption>` | `examples[]` |
| `@tags`, `@tag`, `@category` | `tags` |
| `@deprecated` | `deprecated: true` |
| `@summary` | `summary` (overrides the first line) |
| `@security cookieAuth, bearerAuth` / `@security []` | `security` (`[]` marks the route public) |

`getPolicyDocumentation(controller, names)` finds the JSDoc of policy classes through the controller's compiled imports.

### The CLI command

`spinajs http:controllers:cache [-r | --rebuild]` (`ControllersCacheCommand`, loaded from `system.dirs.cli`):

1. Resolves the file providers and `DefaultControllerCache` (imported when the command runs, not when the CLI lists it).
2. Asks every [`ControllerSource`](03-controller-discovery.md) for controllers and keeps those with a real file, one per class name.
3. With `--rebuild`, deletes every cache entry first (only names shaped like entries).
4. Generates the missing entries and logs `<ok> ok, <failed> failed`.
5. Throws, so the process exits non-zero, when any controller failed.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.providers` `__fs_controller_cache__` | provider | `fsNative` at `<cwd>/__cache__/__controllers__` | any writable provider | Where entries are stored. |
| `system.dirs.cli` | `string[]` | includes `<package>/lib/cli` | | Lets `@spinajs/cli` find the command. |

```ts
export default {
  fs: {
    providers: [
      // Inside the image, next to the app, so the pre-built cache ships with it.
      { service: 'fsNative', name: '__fs_controller_cache__', basePath: '/app/__cache__/__controllers__' },
    ],
  },
};
```

```dockerfile
FROM node:22 AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build
# After tsc: entries are keyed by the content hash of the compiled .d.ts files.
RUN node node_modules/.bin/spinajs http:controllers:cache --rebuild

FROM node:22-slim
WORKDIR /app
COPY --from=build /app .
CMD ["node", "dist/index.js"]
```

While developing controllers, rebuild from a watcher:

```json
"watch:controllers": "nodemon --watch src/controllers --ext ts --exec \"spinajs http:controllers:cache --rebuild\""
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ControllerMetadataProvider` | Abstract class `ControllerMetadataProvider`, implementations `@Singleton()` | `ManifestControllerMetadata` (10), `CacheControllerMetadata` (100) | | `@Injectable(ControllerMetadataProvider)` on your own subclass with a `Priority` below the one it should win over. |
| `DefaultControllerCache` | Class `DefaultControllerCache` from `@spinajs/http/cache`, `@Singleton()`, resolved by `CacheControllerMetadata` and the CLI command | `DefaultControllerCache` | none shipped | Subclass and `DI.register(Mine).as(DefaultControllerCache)` before `Controllers` resolves. Push into `tagExtractors` to read new JSDoc tags; override the public `getCache()`, `getDocumentation()` or `clear()` for another storage. |
| `ITagExtractor` | entries of the public `tagExtractors` array | `param`, `returns`/`return`, `response`, `body`, `example`, `tags`/`tag`/`category`, `deprecated`, `summary`, `security` | | Add `{ tags: ['mytag'], extract(tag, ctx) {...} }`. The first extractor whose `tags` contains the tag name wins, so put an override before the built-in one with `unshift`. |
| `FileHasher` | `@spinajs/fs` | `DefaultFileHasher` | | See [`@spinajs/fs`](../fs/README.md). |

Helpers: `parseFnParamNames(fn)` (parameter names from a function's source) and `isOnDiskSource(file)` (false for `<...>` sentinels) are exported.

### `DefaultControllerCache`: custom implementation

Document per-route rate limits with a `@rateLimit` JSDoc tag. The extractor writes into the documentation entry, which `@spinajs/http-swagger` and your own tooling read with `getDocumentation()`:

```ts sample
import { DI } from '@spinajs/di';
import { DefaultControllerCache } from '@spinajs/http/cache';
import type { JSDocTag } from 'typescript';

declare module '@spinajs/http' {
  interface IMethodDoc {
    rateLimit?: string;
  }
}

function tagText(tag: JSDocTag): string | undefined {
  if (typeof tag.comment === 'string') {
    return tag.comment.trim();
  }
  return tag.comment?.map((part) => part.text).join('').trim();
}

export class RateLimitDocCache extends DefaultControllerCache {
  public async resolve() {
    this.tagExtractors.push({
      tags: ['rateLimit'],
      extract: (tag, ctx) => {
        // @rateLimit 10/min
        ctx.doc.rateLimit = tagText(tag);
      },
    });
    await super.resolve();
  }
}

// Before Controllers and the swagger generator resolve.
DI.register(RateLimitDocCache).as(DefaultControllerCache);
```

Run `spinajs http:controllers:cache --rebuild` after adding an extractor: existing entries are served as they are until their key changes.

## Important behaviour

- The class is found **by name** in its own file. A controller exported under another name, or declared in a file that is not its `SourceFile`, gets no parameter names from the parser.
- `.d.ts` files must sit next to the compiled `.js` controllers. Without them the parser finds nothing and routes fall back to the runtime extraction.
- Keys combine the package version and the file hash. Upgrading `@spinajs/http` invalidates every entry; entries of other versions are deleted at startup (not when the version cannot be read).
- Changing a tag extractor does not change any key; rebuild the cache.
- Minified or bundled controllers lose parameter names in the runtime fallback.
- The command skips controllers known only as `<di>`; their names are extracted at runtime.
- `clear()` and the startup sweep delete only names shaped like entries; other files in the directory stay.

## Best practices

- Pre-build the cache in CI or the image build, after `tsc`, with `--rebuild`.
- Keep the cache directory writable at runtime anyway: a controller added later generates its entries on first start.
- Document routes with `@response`, `@tags` and `@security`; `@spinajs/http-swagger` turns them into OpenAPI.

## Patterns and antipatterns

```ts
// Don't: build the cache before compiling; the hashes of the old .d.ts files are written.
// RUN spinajs http:controllers:cache && npm run build

// Do
// RUN npm run build && spinajs http:controllers:cache --rebuild
```

## Examples

### Document a route for OpenAPI

```ts sample
import { BaseController, BasePath, Get, NotFound, Ok, Param } from '@spinajs/http';

interface IProduct {
  id: number;
  name: string;
}

/**
 * Product catalog.
 *
 * @tags catalog
 */
@BasePath('products')
export class ProductsController extends BaseController {
  /**
   * Get one product.
   * Returns the product with its current price.
   *
   * @param id product id
   * @response 404 {string} product not found
   * @security []
   * @example <caption>request</caption> GET /products/7
   */
  @Get(':id')
  public async get(@Param() id: number): Promise<Ok<IProduct> | NotFound> {
    return id === 7 ? new Ok({ id, name: 'Desk lamp' }) : new NotFound({ message: 'product not found' });
  }
}
```

## Related

- [Controllers and routing](02-controllers-and-routing.md): where parameter names are applied.
- [Controller discovery](03-controller-discovery.md): the sources the command uses.
- [`@spinajs/http-swagger`](../http-swagger/README.md): OpenAPI from the documentation entries.
- [`@spinajs/cli`](../cli/README.md): running `spinajs` commands.
- [`@spinajs/fs`](../fs/README.md): the cache provider and `FileHasher`.
