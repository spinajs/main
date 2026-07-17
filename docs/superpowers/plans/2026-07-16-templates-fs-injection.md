# Templates fs Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `@spinajs/templates` resolve template sources through the injected `fs` provider abstraction, so templates can live on any registered provider (including S3) and be re-read without a redeploy.

**Architecture:** Templates are addressed with the existing `fs://provider/path` URI scheme. The abstract `TemplateRenderer` base class gains resolution helpers (`resolveContent`, `resolveLocalPath`) and a shared cache with three modes (`cache` / `revalidate` / `always`). `revalidate` compares an opaque change token from `fs.stat()` — one metadata call, no download. Handlebars and pug are the only renderers that touch the filesystem; MJML delegates to handlebars and needs no source change.

**Tech Stack:** TypeScript (ESM, `node16` module resolution), lerna monorepo with tsc project references, ts-mocha + chai for tests, localstack (docker) for `fs-s3` tests.

**Spec:** `docs/superpowers/specs/2026-07-16-templates-fs-injection-design.md`

## Global Constraints

- **No breaking changes.** A bare path passed to `render()` must behave exactly as it does today — read from local disk via `node:fs`, NOT routed through the default `fs` provider (the default provider may carry a `basePath` that would silently re-resolve callers' relative paths).
- **Default cache mode is `cache`** — the current behavior. Existing consumers who set no config see no change **in production**.
- **Dev-mode exception, deliberate:** with `configuration.isDevelopment` set and no explicit `templates.cache.mode`, the mode defaults to `always`. A consumer running `NODE_ENV=development` with no config therefore recompiles every render where it previously cached forever. This is dev-only and performance-only, never correctness, and it generalises pug's existing `devMode` live-reload to every renderer. An explicit `templates.cache.mode` always wins.
- **`templates` must not depend on any renderer package** (`templates-handlebars`, `templates-pug`, `template-mjml` all depend on `templates` — the reverse would be circular). Tests in `templates` use a stub renderer defined in the test file.
- **`fs` must not depend on `templates`.** The dependency added in this plan is one-way: `templates` → `@spinajs/fs`.
- **All new/changed public API is additive.** `tmppath(ext?)` and `IStat.Version?` are optional; existing callers compile unchanged.
- **Every package's existing test suite must keep passing.** Run per-package with `npm test`.
- **Branch:** `feat/templates-fs-injection` (already exists, holds the spec commit).
- **Package versions:** all `@spinajs/*` internal deps are pinned to `2.0.481` in this repo. Use that exact version for any dependency added.
- **Commit style:** conventional commits (`feat(scope):`, `fix(scope):`, `test(scope):`, `refactor(scope):`).

## Task Order & Dependencies

```
Task 1 (fs: tmppath(ext), IStat.Version)
   ├─→ Task 2 (fs-s3: download ext + stat Version)   [needs docker/localstack]
   └─→ Task 3 (templates: base class + cache modes)
          ├─→ Task 4 (templates-handlebars)
          │      └─→ Task 6 (template-mjml: test only)
          └─→ Task 5 (templates-pug)
```

Task 2 is independent of Tasks 3-6 and may be done in parallel or deferred if docker is unavailable.

**STATUS 2026-07-17: Tasks 1, 3-7 are done. Task 2 is NOT done** — docker was unavailable
and its suite needs localstack. See the spec's "Implementation status" section for what
that costs.

**Correction:** this section previously claimed Task 2 "MUST land before the
`sn-step-schedules` Lambda project can use S3 templates." **That is wrong.** Rendering
MJML from S3 does not call `fsS3.download()` directly — `fsS3.read()` downloads, reads,
and cleans up internally and returns a string, so the extensionless temp name never
escapes it, and renderer dispatch already happened on the URI. Task 2 buys a stronger
revalidation token (ETag vs mtime+size) and fixes the legacy `email-smtp-transport` path;
it does not gate the Lambda.

---

### Task 1: `fs` — optional extension on `tmppath()`, `Version` on `IStat`

**Files:**
- Modify: `packages/fs/src/interfaces.ts` (abstract `tmppath` at :219, `IStat` at :49-57, `tmpname` at :249-251, static `tmppath` at :364-371)
- Modify: `packages/fs/src/local-provider.ts` (`tmppath` at :243-245)
- Test: `packages/fs/test/fs.local.test.ts` (existing file — append to it)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `fs.tmpname(ext?: string): string` — returns `uuidv4()`, plus `ext` appended verbatim if given.
  - `abstract fs.tmppath(ext?: string): string`
  - `fsNative.tmppath(ext?: string): string` — `join(basePath, tmpname(ext))`
  - `static fs.tmppath(fsName: string, ext?: string): string`
  - `IStat.Version?: string` — opaque provider-supplied change token.

- [ ] **Step 1: Write the failing test**

Append to `packages/fs/test/fs.local.test.ts`, inside the existing top-level `describe`:

```ts
  it('tmppath should append extension when given', async () => {
    const provider = await f();

    expect(provider.tmppath('.mjml').endsWith('.mjml')).to.be.true;
  });

  it('tmppath should not append extension when not given', async () => {
    const provider = await f();

    expect(extname(provider.tmppath())).to.eq('');
  });

  it('tmppath with extension should still be unique', async () => {
    const provider = await f();

    expect(provider.tmppath('.mjml')).to.not.eq(provider.tmppath('.mjml'));
  });
```

These reuse the suite's existing `f()` helper (which resolves the `test` provider) — do
NOT declare a local `const f`, it would shadow that helper. Extend the existing
`import { join } from 'path';` to `import { extname, join } from 'path';`. `expect` and the
`test` provider are already set up by this suite.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fs && npx ts-mocha -p tsconfig.json test/fs.local.test.ts -g "tmppath"`

Expected: FAIL — `Expected 0 arguments, but got 1` (TypeScript) on `f.tmppath('.mjml')`.

- [ ] **Step 3: Write minimal implementation**

In `packages/fs/src/interfaces.ts`, add `Version` to `IStat`:

```ts
export interface IStat {
  IsDirectory?: boolean;
  IsFile?: boolean;
  Size?: number;
  AccessTime?: DateTime;
  ModifiedTime?: DateTime;
  CreationTime?: DateTime;

  /**
   * Opaque, provider-supplied token that changes when the file content changes.
   * Consumers must treat it as meaningless except for equality comparison.
   * Providers that cannot supply one leave it undefined.
   */
  Version?: string;

  AdditionalData?: unknown;
}
```

Change the abstract declaration (was `public abstract tmppath(): string;`):

```ts
  public abstract tmppath(ext?: string): string;
```

Change `tmpname` (was `return uuidv4();`):

```ts
  public tmpname(ext?: string) {
    return ext ? `${uuidv4()}${ext}` : uuidv4();
  }
```

Change the static helper (was `public static tmppath(fs: string): string` returning `f.tmppath()`):

```ts
  public static tmppath(fs: string, ext?: string): string {
    const f = DI.resolve<fs>('__file_provider__', [fs]);
    if (!f) {
      throw new IOFail(`Filesystem ${fs} not exists, check your configuration`);
    }

    return f.tmppath(ext);
  }
```

In `packages/fs/src/local-provider.ts`:

```ts
  public tmppath(ext?: string): string {
    return join(this.Options.basePath!, super.tmpname(ext));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fs && npx ts-mocha -p tsconfig.json test/fs.local.test.ts -g "tmppath"`
Expected: PASS (3 passing)

- [ ] **Step 5: Run the full fs suite for regressions**

Run: `cd packages/fs && npm test`
Expected: PASS — no failures introduced. `tmppath()` with no argument behaves as before.

- [ ] **Step 6: Commit**

```bash
git add packages/fs/src/interfaces.ts packages/fs/src/local-provider.ts packages/fs/test/fs.local.test.ts
git commit -m "feat(fs): optional extension on tmppath, Version token on IStat

tmppath(ext?) lets remote providers preserve a file extension when
materialising to temp storage. IStat.Version carries an opaque
provider-supplied change token for consumers that need to detect changes
without downloading. Both are additive and optional."
```

---

### Task 2: `fs-s3` — preserve extension in `download()`, expose ETag as `Version`

**Files:**
- Modify: `packages/fs-s3/src/index.ts` (`download` at :172-191, `stat` at :479-502)
- Test: `packages/fs-s3/test/fs-s3.test.ts` (existing file — append)

**Interfaces:**
- Consumes: `fs.tmppath(ext?)` and `IStat.Version` from Task 1.
- Produces: `fsS3.download(path)` returns a temp path whose extension matches the S3 key's. `fsS3.stat(path)` returns `IStat` with `Version` set to the object's ETag.

**Prerequisite:** these tests need localstack. Start it first:

```bash
cd packages/fs-s3/test && docker compose up -d
```

If docker is unavailable, STOP and report — do not fake the S3 client. This suite is
integration-style by design and the rest of the plan does not depend on this task.

- [ ] **Step 1: Write the failing test**

Append to `packages/fs-s3/test/fs-s3.test.ts`, inside the existing `describe('fs s3 basic tests', ...)` block (it already has `f()`, `fl()`, `ft()` helpers and a 65s timeout):

```ts
  it('download should preserve file extension', async () => {
    const s3 = await f();
    const local = await fl();

    await s3.upload(local.resolvePath('sample.mjml'), 'extension-test/sample.mjml');
    const downloaded = await s3.download('extension-test/sample.mjml');

    expect(extname(downloaded)).to.eq('.mjml');
    expect(existsSync(downloaded)).to.be.true;
  });

  it('stat should expose ETag as Version', async () => {
    const s3 = await f();
    const local = await fl();

    await s3.upload(local.resolvePath('sample.mjml'), 'version-test/sample.mjml');
    const stat = await s3.stat('version-test/sample.mjml');

    expect(stat.Version).to.be.a('string');
    expect(stat.Version).to.have.length.greaterThan(0);
  });

  it('stat Version should change when content changes', async () => {
    const s3 = await f();

    await s3.write('version-change/f.txt', 'first content');
    const first = await s3.stat('version-change/f.txt');

    await s3.write('version-change/f.txt', 'second different content');
    const second = await s3.stat('version-change/f.txt');

    expect(first.Version).to.not.eq(second.Version);
  });
```

Add `import { extname } from 'path';` to the imports (`existsSync` and `expect` are already imported).

Create the fixture `packages/fs-s3/test/files/sample.mjml` (the `test` provider's `basePath` is `test/files`):

```html
<mjml><mj-body><mj-section><mj-column><mj-text>hello</mj-text></mj-column></mj-section></mj-body></mjml>
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fs-s3 && npx ts-mocha -p tsconfig.json test/fs-s3.test.ts -g "extension|Version"`

Expected: FAIL — `download should preserve file extension` fails with `expected '' to equal '.mjml'`; the `Version` tests fail with `expected undefined to be a string`.

- [ ] **Step 3: Write minimal implementation**

In `packages/fs-s3/src/index.ts`, change the first line of `download()` (was `const tmpName = this.TempFs.tmppath();`):

```ts
  public async download(path: string): Promise<string> {
    const tmpName = this.TempFs.tmppath(extname(path));
    const wStream = await this.TempFs.writeStream(tmpName);
```

Add `extname` to the existing `path` import at the top of the file. If the file has no
`path` import, add:

```ts
import { extname } from 'path';
```

Change the `stat()` return (add one field — everything else stays):

```ts
    return {
      // no directories in s3
      IsDirectory: false,

      // only files can be stored in s3
      IsFile: true,

      // no creation time
      CreationTime: DateTime.min(),
      ModifiedTime: result.LastModified ? DateTime.fromJSDate(result.LastModified) : DateTime.min(),

      // no access time in s3s
      AccessTime: DateTime.min(),
      Size: result.ContentLength,

      // ETag is an opaque change token. Note: for multipart uploads it is NOT the
      // content MD5 (it carries a -N suffix) — only ever compare it for equality.
      Version: result.ETag,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fs-s3 && npx ts-mocha -p tsconfig.json test/fs-s3.test.ts -g "extension|Version"`
Expected: PASS (3 passing)

- [ ] **Step 5: Run the full fs-s3 suite for regressions**

Run: `cd packages/fs-s3 && npm test`
Expected: PASS. Note `read()` calls `download()` internally, so this exercises the changed path broadly.

- [ ] **Step 6: Commit**

```bash
git add packages/fs-s3/src/index.ts packages/fs-s3/test/fs-s3.test.ts packages/fs-s3/test/files/sample.mjml
git commit -m "fix(fs-s3): preserve extension in download, expose ETag as stat Version

download() named its temp file from a bare uuid, so consumers that
dispatch on file extension (templates) threw on every S3-backed file.
stat() discarded the ETag; expose it as the opaque IStat.Version token so
consumers can detect changes with a HeadObject instead of a download."
```

- [ ] **Step 7: Stop localstack**

```bash
cd packages/fs-s3/test && docker compose down
```

---

### Task 3: `templates` — fs resolution, cache modes, config fixes

**Files:**
- Modify: `packages/templates/package.json` (add dependency)
- Modify: `packages/templates/tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json` (add project reference)
- Modify: `packages/templates/src/interfaces.ts` (rewrite `TemplateRenderer`)
- Modify: `packages/templates/src/config/templates.ts` (fix `system.dirs.cli`, drop dead key)
- Test: `packages/templates/test/templates.test.ts` (currently EMPTY — write from scratch)
- Create: `packages/templates/test/files/stub.test-tpl`

**Interfaces:**
- Consumes: `IStat.Version` from Task 1. `URI`, `fs` (static `read`/`download`/`stat`) from `@spinajs/fs`.
- Produces — the `TemplateRenderer` protected API that Tasks 4 and 5 build on:
  - `type TemplateCacheMode = 'cache' | 'revalidate' | 'always'`
  - `protected get CacheMode(): TemplateCacheMode`
  - `protected isUri(template: string): boolean`
  - `protected normalizeTemplate(template: string): string`
  - `protected async resolveContent(template: string): Promise<string>`
  - `protected async resolveLocalPath(template: string): Promise<string>`
  - `protected async withCache<T>(template: string, compile: () => Promise<T>): Promise<T>`
  - REMOVED: `protected TemplatePaths`, `protected TemplateFiles`, `protected abstract compile(templateName, path)`

- [ ] **Step 1: Add the dependency and project references**

In `packages/templates/package.json`, add to `dependencies` (keep alphabetical-ish order with the others):

```json
    "@spinajs/fs": "^2.0.481",
```

In `packages/templates/tsconfig.json`, add `{ "path": "../fs/tsconfig.json" }` to the `references` array.

In `packages/templates/tsconfig.mjs.json`, add `{ "path": "../fs/tsconfig.mjs.json" }` to the `references` array.

In `packages/templates/tsconfig.cjs.json`, add the `fs` reference matching that file's existing style (`{ "path": "../fs/tsconfig.cjs.json" }`).

Then link workspace deps:

```bash
npm install
```

Verify no dependency cycle was introduced (`fs` must not depend on `templates`):

```bash
node -e "const p=require('./packages/fs/package.json');const d={...p.dependencies,...p.devDependencies};if(Object.keys(d).some(k=>k.includes('templates'))){console.error('CYCLE!');process.exit(1)}console.log('no cycle')"
```

Expected: `no cycle`

- [ ] **Step 2: Write the failing test**

Replace the entire (empty) `packages/templates/test/templates.test.ts` with:

```ts
import { Templates, TemplateRenderer } from '../src/index.js';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { join, normalize, resolve } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * The templates package ships no renderer of its own (renderers depend on it,
 * not the reverse), so tests exercise the base class through a stub that
 * records how many times it actually compiled.
 */
@Injectable(TemplateRenderer)
export class StubRenderer extends TemplateRenderer {
  public static CompileCount = 0;

  public get Type() {
    return 'stub';
  }

  public get Extension() {
    return '.test-tpl';
  }

  public async render(template: string, _model: unknown, _language?: string): Promise<string> {
    const compiled = await this.withCache(template, async () => {
      StubRenderer.CompileCount++;
      return await this.resolveContent(template);
    });

    return compiled;
  }

  public async renderToFile(): Promise<void> {
    // not exercised by these tests
  }
}

function conf(cacheMode?: string) {
  return class extends FrameworkConfiguration {
    protected onLoad() {
      return {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        templates: cacheMode ? { cache: { mode: cacheMode } } : {},
        fs: {
          defaultProvider: 'test',
          providers: [{ service: 'fsNative', name: 'test', basePath: dir('./files') }],
        },
      };
    }
  };
}

async function setup(cacheMode?: string) {
  DI.clearCache();
  StubRenderer.CompileCount = 0;

  DI.resolve(FsBootsrapper).bootstrap();
  DI.register(conf(cacheMode)).as(Configuration);
  await DI.resolve(Configuration);
  await DI.resolve(fsService);

  return await DI.resolve(Templates);
}

async function writeTemplate(content: string) {
  await mkdir(dir('./files'), { recursive: true });
  await writeFile(dir('./files/stub.test-tpl'), content, 'utf-8');
}

describe('templates fs resolution', () => {
  beforeEach(async () => {
    await writeTemplate('hello');
  });

  it('should render from a bare local path (regression)', async () => {
    const t = await setup();
    const result = await t.render(dir('./files/stub.test-tpl'), {});

    expect(result).to.eq('hello');
  });

  it('should render from an fs:// uri', async () => {
    const t = await setup();
    const result = await t.render('fs://test/stub.test-tpl', {});

    expect(result).to.eq('hello');
  });

  it('should fail with InvalidArgument for an unregistered filesystem', async () => {
    const t = await setup();

    await expect(t.render('fs://not-registered/stub.test-tpl', {})).to.be.rejected;
  });
});

describe('templates cache modes', () => {
  beforeEach(async () => {
    await writeTemplate('hello');
  });

  it('cache mode should compile once and ignore source changes', async () => {
    const t = await setup('cache');

    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
    await writeTemplate('changed');
    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
    expect(StubRenderer.CompileCount).to.eq(1);
  });

  it('cache should be the default mode', async () => {
    const t = await setup();

    await t.render('fs://test/stub.test-tpl', {});
    await writeTemplate('changed');
    await t.render('fs://test/stub.test-tpl', {});

    expect(StubRenderer.CompileCount).to.eq(1);
  });

  it('revalidate mode should recompile only after the source changes', async () => {
    const t = await setup('revalidate');

    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
    expect(StubRenderer.CompileCount).to.eq(1);

    // mtime has 1s granularity on some filesystems; size differs here so the
    // token changes regardless
    await writeTemplate('changed content');

    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('changed content');
    expect(StubRenderer.CompileCount).to.eq(2);
  });

  it('always mode should recompile on every render', async () => {
    const t = await setup('always');

    await t.render('fs://test/stub.test-tpl', {});
    await t.render('fs://test/stub.test-tpl', {});

    expect(StubRenderer.CompileCount).to.eq(2);
  });

  it('revalidate should serve the cached entry when stat fails', async () => {
    const t = await setup('revalidate');

    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');

    // provider stat now throws; the cached entry must still be served
    const provider: any = await DI.resolve('__file_provider__', ['test']);
    const original = provider.stat.bind(provider);
    provider.stat = () => Promise.reject(new Error('transient failure'));

    expect(await t.render('fs://test/stub.test-tpl', {})).to.eq('hello');
    expect(StubRenderer.CompileCount).to.eq(1);

    provider.stat = original;
  });
});
```

Create `packages/templates/test/files/stub.test-tpl` with the single line:

```
hello
```

(The suite rewrites it in `beforeEach`; committing it keeps the `basePath` directory
present in a fresh clone.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/templates && npx ts-mocha -p tsconfig.json test/templates.test.ts`

Expected: FAIL — TypeScript errors: `Property 'withCache' does not exist on type 'StubRenderer'`, `Property 'resolveContent' does not exist`, and `Non-abstract class 'StubRenderer' does not implement inherited abstract member 'compile'`.

- [ ] **Step 4: Write the implementation**

Replace the entire contents of `packages/templates/src/interfaces.ts` with:

```ts
import { IMappableService } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AsyncService } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { fs, IStat, URI } from '@spinajs/fs';
import { readFile, stat as localStat } from 'fs/promises';
import { normalize } from 'path';

/**
 * How aggressively compiled templates are reused.
 *
 * cache      - compile once, reuse forever. Default.
 * revalidate - stat() the source and recompile only when its change token differs.
 * always     - recompile on every render.
 */
export type TemplateCacheMode = 'cache' | 'revalidate' | 'always';

export interface ITemplateCacheEntry {
  compiled: unknown;

  /**
   * Change token captured when this entry was compiled. Null when the mode does
   * not track one, or when the source could not be stat-ed.
   */
  token: string | null;
}

export abstract class TemplateRenderer extends AsyncService implements IMappableService {
  @Logger('renderer')
  protected Log: Log;

  @Config('templates.cache.mode')
  protected ConfiguredCacheMode: TemplateCacheMode;

  @Config('configuration.isDevelopment', { defaultValue: false })
  protected DevMode: boolean;

  protected Cache: Map<string, ITemplateCacheEntry> = new Map<string, ITemplateCacheEntry>();

  public abstract get Type(): string;

  public abstract get Extension(): string;

  public get ServiceName() {
    // we map this service by extension
    return this.Extension;
  }

  public abstract render(templatePath: string, model: unknown, language?: string): Promise<string>;
  public abstract renderToFile(templatePath: string, model: unknown, filePath: string, language?: string): Promise<void>;

  /**
   * Explicit config wins; otherwise dev mode implies always-recompile.
   */
  protected get CacheMode(): TemplateCacheMode {
    if (this.ConfiguredCacheMode) {
      return this.ConfiguredCacheMode;
    }

    return this.DevMode ? 'always' : 'cache';
  }

  protected isUri(template: string): boolean {
    return /^fs:\/\//.test(template);
  }

  /**
   * Bare paths are normalized as before. URIs must be left alone - path.normalize
   * would turn fs://name/x into fs:\name\x on windows and break URI parsing.
   */
  protected normalizeTemplate(template: string): string {
    return this.isUri(template) ? template : normalize(template);
  }

  /**
   * Template source as text. Bare paths read from local disk exactly as before -
   * routing them through the default provider would re-resolve relative paths
   * against its basePath and break existing callers.
   */
  protected async resolveContent(template: string): Promise<string> {
    if (!this.isUri(template)) {
      return await readFile(template, 'utf-8');
    }

    const content = await fs.read(new URI(template), 'utf-8');
    return Buffer.isBuffer(content) ? content.toString('utf-8') : content;
  }

  /**
   * A real local path. For renderers that cannot compile from a string (pug),
   * remote sources are materialised to temp storage.
   */
  protected async resolveLocalPath(template: string): Promise<string> {
    if (!this.isUri(template)) {
      return template;
    }

    return await fs.download(new URI(template));
  }

  /**
   * Opaque token that changes when the source changes. Null means "cannot tell" -
   * callers must then trust whatever they already have cached.
   */
  protected async changeToken(template: string): Promise<string | null> {
    try {
      if (this.isUri(template)) {
        return this.tokenFromStat(await fs.stat(new URI(template)));
      }

      const s = await localStat(template);
      return `${s.mtimeMs}|${s.size}`;
    } catch (err) {
      this.Log.warn(`Cannot stat template ${template}, serving cached version. ${err}`);
      return null;
    }
  }

  protected tokenFromStat(s: IStat): string {
    if (s.Version) {
      return s.Version;
    }

    return `${s.ModifiedTime?.toMillis() ?? 0}|${s.Size ?? 0}`;
  }

  /**
   * Compiled-template cache honouring CacheMode. `compile` runs only on a miss.
   */
  protected async withCache<T>(template: string, compile: () => Promise<T>): Promise<T> {
    const mode = this.CacheMode;

    if (mode === 'always') {
      return await compile();
    }

    const key = this.normalizeTemplate(template);
    const entry = this.Cache.get(key);
    let token: string | null = null;

    if (mode === 'revalidate') {
      token = await this.changeToken(template);

      // null token => stat failed; prefer a stale entry over failing the render
      if (entry && (token === null || token === entry.token)) {
        return entry.compiled as T;
      }
    } else if (entry) {
      return entry.compiled as T;
    }

    const compiled = await compile();
    this.Cache.set(key, { compiled, token });

    return compiled;
  }
}
```

Note what disappeared: `TemplatePaths`, `TemplateFiles`, `lodash` import, and the
`protected abstract compile(templateName, path)` declaration — all dead or replaced by
`withCache`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/templates && npx ts-mocha -p tsconfig.json test/templates.test.ts`
Expected: PASS (8 passing)

- [ ] **Step 6: Fix the config file**

Replace the entire contents of `packages/templates/src/config/templates.ts` with:

```ts
import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'templates', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'templates', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const templates = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
};

export default templates;
```

Two changes: the paths point at `@spinajs/templates` instead of `@spinajs/rbac` (a
copy-paste bug — `rbac` is not even a dependency of this package, so the shipped
`template-render` command was never discoverable), and the dead `templates` key is gone
now that `TemplatePaths` is removed.

- [ ] **Step 7: Verify the config fix**

Run: `cd packages/templates && grep -n "rbac\|dirs" src/config/templates.ts`

Expected: no `rbac` line anywhere; the only `dirs` entry is `cli`. Concretely, the output
should show `dirs: {` and `cli: [...dir('cli')],` and nothing mentioning rbac or templates
as a dirs key.

- [ ] **Step 8: Build the package**

Run: `cd packages/templates && npm run build`
Expected: compiles clean, no TS errors.

- [ ] **Step 9: Commit**

```bash
git add packages/templates/package.json packages/templates/tsconfig.json packages/templates/tsconfig.mjs.json packages/templates/tsconfig.cjs.json packages/templates/src/interfaces.ts packages/templates/src/config/templates.ts packages/templates/test/templates.test.ts packages/templates/test/files/stub.test-tpl package-lock.json
git commit -m "feat(templates): resolve sources through fs abstraction, add cache modes

TemplateRenderer gains resolveContent/resolveLocalPath, which honour the
fs:// URI scheme so templates can live on any registered provider. Bare
paths still read from local disk unchanged.

Adds cache modes (cache/revalidate/always). revalidate compares an opaque
change token from stat(), so a remote template is re-read only when it
actually changed - one HeadObject, not a download.

Also fixes system.dirs.cli, which pointed at @spinajs/rbac (not a
dependency), leaving the shipped template-render command undiscoverable.
Removes dead TemplatePaths/TemplateFiles and the unused
system.dirs.templates key."
```

---

### Task 4: `templates-handlebars` — resolve via base class

**Files:**
- Modify: `packages/templates-handlebars/src/index.ts` (`render` at :53-81, `compile` at :83-97, `Templates` map at :20)
- Test: `packages/templates-handlebars/test/templates.test.ts` (existing — append)
- Create: `packages/templates-handlebars/test/templates/uri-template.handlebars`

**Interfaces:**
- Consumes: `withCache`, `resolveContent` from Task 3.
- Produces: no new public API. `HandlebarsRenderer.render()` accepts `fs://` URIs in addition to local paths.

- [ ] **Step 1: Write the failing test**

Append to `packages/templates-handlebars/test/templates.test.ts`. First extend the existing
`ConnectionConf.onLoad()` return object with an `fs` section (add alongside the existing
`intl` / `logger` / `system` keys):

```ts
      fs: {
        defaultProvider: 'test-templates',
        providers: [{ service: 'fsNative', name: 'test-templates', basePath: dir('./templates') }],
      },
```

Add these imports at the top:

```ts
import { FsBootsrapper, fsService } from '@spinajs/fs';
```

Extend the existing `beforeEach` so the fs providers come up (it currently only does
`DI.clearCache()`, registers the config and resolves `Configuration`):

```ts
  beforeEach(async () => {
    DI.clearCache();
    DI.resolve(FsBootsrapper).bootstrap();
    DI.register(ConnectionConf).as(Configuration);

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
  });
```

Then append these tests inside the existing `describe('templates', ...)`:

```ts
  it('should render handlebar from fs:// uri', async () => {
    const t = await tp();
    const result = await t.render('fs://test-templates/uri-template.handlebars', { hello: 'world' });

    expect(result).to.eq('hello world');
  });
```

Only this one test. Language handling is orthogonal to source resolution and is already
covered by the suite's existing bare-path lang tests — a `fs://` + lang test against this
fixture would assert the same string as the test above and cover nothing new.

Create `packages/templates-handlebars/test/templates/uri-template.handlebars` containing exactly:

```
hello {{hello}}
```

Note: no trailing newline — the assertion compares the rendered output exactly. If your
editor adds one, the expectation becomes `'hello world\n'`; match the file to the test.

Add `@spinajs/fs` to `packages/templates-handlebars/package.json` `devDependencies` as
`"@spinajs/fs": "^2.0.481"` (test-only — the renderer itself never imports it; it reaches
the filesystem through the base class), add the matching tsconfig reference to
`packages/templates-handlebars/tsconfig.json` (`{ "path": "../fs/tsconfig.json" }` — the
test-inclusive config only), then run `npm install`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/templates-handlebars && npx ts-mocha -p tsconfig.json test/templates.test.ts -g "fs://"`

Expected: FAIL — `ENOENT: no such file or directory, open 'fs:\test-templates\uri-template.handlebars'` (the current code hands the normalized URI straight to `fs.readFileSync`).

- [ ] **Step 3: Write the implementation**

In `packages/templates-handlebars/src/index.ts`:

Delete the `Templates` map field (was line 20):

```ts
  protected Templates: Map<string, HandlebarsTemplateDelegate<any>> = new Map<string, HandlebarsTemplateDelegate<any>>();
```

Replace `render()` and delete `compile()` entirely, so the two methods become one:

```ts
  public async render(templateName: string, model: unknown, language?: string): Promise<string> {
    this.Log.trace(`Rendering template ${templateName}`);
    this.Log.timeStart(`HandlebarTemplate${templateName}`);

    if (!templateName) {
      throw new InvalidArgument('template parameter cannot be null or empty');
    }

    const fTemplate = await this.withCache(templateName, async () => {
      const tContent = await this.resolveContent(templateName);

      if (tContent.length === 0) {
        throw new IOFail(`Template file ${templateName} is empty`);
      }

      const tCompiled = Handlebars.compile(tContent, this.Options);

      if (!tCompiled) {
        throw new IOFail(`Cannot compile handlebars template from path ${templateName}`);
      }

      return tCompiled;
    });

    const lang = language ? language : guessLanguage();
    const tLang = lang ?? defaultLanguage();

    const content = fTemplate(
      _.merge(model ?? {}, {
        lang: tLang,
      }),
    );

    const time = this.Log.timeEnd(`HandlebarTemplate-${templateName}`);
    this.Log.trace(`Rendering template ${templateName} ended, (${time} ms)`);

    return content;
  }
```

Remove the now-unused `normalize` import from `'path'`. Keep `import * as fs from 'fs'` and
`import * as path from 'path'` — `renderToFile` still uses them (its destination handling is
out of scope per the spec).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/templates-handlebars && npx ts-mocha -p tsconfig.json test/templates.test.ts -g "fs://"`
Expected: PASS (1 passing)

- [ ] **Step 5: Run the full suite — bare-path regression check**

Run: `cd packages/templates-handlebars && npm test`
Expected: PASS — all pre-existing tests (`should render handlebar`, `should render handlebar with lang`, `should render handlebar with lang detected`, `should fail when template not exists`, `should render text center & right`) still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/templates-handlebars/src/index.ts packages/templates-handlebars/test/ packages/templates-handlebars/package.json packages/templates-handlebars/tsconfig.json package-lock.json
git commit -m "feat(templates-handlebars): resolve template source via fs abstraction

Compile through the base class helpers so handlebars templates can be
addressed with fs:// URIs and honour the shared cache modes. Local paths
are unaffected."
```

---

### Task 5: `templates-pug` — resolve via base class, fold `devMode` into cache mode

**Files:**
- Modify: `packages/templates-pug/src/index.ts` (`devMode` at :19-20, `render` at :45-78, `compile` at :80-89, `Templates` map at :17)
- Test: `packages/templates-pug/test/templates.test.ts` (existing — append)
- Create: `packages/templates-pug/test/templates/uri-template.pug`

**Interfaces:**
- Consumes: `withCache`, `resolveLocalPath` from Task 3.
- Produces: no new public API. `PugRenderer.render()` accepts `fs://` URIs; remote templates are downloaded to temp before compiling.

- [ ] **Step 1: Write the failing test**

Extend `packages/templates-pug/test/templates.test.ts` the same way as Task 4: add an `fs`
section to the config's `onLoad()` return object:

```ts
      fs: {
        defaultProvider: 'test-templates',
        providers: [{ service: 'fsNative', name: 'test-templates', basePath: dir('./templates') }],
      },
```

Add the import:

```ts
import { FsBootsrapper, fsService } from '@spinajs/fs';
```

Extend the existing `beforeEach` to bootstrap fs:

```ts
    DI.resolve(FsBootsrapper).bootstrap();
    // ... existing config registration ...
    await DI.resolve(fsService);
```

Append inside the existing top-level `describe`:

```ts
  it('should render pug from fs:// uri', async () => {
    const t = await tp();
    const result = await t.render('fs://test-templates/uri-template.pug', { hello: 'world' });

    expect(result).to.include('world');
  });
```

Create `packages/templates-pug/test/templates/uri-template.pug`:

```pug
p= hello
```

Add `@spinajs/fs` to `packages/templates-pug/package.json` `devDependencies` as
`"@spinajs/fs": "^2.0.481"`, add `{ "path": "../fs/tsconfig.json" }` to
`packages/templates-pug/tsconfig.json` references, then run `npm install`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/templates-pug && npx ts-mocha -p tsconfig.json test/templates.test.ts -g "fs://"`

Expected: FAIL — pug throws `ENOENT` / `The "path" argument must be of type string` for `fs:\test-templates\uri-template.pug`.

- [ ] **Step 3: Write the implementation**

In `packages/templates-pug/src/index.ts`:

Delete the `Templates` map field and the `devMode` config field:

```ts
  protected Templates: Map<string, pugTemplate.compileTemplate> = new Map<string, pugTemplate.compileTemplate>();

  @Config('configuration.isDevelopment')
  protected devMode: boolean;
```

(`devMode` now lives on the base class and feeds `CacheMode`; a local copy would shadow it.)

Replace `render()` and delete `compile()`:

```ts
  public async render(templateName: string, model: unknown, language?: string): Promise<string> {
    this.Log.trace(`Rendering pug template ${templateName}`);
    this.Log.timeStart(`PugTemplate.render.start.${templateName}`);

    if (!templateName) {
      throw new InvalidArgument('template parameter cannot be null or empty');
    }

    const fTemplate = await this.withCache(templateName, async () => {
      // pug compiles from a path, not a string - it resolves include/extends
      // against the local filesystem itself, so remote sources are materialised
      // to temp storage first.
      const tPath = await this.resolveLocalPath(templateName);
      const tCompiled = pugTemplate.compileFile(tPath, this.Options);

      if (!tCompiled) {
        throw new IOFail(`Cannot compile pug template ${templateName} from path ${tPath}`);
      }

      return tCompiled;
    });

    const lang = language ? language : guessLanguage();
    const tLang = lang ?? defaultLanguage();

    const content = fTemplate(
      _.merge(model ?? {}, {
        __: __translate(tLang),
        __n: __translateNumber(tLang),
        __l: __translateL,
        __h: __translateH,
      }),
    );

    const time = this.Log.timeEnd(`PugTemplate.render.start.${templateName}`);
    this.Log.trace(`Rendering pug template ${templateName} ended, (${time} ms)`);

    return content;
  }
```

Remove the now-unused `normalize` import from `'path'`. Keep `import * as fs from 'fs'` and
`import * as path from 'path'` for `renderToFile`. Keep the `Config` import — `templates.pug`
options still use it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/templates-pug && npx ts-mocha -p tsconfig.json test/templates.test.ts -g "fs://"`
Expected: PASS (1 passing)

- [ ] **Step 5: Run the full suite — regression check**

Run: `cd packages/templates-pug && npm test`
Expected: PASS — all pre-existing tests still pass, including any that relied on `devMode` recompilation.

- [ ] **Step 6: Commit**

```bash
git add packages/templates-pug/src/index.ts packages/templates-pug/test/ packages/templates-pug/package.json packages/templates-pug/tsconfig.json package-lock.json
git commit -m "feat(templates-pug): resolve template path via fs abstraction

Compile through the base class helpers, downloading remote sources to temp
since pug compiles from a path rather than a string. Drops the local
devMode flag in favour of the shared cache mode, which it duplicated."
```

---

### Task 6: `template-mjml` — end-to-end proof, no source change

**Files:**
- Test: `packages/template-mjml/test/mjml.test.ts` (existing — append)
- Create: `packages/template-mjml/test/templates/uri-template.mjml`

**Interfaces:**
- Consumes: everything from Tasks 3 and 4. No source changes — `MjmlRenderer.render()` delegates to `Templates.compile(templateName, 'handlebars', ...)`, so handlebars performs resolution and caching on its behalf.

**This task is the check on a claim, not a change.** If it fails, MJML does read files somewhere and the spec is wrong — stop and report rather than patching around it.

- [ ] **Step 1: Write the test**

Read `packages/template-mjml/test/mjml.test.ts` first and follow its existing config and
`beforeEach` conventions (it mirrors the handlebars suite). Add the `fs` provider section to
its config:

```ts
      fs: {
        defaultProvider: 'test-templates',
        providers: [{ service: 'fsNative', name: 'test-templates', basePath: dir('./templates') }],
      },
```

Add the import and bootstrap fs in `beforeEach`, exactly as in Task 4:

```ts
import { FsBootsrapper, fsService } from '@spinajs/fs';
```

Append:

```ts
  it('should render mjml from fs:// uri', async () => {
    const t = await tp();
    const result = await t.render('fs://test-templates/uri-template.mjml', { hello: 'world' });

    expect(result).to.include('world');
    expect(result).to.include('<!doctype html>');
  });
```

Create `packages/template-mjml/test/templates/uri-template.mjml`:

```html
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>{{hello}}</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```

Add `@spinajs/fs` to `packages/template-mjml/package.json` `devDependencies` as
`"@spinajs/fs": "^2.0.481"`, add `{ "path": "../fs/tsconfig.json" }` to
`packages/template-mjml/tsconfig.json` references, then run `npm install`.

- [ ] **Step 2: Run the test**

Run: `cd packages/template-mjml && npx ts-mocha -p tsconfig.json test/mjml.test.ts -g "fs://"`

Expected: PASS with no source change to `template-mjml`. MJML inherits `fs://` support through handlebars.

If it FAILS, stop and report — the spec's claim that MJML needs no change is wrong.

- [ ] **Step 3: Run the full suite**

Run: `cd packages/template-mjml && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/template-mjml/test/ packages/template-mjml/package.json packages/template-mjml/tsconfig.json package-lock.json
git commit -m "test(template-mjml): cover rendering from an fs:// uri

MJML delegates compilation to handlebars and never reads files itself, so
it inherits fs:// addressing with no source change. Lock that in - it is
the path the sn-step-schedules mailer lambda depends on."
```

---

### Task 7: Full monorepo verification

**Files:** none — verification only.

- [ ] **Step 1: Build everything**

Run: `npm run build`
Expected: all packages compile. Catches any project-reference mistake from Tasks 3-6.

- [ ] **Step 2: Run the affected suites**

```bash
cd packages/fs && npm test
cd ../templates && npm test
cd ../templates-handlebars && npm test
cd ../templates-pug && npm test
cd ../template-mjml && npm test
```

Expected: all PASS.

- [ ] **Step 3: Confirm downstream consumers still compile**

`email-smtp-transport` calls `Templates.render()` with a local temp path from its own
`fs.download()`. That path must be untouched:

```bash
cd packages/email-smtp-transport && npm run build
```

Expected: compiles clean.

- [ ] **Step 4: Report**

Summarise: which tasks landed, any test skipped (e.g. Task 2 if docker was unavailable),
and confirm `npm run build` is green. Do NOT claim S3 templates work end-to-end unless
Task 2 actually ran against localstack.

---

## Notes for the implementer

- **`FsBootsrapper` is required before resolving `fsService`.** Every fs-using suite in this repo calls `DI.resolve(FsBootsrapper).bootstrap()` first (see `packages/fs-s3/test/fs-s3.test.ts`). Skipping it yields confusing "provider not registered" errors.
- **`DI.clearCache()` in `beforeEach`** is the established pattern for isolating DI state between tests.
- **`fs` the package vs `fs` the node module.** Several files import both (`import * as fs from 'fs'` and `import { fs } from '@spinajs/fs'`). In `templates/src/interfaces.ts` the plan imports node's API as named functions from `fs/promises` specifically to avoid this collision. Do not "tidy" that into a namespace import.
- **`@Config` with no `defaultValue` yields `undefined` when unset** — that is what lets `CacheMode` distinguish "not configured" from "configured as `cache`", which is what makes `devMode` a *default* rather than an override.
- **The `templates` suite needs no `intl` config**, even though `Templates` is decorated `@Inject(Intl)`. The `intl` package ships defaults (`defaultLocale: 'en'`) via its own `src/config/locales.ts`, and `SpineJsInternationalizationFromJson.resolve()` iterates registered `TranslationSource`s — of which there are none in that suite — so it no-ops. The handlebars suite configures `intl` and `system.dirs.locales` only because it asserts on translated output.
- **Renderers are mapped by extension** (`ServiceName` returns `Extension`), so the stub renderer's `.test-tpl` must not collide with a real renderer's extension.
