# Templates: resolve sources through the `fs` abstraction

**Date:** 2026-07-16
**Packages:** `templates`, `templates-handlebars`, `template-mjml`, `templates-pug`, `fs`, `fs-s3`

## Problem

The templating system reads template files with `node:fs` directly. `templates` does
not even depend on `@spinajs/fs`, so `Templates.render()` accepts local absolute paths
only. Every other module in the monorepo resolves storage through the injected `fs`
provider abstraction; templating is the exception.

Consequences today:

- Templates cannot live in S3 (or any non-local provider) when rendering directly.
- `email` works around this: it configures `templateFs`, and `email-smtp-transport`
  calls `fs.download()` to materialise the template locally before rendering
  (`email-smtp-transport/src/index.ts:69-96`). The bridge lives in the wrong package.
- That workaround is broken for S3 anyway: `fsS3.download()` names its temp file from
  a bare uuid with no extension (`fs-s3/src/index.ts:173`), and `Templates.render()`
  dispatches on `extname()`, so it throws `No renderer for file ... with extension `.
  It goes unnoticed with the local provider, whose `download()` returns the path
  unchanged with the extension intact.

Immediate driver: an AWS Lambda mail service in `sn-step-schedules` that renders MJML
templates stored in S3. That project is specced separately and depends on this one.

## Goals

- Renderers resolve template sources through the injected `fs` provider, following the
  same convention as the rest of the framework.
- Templates addressable on any registered provider, including S3.
- Template changes on a remote provider are picked up without a redeploy, without
  refetching the source on every render.
- No breaking change: existing callers passing local paths keep working untouched.

## Non-goals

- `renderToFile` **destinations**. Renderers keep writing output with `node:fs`.
  Nothing needs URI destinations yet; revisit when something does.
- **Pug `include`/`extends` from a remote provider.** Pug resolves includes against
  local disk relative to `basedir`. A remote pug template with includes is unsupported.
- **Changing `email` / `email-smtp-transport`.** They keep passing local temp paths,
  which keep working. Passing `fs://` URIs directly and dropping their own `download()`
  is a follow-up.

## Design

### Addressing: the `fs://` URI scheme

Consumers name a provider with the existing scheme: `render('fs://email-templates/welcome.mjml')`.

The `URI` class (`fs/src/interfaces.ts:12-38`) already parses `fs://name/path`, resolves
the provider from DI via `__file_provider__`, and throws `InvalidArgument` when the
filesystem is not registered. Static helpers `fs.read(uri)` / `fs.download(uri)` exist.

Chosen over a `templateFs` config option (mirroring `email`) because it needs no
signature change, no new config, and no third convention. A bare path stays local, so
backward compatibility is automatic.

`Templates.render()` and `renderToFile()` need **no change**: `extname('fs://tpl/x.mjml')`
is already `.mjml`, so renderer dispatch works as-is.

This introduces a new dependency: `templates` → `@spinajs/fs`. That is the point of the
change, but it is a real new coupling for every `templates` consumer.

### Resolution: two helpers on `TemplateRenderer`

The change lands in the abstract base class (`templates/src/interfaces.ts`), not in each
renderer:

| Helper | Returns | Bare path | `fs://` URI | Used by |
|---|---|---|---|---|
| `resolveContent(template)` | source as string | read local | `fs.read()` | handlebars, mjml |
| `resolveLocalPath(template)` | local path | itself | `fs.download()` | pug |

A **bare path reads from local disk exactly as today**, not through the default `fs`
provider. Routing bare paths through the default provider would be more uniform, but that
provider may carry a `basePath`, which would silently re-resolve every existing caller's
relative path and break them. Bare path means local; the URI scheme is how you opt in to
a provider.

Handlebars and MJML compile from a string and need no path. Pug's
`pugTemplate.compileFile(path)` (`templates-pug/src/index.ts:81`) requires a real local
path and does its own disk I/O for includes, so pug downloads to temp.

Both paths still honour the convention — resolve through the injected provider — while
being honest that pug is path-bound. Converting pug to `pug.compile(source, {filename, basedir})`
was rejected: it would not fix include resolution anyway, so it buys uniformity without
capability.

### `normalize()` must become URI-aware

Renderers call `normalize(templateName)` before compiling and use the result as the cache
key (`templates-handlebars/src/index.ts:62-66`). On Windows,
`path.normalize('fs://tpl/welcome.mjml')` yields `fs:\tpl\welcome.mjml`, which the URI
regex then rejects.

