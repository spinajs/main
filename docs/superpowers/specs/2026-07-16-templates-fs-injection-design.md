# Templates: resolve sources through the `fs` abstraction

**Date:** 2026-07-16
**Packages:** `templates`, `templates-handlebars`, `template-mjml`, `templates-pug`, `fs`, `fs-s3`

## Implementation status (2026-07-17)

Everything below is implemented **except the `fs-s3` changes**, which are outstanding.
`packages/fs-s3` is unchanged: `download()` still names its temp file from a bare uuid
(`fs-s3/src/index.ts:173`), and `stat()` still discards `result.ETag`
(`fs-s3/src/index.ts:479-502`). Those tests need localstack via docker, which was
unavailable. Consequences until it lands:

- **`IStat.Version` is populated by no provider**, so the `if (s.Version)` branch in
  `templates`' `tokenFromStat` is dead in production.
- **`revalidate` silently degrades to `ModifiedTime` + `Size`** against S3. It works — one
  `HeadObject`, body fetched only on change — but misses an overwrite that preserves both
  timestamp and size. The ETag would not.
- **The remote download-to-temp path has no test coverage**, because `fsNative.download()
  ` returns the real path and never materialises a temp file.

**This does NOT block rendering MJML templates from S3.** That path never calls
`fsS3.download()` directly: `fsS3.read()` downloads, reads, and cleans up internally,
returning a string, so the extensionless temp name never escapes it — and renderer
dispatch already happened on the URI (`extname('fs://tpl/x.mjml')` is `.mjml`). The
uuid-extension bug survives only on the legacy `email-smtp-transport` path, which calls
`fs.download()` itself and passes the temp path to `render()` — explicitly a non-goal
here. The plan document's claim that the fs-s3 task must land before the Lambda can use
S3 templates is wrong.

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
- **The other five `TemplateRenderer` subclasses**: `templates-xlsx`, `templates-puppeteer`,
  `templates-pdf`, `templates-image`, `templates-csv`. They keep reading via `node:fs` and
  support **bare local paths only** — `fs://` addressing covers handlebars, pug, and mjml.
  They are unaffected by this work (the base-class change only adds `protected` members;
  the abstract surface is unchanged) and all still compile.

  Be aware of how three of them fail if handed a URI anyway: `templates-puppeteer`,
  `templates-pdf`, and `templates-image` do path arithmetic on the template string
  (`dirname`/`basename`/`join`), so an `fs://` URI is mangled into a bogus local path and
  surfaces a confusing `ENOENT` naming a path the caller never wrote. `templates-xlsx`
  fails cleanly with `IOFail`; `templates-csv` ignores its template argument entirely.
  Making the three throw `NotSupported` on a URI would turn a trap into a contract — a
  small follow-up, not done here.

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
| `resolveContent(template)` | source as string | read local | `fs.read()` | handlebars |
| `resolveLocalPath(template)` | local path | itself | `fs.download()` | pug |

**MJML requires no source change.** `MjmlRenderer.render()` delegates to
`this.Templates.compile(templateName, 'handlebars', ...)` and its own `compile()` is an
empty no-op (`template-mjml/src/index.ts`) — handlebars performs all reading and caching on
its behalf. MJML therefore inherits `fs://` addressing and cache modes for free. It gets an
end-to-end test, not an edit.

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
1. A provider-supplied opaque token: a new optional `IStat.Version?: string`, when present.
2. Fall back to `ModifiedTime` + `Size`.

`fs-s3.stat()` will populate `Version` with the ETag — currently `result.ETag` is discarded.
ETag is the stronger token: mtime+size misses an edit preserving both. `templates` never
learns what an ETag is; it compares an opaque `Version` for equality. (For multipart uploads
an ETag is not the content MD5 — it carries a `-N` suffix. Irrelevant here: we need a change
token, not a checksum.)

**`Version` rather than the existing `AdditionalData`**: `AdditionalData` is typed `unknown`,
so consuming it would mean an unchecked cast in `templates` plus a well-known key name shared
by convention between two packages — which is the coupling this field is supposed to avoid. A
typed optional `Version` on `IStat` is additive, self-documenting, and keeps `AdditionalData`
free for genuinely provider-specific payloads.

