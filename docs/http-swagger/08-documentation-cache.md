# Documentation cache

`SwaggerDocCache` collects what the builder needs to know about one controller beyond its decorators: the JSDoc of the class and its methods, and the policies applied to it. The JSDoc is parsed once per controller file by `DefaultControllerCache` from `@spinajs/http` and kept on disk. Replace either class, or add a JSDoc tag, to change what the document says.

## How it works

`SwaggerDocCache.getCache(controller)`:

1. Calls `DefaultControllerCache.getDocumentation(controller)`:
   - a controller whose `file` is a placeholder such as `<dynamic>` gets `{ className, methods: {} }`, so no JSDoc;
   - otherwise the key is `doc_<@spinajs/http version>_<hash of the .d.ts>` in the `__fs_controller_cache__` file provider (`<cwd>/__cache__/__controllers__`). A missing `.d.ts` makes the hasher throw `IOFail`;
   - a missing entry is generated: the `.d.ts` (the controller file with `.js` replaced) is parsed with the TypeScript compiler API, every method's JSDoc goes through `tagExtractors`, and the entry is written.
2. Reads `controller.instance.Descriptor` for controller-level and route-level policy names; see [Policies and access](05-policies-and-access.md).
3. Asks `DefaultControllerCache.getPolicyDocumentation()` for the JSDoc of those policies.
4. Returns an `ISwaggerCacheEntry`, copying for each method only `summary`, `description`, `params`, `returns`, `responses`, `examples`, `tags`, `deprecated` and `security`.

At startup `DefaultControllerCache` deletes entries written by other `@spinajs/http` versions. Entries of the current version stay until the `.d.ts` content changes.

## `ISwaggerCacheEntry`

| Field | Type | Meaning |
| --- | --- | --- |
| `className` | `string` | Controller class name |
| `classDescription` | `string?` | Class JSDoc; the tag description |
| `classTags` | `string[]?` | Class `@tags`; the first one names the tag |
| `methods` | `Record<string, IMethodDocumentation>` | Per method: `summary`, `description`, `params`, `returns`, `responses`, `examples`, `tags`, `deprecated`, `security` |
| `controllerPolicies` | `string[]?` | Policies on the class |
| `routePolicies` | `Record<string, string[]>?` | Policies per method name |
| `policies` | `Record<string, IPolicyDocumentation>?` | `file` and `description` per policy name |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SwaggerDocCache` | class `SwaggerDocCache`, `@Singleton()`; resolved by type through `@Autoinject()` in `SwaggerService` and `DI.resolve()` in `SwaggerCacheCommand` | `SwaggerDocCache` | none | Subclass, override `getCache()`, `DI.register(Sub).as(SwaggerDocCache)` before the first build |
| `DefaultControllerCache` (`@spinajs/http`) | class `DefaultControllerCache`, `@Singleton()`; `@Autoinject(DefaultControllerCache)` in `SwaggerDocCache`, also used by `@spinajs/http` for argument names | `DefaultControllerCache` | none | Add entries to its public `tagExtractors` array in a subclass; `DI.register(Sub).as(DefaultControllerCache)` before `Controllers` is resolved |
| `SwaggerCacheCommand` | CLI command `http:swagger:cache`, loaded from `system.dirs.cli` | `SwaggerCacheCommand` | `http:controllers:cache` (`@spinajs/http`) | none |

### `SwaggerDocCache`: custom implementation

Override `getCache()` to fill or rewrite what the JSDoc left out: default summaries, tags derived from a folder, a common security rule. Call `super.getCache()` and edit the entry it returns; the builder reads only the fields listed above.

```ts sample
import { ClassInfo, DI } from '@spinajs/di';
import { BaseController } from '@spinajs/http';
import { ISwaggerCacheEntry, SwaggerDocCache } from '@spinajs/http-swagger';

/** Gives every undocumented route a summary made from its method name. */
export class SummaryFallbackDocCache extends SwaggerDocCache {
  public async getCache(controller: ClassInfo<BaseController>): Promise<ISwaggerCacheEntry> {
    const entry = await super.getCache(controller);

    for (const [method, doc] of Object.entries(entry.methods)) {
      // listOpenInvoices -> "list open invoices"
      doc.summary ??= method.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    }

    entry.classTags ??= [entry.className.replace(/Controller$/, '')];
    return entry;
  }
}

// Before the first GET /docs/swagger.json.
DI.register(SummaryFallbackDocCache).as(SwaggerDocCache);
```

`methods` holds every method the `.d.ts` declares; a controller with a placeholder `file` has no methods there, so its routes keep no summary.

### JSDoc tags: custom extractor

`DefaultControllerCache.tagExtractors` maps JSDoc tag names to handlers. Each handler gets the tag and a context whose `doc` is the method entry being built; the first extractor that lists the tag name wins. Put yours first to override a built-in one.

A handler can only fill fields `SwaggerDocCache` copies: `summary`, `description`, `params`, `returns`, `responses`, `examples`, `tags`, `deprecated`, `security`. Anything else is dropped before the builder sees it.

```ts sample
import { DI } from '@spinajs/di';
import { DefaultControllerCache } from '@spinajs/http';

/**
 * `@public` marks a route that needs no authentication,
 * `@partner` adds the Partner tag.
 */
export class TeamDocsControllerCache extends DefaultControllerCache {
  constructor() {
    super();

    this.tagExtractors.unshift(
      {
        tags: ['public'],
        extract: (_tag, ctx) => {
          ctx.doc.security = [];
        },
      },
      {
        tags: ['partner'],
        extract: (_tag, ctx) => {
          ctx.doc.tags = [...(ctx.doc.tags ?? []), 'Partner'];
        },
      },
    );
  }
}

// Before Controllers is resolved, so @spinajs/http and http-swagger share this instance.
DI.register(TeamDocsControllerCache).as(DefaultControllerCache);
```

Cache keys do not change when extractors change. Run `spinajs http:controllers:cache --rebuild`, or delete `__cache__/__controllers__`, after adding one.

## CLI

```sh
spinajs http:swagger:cache
```

`SwaggerCacheCommand.execute()` resolves `fsService` and `SwaggerDocCache`, lists the classes in `system.dirs.controllers` with `@ListFromFiles`, and calls `getCache()` for each one that is a controller (extends `BaseController` or carries the route descriptor). Run it in an image build so the first docs request does not parse every controller.

- It writes the same `__fs_controller_cache__` entries as `http:controllers:cache`, which also offers `--rebuild`.
- `@ListFromFiles` does not create controller instances, so the command reads no policies.

## Important behaviour

- The parser reads `.d.ts` files. Compile controllers with `declaration: true` and keep comments. Run from `.ts` sources, it parses the `.ts` file itself.
- The cache directory is relative to the process working directory, not to `WORKSPACE_ROOT_PATH`.
- `getCache()` runs once per controller per build; with a cached document it is not called at all.

## Best practices

- Ship the generated `__cache__/__controllers__` with the image, or run `http:swagger:cache` while building it.
- Prefer a custom JSDoc tag over a `SwaggerDocCache` subclass when the information belongs next to the route.

## Related

- [Documenting routes](02-documenting-routes.md#jsdoc-tags): the built-in tags.
- [Swagger service](06-swagger-service.md): when `getCache()` runs.
- [Command discovery](../cli/05-command-discovery.md): how `system.dirs.cli` commands are found.
- [Providers and configuration](../fs/01-providers-and-configuration.md): the `__fs_controller_cache__` provider.