Normalize bare paths as today; leave URIs untouched.

### Cache modes

A general option on `templates`, shared by all renderers. Cache entries become
`{ compiled, token }` instead of a bare compiled template.

| Mode | Behavior |
|---|---|
| `cache` | Compile once, reuse forever. Current behavior. **Default** — existing consumers see no change. |
| `revalidate` | `stat()` the source; recompile only when its change token differs from the cached one. |
| `always` | Recompile on every render. |

**The change token comes from `stat()`, not from hashing content.** `fs-s3.stat()` uses
`HeadObjectCommand` (`fs-s3/src/index.ts:479-502`) — metadata only, no download. So
`revalidate` costs one `HeadObject` per render and fetches the body only when the source
actually changed.

`stat()` is on the `fs` base interface and the local provider returns mtime/size too, so
`revalidate` works identically for local templates with no S3-specific code in `templates`.

Token preference:
1. A provider-supplied opaque token via `IStat.AdditionalData`, when present.
2. Fall back to `ModifiedTime` + `Size`.

`fs-s3.stat()` will populate `AdditionalData` with the ETag — currently `result.ETag` is
discarded and `AdditionalData` is never set. ETag is the stronger token: mtime+size misses
an edit preserving both. `templates` never learns what an ETag is; it compares an opaque
value for equality. (For multipart uploads an ETag is not the content MD5 — it carries a
`-N` suffix. Irrelevant here: we need a change token, not a checksum.)

`revalidate` is what the Lambda uses, with `fs://email-templates/*.mjml`.

### Pug's `devMode` folds into the shared mode

`templates-pug/src/index.ts:57` force-recompiles when `configuration.isDevelopment` is
set — that is `always` mode, implemented in one renderer only. `devMode` will default the
shared mode to `always`; an explicit `templates` config wins. Otherwise two mechanisms do
one job.

### `fs.tmppath(ext?)`

The abstract `fs` class (`fs/src/interfaces.ts:219`) and the local providers gain an
optional extension argument. `fsS3.download()` uses it so the temp file keeps the key's
extension. Additive — existing callers are unaffected.

### Dead config removal

Both live in the code being rewritten and are dead or wrong:

- `TemplatePaths` / `@Config('system.dirs.templates')` (`templates/src/interfaces.ts:11-12`)
  is referenced nowhere in the monorepo. It is a `protected` field on an abstract class,
  so nothing outside can read it.
- `templates/src/config/templates.ts:6-9` points `system.dirs.templates` at
  `node_modules/@spinajs/rbac/lib/...` — a copy-paste bug.

## Error handling

- Unregistered filesystem in a URI → `InvalidArgument`, thrown by `URI` today.
- Empty or uncompilable template → `IOFail`, as today.
- **`stat()` failure in `revalidate` mode → fall back to the cached entry, log at `warn`.**
  A transient S3 blip must not fail a render when a good compiled template is in hand.
  With no cached entry, the error propagates.

## Testing

| Package | Tests |
|---|---|
| `fs` | `tmppath(ext)` returns the extension; `tmppath()` behavior unchanged. |
| `fs-s3` | `download()` returns a path whose extension matches the key; `stat()` surfaces the ETag in `AdditionalData`. Mocked S3 client. |
| `templates` | Bare paths still render (regression). `fs://` renders through a provider. `normalize` does not corrupt URIs. One test per mode: `cache` does not recompile after the source changes; `revalidate` does; `always` recompiles every render. A fake in-memory `fs` provider registered in DI keeps these fast and S3-free. |
| end-to-end | One MJML template rendered through a fake remote provider — the Lambda's actual path. |

## Consumer configuration

```ts
{
  fs: {
    defaultProvider: 'fs-local',
    s3: { config: { region: 'eu-central-1' } },   // note: global, shared by all s3 providers
    providers: [
      { service: 'fsNative', name: 'fs-local', basePath: '/app/files' },
      { service: 'fsNativeTemp', name: 'fs-temp-s3', basePath: '/tmp',
        cleanup: true, cleanupInterval: 3600 * 1000, maxFileAge: 24 * 3600 },
      { service: 'fsS3', name: 'email-templates', bucket: 'my-templates-bucket' },
    ],
  },
  templates: { cache: { mode: 'revalidate' } },
}
```

Then `render('fs://email-templates/welcome.mjml', model)`.

Note for Lambda: `fs-s3` downloads through a temp provider with a `basePath`, and a Lambda
filesystem is read-only except `/tmp`, so that provider must point at `/tmp`.