`revalidate` is what the Lambda uses, with `fs://email-templates/*.mjml`.

### Pug's `devMode` folds into the shared mode

`templates-pug/src/index.ts:57` force-recompiles when `configuration.isDevelopment` is
set — that is `always` mode, implemented in one renderer only. `devMode` will default the
shared mode to `always`; an explicit `templates` config wins. Otherwise two mechanisms do
one job.

**This is a deliberate behavior change for handlebars and MJML**, which had no dev-mode
behavior before: a consumer running `NODE_ENV=development` with no explicit
`templates.cache.mode` now recompiles on every render where it previously cached forever.
It is dev-only and performance-only, never correctness, and it generalises pug's existing
live-reload to every renderer — edit a template, see it without restarting. Production
consumers with no config are unaffected: they still get `cache`.

The plan's "no config means no change" constraint is therefore scoped to production. The
`isDevelopment` → `always` branch is covered by a test.

### `fs.tmppath(ext?)`

The abstract `fs` class (`fs/src/interfaces.ts:219`) and the local providers gain an
optional extension argument. `fsS3.download()` uses it so the temp file keeps the key's
extension. Additive — existing callers are unaffected.

### Dead config removal and the `system.dirs.cli` bug

Three items, all in the code being rewritten. The first two are dead; the third is a live
bug and the only one that changes behavior.

**Dead — remove:**

- `TemplatePaths` / `@Config('system.dirs.templates')` (`templates/src/interfaces.ts:11-12`)
  is referenced nowhere in the monorepo. It is a `protected` field on an abstract class,
  so nothing outside can read it.
- `TemplateFiles` (`templates/src/interfaces.ts:14`) is likewise declared and never read.
- The `system.dirs.templates` key in `templates/src/config/templates.ts` — nothing consumes
  it once `TemplatePaths` is gone.

**Live bug — fix:** the same config file also declares `system.dirs.cli`, and that key *is*
consumed: `@spinajs/cli` discovers commands by scanning it
(`cli/src/index.ts:36`, `@ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')`). The
`templates` package ships a real command, `template-render` (`templates/src/cli/render.ts`),
but its `dir()` helper points the scanner at `node_modules/@spinajs/rbac/lib/{cjs,mjs}/cli`
— and `rbac` is not a dependency of `templates`. The command has therefore never been
discoverable.

Fix `dir()` to resolve against `@spinajs/templates` and keep the `cli` key. This is safe for
`rbac`: `rbac/src/config/rbac.ts` declares the same key for its own directory, so nothing
relied on templates' config to load rbac's commands.

**This changes behavior**: `template-render` starts appearing in the CLI. That is the
intended behavior of code already in the repo, not a new feature.

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
| `fs-s3` | `download()` returns a path whose extension matches the key; `stat()` surfaces the ETag as `Version`. Runs against localstack via the package's existing `test/docker-compose.yml`, per the current `fs-s3` suite. |
| `templates` | Bare paths still render (regression). `fs://` renders through a provider. `normalize` does not corrupt URIs. One test per mode: `cache` does not recompile after the source changes; `revalidate` does; `always` recompiles every render. Uses a stub renderer defined in the test file (the package has no renderer of its own, and depending on one would invert the dependency) plus an `fsNative` provider addressed by `fs://` URI — no S3 and no docker. |
| `templates-handlebars`, `templates-pug` | Existing suites must keep passing (bare-path regression). Add: render via `fs://`. |
| end-to-end | One MJML template rendered via `fs://` — the Lambda's actual path, and proof MJML inherits the behavior without a source change. |

Note: `templates/test/templates.test.ts` exists but is **empty** — the package currently has
no tests. Its harness (chai + a `FrameworkConfiguration` subclass + `DI.clearCache()` in
`beforeEach`) follows the pattern in `templates-handlebars/test/templates.test.ts`. Test deps
(`chai`, `ts-mocha`, `sinon`) are hoisted at the repo root; `templates` needs no new devDeps.

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
