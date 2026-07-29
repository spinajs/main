# Per-environment ORM migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a migration declare the environment it belongs to — `Foo_2026_07_29_10_00_00.local.ts` runs only under `APP_ENV=local`, an unsuffixed file runs everywhere — following the convention `@spinajs/configuration` already uses for config files.

**Architecture:** A new injectable `MigrationSource` service supplies migration types to `Orm`, mirroring `ControllerSource` in `@spinajs/http`. `FilesystemMigrationSource` globs `system.dirs.migrations` and imports only the files whose suffix matches the current env; `DiRegistryMigrationSource` yields the existing `__migrations__` DI registrations. `Orm.resolve()` merges the sources, resolves each migration's env from its filename suffix and its `@Migration` option, dedupes by class name, and registers only the ones that match — so a non-matching migration is absent from `up`, `down` and `status` alike.

**Tech Stack:** TypeScript (ESM + CJS dual build), `@spinajs/di`, `glob` v8, mocha + chai + sinon via `ts-mocha`, luxon.

**Design spec:** [`docs/superpowers/specs/2026-07-29-orm-migration-environments-design.md`](../specs/2026-07-29-orm-migration-environments-design.md)

## Global Constraints

- **ESM import style:** every relative import must carry the `.js` extension, even from a `.ts` file (`import { x } from './foo.js'`). This is repo-wide and the build breaks without it.
- **No new dependencies.** `@spinajs/orm` already depends on `glob` and `@spinajs/configuration-common`; it must NOT gain a dependency on `@spinajs/reflection` (which pulls in `typescript`) or on `@spinajs/configuration` (which would invert the package graph).
- **Env normalization is one function.** `dev`/`development` → `dev`, `prod`/`production` → `prod`, anything else verbatim, absent → `prod`. Every comparison in this feature goes through it — never compare raw `APP_ENV` strings.
- **Class name is migration identity.** The `_yyyy_MM_dd_HH_mm_ss` timestamp is read from the CLASS name, never from the file name. Nothing in this plan changes that.
- **Backwards compatible.** `@Migration('connection')` with one argument must keep working, `getEnvironment()` on `BaseFileSource` keeps its signature, and an app with no `system.dirs.migrations` configured must behave exactly as it does today.
- **Test commands** are run from inside the package directory: `cd packages/<pkg> && npx ts-mocha -p tsconfig.json test/<file>.test.ts`.
- **Commit style:** conventional commits (`feat:`, `fix:`, `test:`, `docs:`), matching the repo's history.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/configuration-common/src/environment.ts` | **Create.** `normalizeEnvironment()` — the single env-name normalizer, shared by config file loading and migrations. |
| `packages/configuration-common/src/index.ts` | **Modify.** Re-export `environment.js`. |
| `packages/configuration-common/src/index.browser.ts` | **Modify.** Same re-export (the function is pure, so it is browser-safe). |
| `packages/configuration/src/sources.ts` | **Modify.** `BaseFileSource.getEnvironment()` delegates to the shared function. |
| `packages/orm/src/interfaces.ts` | **Modify.** `IMigrationDescriptor` gains `Env` and `SourceFile`; new `IMigrationOptions`. |
| `packages/orm/src/source-file.ts` | **Create.** `captureSourceFile()` — V8-stack walk that finds the file a decorator was applied in. |
| `packages/orm/src/decorators.ts` | **Modify.** `Migration()` accepts options and stamps `SourceFile`. |
| `packages/orm/src/migration-environment.ts` | **Create.** Filename-suffix parsing and the suffix-vs-decorator resolution rule. |
| `packages/orm/src/migration-sources.ts` | **Create.** `MigrationSource` abstract + filesystem and DI-registry implementations. |
| `packages/orm/src/config/orm.ts` | **Create.** Ships `system.dirs.migrations` defaults. |
| `packages/orm/src/orm.ts` | **Modify.** Replace the `__migrations__` block with source merge → env resolve → dedupe → filter. |
| `packages/orm/src/index.ts` | **Modify.** Export the three new modules. |
| `packages/orm-cli/src/cli/MigrateCreate.ts` | **Modify.** `--env` flag; suffixed filename and `Env` in the scaffold. |
| `packages/orm/docs/10-schema-and-migrations.md` | **Modify.** Document the convention. |

Tests: `packages/configuration-common/test/environment.test.ts`, `packages/orm/test/migration-environment.test.ts`, `packages/orm/test/migration-sources.test.ts` (+ fixture dirs under `packages/orm/test/mocks/migration-env/`), additions to `packages/orm/test/migration.test.ts` and `packages/orm-cli/test/cli.test.ts`.

---

### Task 1: Shared env normalization

**Files:**
- Create: `packages/configuration-common/src/environment.ts`
- Modify: `packages/configuration-common/src/index.ts`
- Modify: `packages/configuration-common/src/index.browser.ts`
- Modify: `packages/configuration/src/sources.ts:192-204`
- Test: `packages/configuration-common/test/environment.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeEnvironment(env?: string | null): string` exported from `@spinajs/configuration-common`. Tasks 3, 4 and 5 all call it.

- [ ] **Step 1: Write the failing test**

Create `packages/configuration-common/test/environment.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { normalizeEnvironment } from '../src/environment.js';

const expect = chai.expect;

describe('normalizeEnvironment', () => {
  it('collapses the development aliases', () => {
    expect(normalizeEnvironment('dev')).to.equal('dev');
    expect(normalizeEnvironment('development')).to.equal('dev');
  });

  it('collapses the production aliases', () => {
    expect(normalizeEnvironment('prod')).to.equal('prod');
    expect(normalizeEnvironment('production')).to.equal('prod');
  });

  it('passes any other name through verbatim', () => {
    expect(normalizeEnvironment('local')).to.equal('local');
    expect(normalizeEnvironment('staging')).to.equal('staging');
    // case is NOT folded - `Local` and `local` are different environments
    expect(normalizeEnvironment('Local')).to.equal('Local');
  });

  it('treats absent and empty as production', () => {
    expect(normalizeEnvironment(undefined)).to.equal('prod');
    expect(normalizeEnvironment(null)).to.equal('prod');
    expect(normalizeEnvironment('')).to.equal('prod');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/configuration-common && npx ts-mocha -p tsconfig.json test/environment.test.ts`
Expected: FAIL — cannot find module `../src/environment.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/configuration-common/src/environment.ts`:

```ts
/**
 * The environment name spinajs matches file suffixes against.
 *
 * One function rather than one per consumer: config file loading ( `foo.dev.js` ) and migration
 * file loading ( `Foo_2026_07_29_10_00_00.dev.ts` ) MUST agree on what `dev` means, or a
 * deployment would load its dev config while running its prod migrations.
 *
 * Case is deliberately not folded: `Local` and `local` are different environments, exactly as
 * they are to the shell that sets APP_ENV.
 */
export function normalizeEnvironment(env?: string | null): string {
  // empty string is "unset" - an exported-but-blank APP_ENV must not become an environment named ''
  const value = env && env.length > 0 ? env : 'production';

  switch (value) {
    case 'dev':
    case 'development':
      return 'dev';
    case 'prod':
    case 'production':
      return 'prod';
    default:
      return value;
  }
}
```

Add to `packages/configuration-common/src/index.ts`, after the `definitions.js` line:

```ts
export * from './environment.js';
```

Add the same line to `packages/configuration-common/src/index.browser.ts`, after its `definitions.js` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/configuration-common && npx ts-mocha -p tsconfig.json test/environment.test.ts`
Expected: PASS, 4 passing.

- [ ] **Step 5: Delegate from the configuration package**

In `packages/configuration/src/sources.ts`, add `normalizeEnvironment` to the existing `@spinajs/configuration-common` import on line 9:

```ts
import { Configuration, ConfigurationSource, IConfigLike, normalizeEnvironment } from '@spinajs/configuration-common';
```

Replace the whole `getEnvironment` method (lines 192-204) with:

```ts
  /**
   * Delegates to `normalizeEnvironment` so config file loading and migration file loading can
   * never disagree about what an environment name means. Signature kept - subclasses override it.
   */
  protected getEnvironment(config: Configuration) {
    return normalizeEnvironment(config.get<string>('process.env.APP_ENV', undefined) ?? this.Env);
  }
```

- [ ] **Step 6: Run the configuration suite to verify nothing moved**

Run: `cd packages/configuration && npx ts-mocha -p tsconfig.json test/config.test.ts`
Expected: PASS — the same count as before the change, no failures.

- [ ] **Step 7: Commit**

```bash
git add packages/configuration-common/src/environment.ts packages/configuration-common/src/index.ts packages/configuration-common/src/index.browser.ts packages/configuration-common/test/environment.test.ts packages/configuration/src/sources.ts
git commit -m "feat(configuration-common): share environment normalization"
```

---

### Task 2: `@Migration` options and source-file capture

**Files:**
- Modify: `packages/orm/src/interfaces.ts:450-455`
- Create: `packages/orm/src/source-file.ts`
- Modify: `packages/orm/src/decorators.ts:123-143`
- Modify: `packages/orm/src/index.ts`
- Test: `packages/orm/test/migration-decorator.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface IMigrationOptions { Env?: string }`
  - `IMigrationDescriptor` now `{ Connection: string; Env?: string; SourceFile?: string }`
  - `Migration(connection: string, options?: IMigrationOptions): (target: any) => void`
  - `captureSourceFile(skipMarkers: string[]): string | undefined` from `packages/orm/src/source-file.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/orm/test/migration-decorator.test.ts`:

```ts
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import { IMigrationDescriptor, MIGRATION_DESCRIPTION_SYMBOL, Migration, OrmDriver, OrmMigration } from '../src/index.js';

const expect = chai.expect;

const descriptorOf = (type: unknown): IMigrationDescriptor | undefined => (type as Record<symbol, IMigrationDescriptor>)[MIGRATION_DESCRIPTION_SYMBOL];

/** Prefixed like every other migration fixture in this package - see the note in migration-runner.test.ts. */
@Migration('some-connection')
class MigrationDecoratorTest_Plain_2026_07_29_10_00_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

@Migration('some-connection', { Env: 'local' })
class MigrationDecoratorTest_Tagged_2026_07_29_10_01_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

describe('@Migration', () => {
  after(() => {
    DI.unregister(MigrationDecoratorTest_Plain_2026_07_29_10_00_00);
    DI.unregister(MigrationDecoratorTest_Tagged_2026_07_29_10_01_00);
  });

  it('keeps the single-argument form working', () => {
    const d = descriptorOf(MigrationDecoratorTest_Plain_2026_07_29_10_00_00);

    expect(d?.Connection).to.equal('some-connection');
    expect(d?.Env, 'an untagged migration must not carry an env').to.equal(undefined);
  });

  it('records the Env option', () => {
    expect(descriptorOf(MigrationDecoratorTest_Tagged_2026_07_29_10_01_00)?.Env).to.equal('local');
  });

  it('captures the file the decorator was applied in', () => {
    const file = descriptorOf(MigrationDecoratorTest_Plain_2026_07_29_10_00_00)?.SourceFile;

    expect(file, 'no source file was captured').to.be.a('string');
    expect(file!.replace(/\\/g, '/')).to.contain('test/migration-decorator.test.ts');
  });

  it('still registers the class under __migrations__', () => {
    expect(DI.getRegisteredTypes('__migrations__')).to.include(MigrationDecoratorTest_Plain_2026_07_29_10_00_00);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/migration-decorator.test.ts`
Expected: FAIL — TypeScript rejects the second argument to `Migration(...)`.

- [ ] **Step 3: Extend the descriptor**

In `packages/orm/src/interfaces.ts`, replace the `IMigrationDescriptor` block (lines 450-455) with:

```ts
/**
 * Options a migration may declare alongside its connection.
 */
export interface IMigrationOptions {
  /**
   * Environment this migration belongs to, eg. `local`. Absent means every environment.
   *
   * This is the declaration for migrations registered by IMPORT, where no file path is in play -
   * a package re-exporting its migrations from `index.ts`. For migrations discovered from disk the
   * filename suffix says the same thing, and the two must agree.
   */
  Env?: string;
}

export interface IMigrationDescriptor {
  /**
   * Whitch connection migration will be executed
   */
  Connection: string;

  /**
   * Environment this migration belongs to - see IMigrationOptions.Env
   */
  Env?: string;

  /**
   * Absolute path of the file `@Migration()` was applied in, captured off the V8 stack at
   * decoration time. Best-effort: `undefined` under a bundler that mangles paths, in which case
   * `Env` above is the only env signal the migration has.
   */
  SourceFile?: string;
}
```

- [ ] **Step 4: Add the stack-walk helper**

Create `packages/orm/src/source-file.ts`:

```ts
/**
 * Walk the current V8 stack and return the absolute path of the first frame that is NOT inside
 * one of `skipMarkers`. Called from a decorator, that frame is the decorated class's own source
 * file. Works for CJS ( `at ... (C:\foo\bar.js:12:3)` ) and ESM ( `at ... (file:///C:/foo/bar.js:12:3)` ).
 *
 * Lifted from `@spinajs/http`'s `captureControllerSourceFile` - the two packages cannot share it
 * without one depending on the other, and http sits above orm in the graph.
 */
export function captureSourceFile(skipMarkers: string[]): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;

  const lines = stack.split('\n');

  for (const line of lines) {
    if (skipMarkers.some((m) => line.includes(m))) continue;
    // Match `(path:line:col)` or bare `path:line:col` at the end of the frame.
    const m = line.match(/\(([^()]+):\d+:\d+\)\s*$/) || line.match(/at\s+([^\s()]+):\d+:\d+\s*$/);
    if (!m) continue;

    let file = m[1];

    if (file.startsWith('file://')) {
      try {
        // Strip the ESM url scheme. Windows: file:///C:/foo -> C:/foo, POSIX paths stay as-is.
        file = decodeURIComponent(file.replace(/^file:\/\/\/?/, ''));

        if (!/^[A-Za-z]:/.test(file) && !file.startsWith('/')) {
          file = `/${file}`;
        }
      } catch {
        // fall through with the raw match
      }
    }

    return file;
  }

  return undefined;
}
```

- [ ] **Step 5: Extend the decorator**

In `packages/orm/src/decorators.ts`, add the import at the top of the file, next to the other relative imports:

```ts
import { captureSourceFile } from './source-file.js';
```

Add `IMigrationOptions` to the existing `./interfaces.js` import on line 4.

Replace the `Migration` function (lines 123-143) with:

```ts
/**
 * The frames that sit between `@Migration()` and the migration's own file: this module, and the
 * transpiler / metadata helpers that call into it.
 */
const MIGRATION_SOURCE_SKIP_MARKERS = ['decorators.ts', 'decorators.js', 'source-file.ts', 'source-file.js', 'tslib', 'reflect-metadata', '__decorate', '__esDecorate', 'node:internal'];

/**
 * Sets migration option
 *
 * @param connection - connection name, must exists in configuration file
 * @param options - optional migration options, eg. the environment it belongs to
 */
export function Migration(connection: string, options?: IMigrationOptions) {
  // captured OUTSIDE the returned function on purpose: this is the frame the user's file called,
  // so the stack still points at their migration source rather than at the decorator application
  const sourceFile = captureSourceFile(MIGRATION_SOURCE_SKIP_MARKERS);

  return (target: any) => {
    let metadata = target[MIGRATION_DESCRIPTION_SYMBOL] as IMigrationDescriptor;

    if (!metadata) {
      metadata = {
        Connection: '',
      };
      target[MIGRATION_DESCRIPTION_SYMBOL] = metadata;
    }

    metadata.Connection = connection;
    metadata.Env = options?.Env;
    metadata.SourceFile = sourceFile;

    DI.register(target).as('__migrations__');
  };
}
```

Add to `packages/orm/src/index.ts`, right after the `export * from './symbols.js';` line:

```ts
export * from './source-file.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/migration-decorator.test.ts`
Expected: PASS, 4 passing.

- [ ] **Step 7: Run the existing migration suites to verify nothing broke**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/migration.test.ts test/migration-runner.test.ts test/migration-service.test.ts`
Expected: PASS, no failures.

- [ ] **Step 8: Commit**

```bash
git add packages/orm/src/interfaces.ts packages/orm/src/source-file.ts packages/orm/src/decorators.ts packages/orm/src/index.ts packages/orm/test/migration-decorator.test.ts
git commit -m "feat(orm): @Migration takes an Env option and captures its source file"
```

---

### Task 3: Filename suffix parsing and the env resolution rule

**Files:**
- Create: `packages/orm/src/migration-environment.ts`
- Modify: `packages/orm/src/index.ts`
- Test: `packages/orm/test/migration-environment.test.ts`

**Interfaces:**
- Consumes: `normalizeEnvironment` (Task 1).
- Produces, all from `packages/orm/src/migration-environment.ts`:
  - `parseMigrationFileEnv(file: string): string | undefined` — normalized env tag from a path, `undefined` when there is none. Throws `OrmException` on two or more tags.
  - `resolveMigrationEnv(name: string, file: string, decoratorEnv?: string): string | undefined` — the suffix/decorator agreement rule.
  - `mergeMigrationEnv(name: string, a: { env?: string; file: string }, b: { env?: string; file: string }): string | undefined` — the dedupe rule (Task 5 uses it).
  - `MIGRATION_DI_SOURCE = '<di>'`

- [ ] **Step 1: Write the failing test**

Create `packages/orm/test/migration-environment.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import * as path from 'node:path';
import { MIGRATION_DI_SOURCE, OrmException, mergeMigrationEnv, parseMigrationFileEnv, resolveMigrationEnv } from '../src/index.js';

const expect = chai.expect;

const p = (...parts: string[]) => path.join('C:', 'app', 'src', 'migrations', ...parts);

describe('parseMigrationFileEnv', () => {
  it('returns undefined for an unsuffixed file', () => {
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.ts'))).to.equal(undefined);
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.js'))).to.equal(undefined);
  });

  it('returns the tag of a suffixed file', () => {
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.local.ts'))).to.equal('local');
  });

  it('normalizes the tag', () => {
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.development.ts'))).to.equal('dev');
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.production.js'))).to.equal('prod');
  });

  it('is not confused by dots in the directories above it', () => {
    expect(parseMigrationFileEnv(path.join('C:', 'my.app', 'v1.2', 'Foo_2026_07_29_10_00_00.ts'))).to.equal(undefined);
  });

  it('returns undefined for the DI sentinel', () => {
    expect(parseMigrationFileEnv(MIGRATION_DI_SOURCE)).to.equal(undefined);
  });

  it('refuses more than one tag', () => {
    expect(() => parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.local.dev.ts'))).to.throw(OrmException, /one environment/);
  });
});

describe('resolveMigrationEnv', () => {
  it('takes the suffix when only the file carries one', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.local.ts'), undefined)).to.equal('local');
  });

  it('takes the decorator when only it carries one', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.ts'), 'local')).to.equal('local');
  });

  it('normalizes the decorator value', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', MIGRATION_DI_SOURCE, 'development')).to.equal('dev');
  });

  it('accepts agreement, including across aliases', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.dev.ts'), 'development')).to.equal('dev');
  });

  it('refuses disagreement, naming both sides', () => {
    const call = () => resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.local.ts'), 'dev');

    expect(call).to.throw(OrmException, /local/);
    expect(call).to.throw(OrmException, /dev/);
  });

  it('returns undefined when neither carries one', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.ts'), undefined)).to.equal(undefined);
  });
});

describe('mergeMigrationEnv', () => {
  const entry = (env: string | undefined, file: string) => ({ env, file });

  it('lets a defined env win over an absent one, in either order', () => {
    expect(mergeMigrationEnv('Foo', entry(undefined, MIGRATION_DI_SOURCE), entry('local', p('Foo.local.ts')))).to.equal('local');
    expect(mergeMigrationEnv('Foo', entry('local', p('Foo.local.ts')), entry(undefined, MIGRATION_DI_SOURCE))).to.equal('local');
  });

  it('keeps an agreed env', () => {
    expect(mergeMigrationEnv('Foo', entry('local', p('a', 'Foo.local.ts')), entry('local', p('b', 'Foo.local.ts')))).to.equal('local');
  });

  it('keeps absent when neither side has one', () => {
    expect(mergeMigrationEnv('Foo', entry(undefined, p('Foo.ts')), entry(undefined, MIGRATION_DI_SOURCE))).to.equal(undefined);
  });

  it('refuses two different envs, naming both origins', () => {
    const call = () => mergeMigrationEnv('Foo', entry('local', p('src', 'Foo.local.ts')), entry('dev', p('lib', 'Foo.dev.js')));

    expect(call).to.throw(OrmException, /Foo\.local\.ts/);
    expect(call).to.throw(OrmException, /Foo\.dev\.js/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/migration-environment.test.ts`
Expected: FAIL — `parseMigrationFileEnv` is not exported from `../src/index.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/orm/src/migration-environment.ts`:

```ts
import { normalizeEnvironment } from '@spinajs/configuration-common';
import * as path from 'node:path';
import { OrmException } from './exceptions.js';

/**
 * `ClassInfo.file` for a migration whose source file could not be determined - registered through
 * DI under a bundler that mangles stack paths. Such an entry has no suffix to read, so its
 * `@Migration({ Env })` option is its only env signal.
 */
export const MIGRATION_DI_SOURCE = '<di>';

/**
 * The environment tag carried by a migration's FILE NAME, normalized, or `undefined` when it has
 * none. The tag is the single dot-segment between the class name and the extension:
 *
 *   Foo_2026_07_29_10_00_00.ts        -> undefined  ( every environment )
 *   Foo_2026_07_29_10_00_00.local.ts  -> 'local'
 *   Foo_2026_07_29_10_00_00.dev.ts    -> 'dev'
 *
 * Only the BASENAME is examined - a project living under `C:\my.app\v1.2\` would otherwise read
 * its directory names as environments.
 */
export function parseMigrationFileEnv(file: string): string | undefined {
  // basename() only knows the host's separator, and a path can arrive in either form ( glob hands
  // back forward slashes even on win32 ), so both are cut here
  const base = file.split(/[\\/]/).pop() ?? file;
  const segments = base.split('.');

  // [name] alone is the '<di>' sentinel or an extensionless path; [name, ext] is unsuffixed
  if (segments.length <= 2) {
    return undefined;
  }

  if (segments.length > 3) {
    throw new OrmException(`Migration file ${file} carries more than one environment tag (${segments.slice(1, -1).join(', ')}) - a migration belongs to exactly one environment. Rename it to <Name>_yyyy_MM_dd_HH_mm_ss.<env>.ts`);
  }

  return normalizeEnvironment(segments[1]);
}

/**
 * The environment a single discovered migration belongs to, from its file name and its
 * `@Migration({ Env })` option.
 *
 * Both present and disagreeing throws rather than picking a winner: the two are the same
 * declaration written twice, so a contradiction is always a mistake, and silently choosing one
 * means the migration runs somewhere nobody intended. Comparison happens after normalization, so
 * `.dev.ts` plus `{ Env: 'development' }` agree.
 */
export function resolveMigrationEnv(name: string, file: string, decoratorEnv?: string): string | undefined {
  const fromFile = parseMigrationFileEnv(file);
  const fromDecorator = decoratorEnv ? normalizeEnvironment(decoratorEnv) : undefined;

  if (fromFile !== undefined && fromDecorator !== undefined && fromFile !== fromDecorator) {
    throw new OrmException(`Migration ${name} declares environment '${fromDecorator}' via @Migration but its file ${file} is suffixed '${fromFile}'. Remove one of them.`);
  }

  return fromFile ?? fromDecorator;
}

/**
 * The environment of two entries that turned out to be the same migration - the same class name
 * reached from two origins, which is the NORMAL case: `src/` and `lib/` hold the same class, and a
 * file discovered on disk is also registered through DI by the import that discovered it.
 *
 * An absent env is not a vote and never conflicts, because the DI entry for a discovered
 * `.local` file carries no suffix - letting it "win" by arriving first would drop the tag and run
 * the migration everywhere. Two DIFFERENT envs are a genuine contradiction and throw.
 */
export function mergeMigrationEnv(name: string, a: { env?: string; file: string }, b: { env?: string; file: string }): string | undefined {
  if (a.env !== undefined && b.env !== undefined && a.env !== b.env) {
    throw new OrmException(`Migration ${name} is declared for environment '${a.env}' by ${a.file} and for '${b.env}' by ${b.file}. The same migration cannot belong to two environments.`);
  }

  return a.env ?? b.env;
}
```

Add to `packages/orm/src/index.ts`, right after the `export * from './source-file.js';` line added in Task 2:

```ts
export * from './migration-environment.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/migration-environment.test.ts`
Expected: PASS, 16 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/orm/src/migration-environment.ts packages/orm/src/index.ts packages/orm/test/migration-environment.test.ts
git commit -m "feat(orm): migration environment parsing and resolution rules"
```

---

### Task 4: `MigrationSource` services and the config defaults

**Files:**
- Create: `packages/orm/src/migration-sources.ts`
- Create: `packages/orm/src/config/orm.ts`
- Modify: `packages/orm/src/index.ts`
- Test fixtures: `packages/orm/test/mocks/migration-env/Always_2026_07_29_10_00_00.ts`, `.../OnlyLocal_2026_07_29_10_01_00.local.ts`, `.../OnlyDev_2026_07_29_10_02_00.dev.ts`
- Test: `packages/orm/test/migration-sources.test.ts`

**Interfaces:**
- Consumes: `normalizeEnvironment` (Task 1), `MIGRATION_DESCRIPTION_SYMBOL` and `IMigrationDescriptor` (Task 2), `MIGRATION_DI_SOURCE` (Task 3).
- Produces, from `packages/orm/src/migration-sources.ts`:
  - `abstract class MigrationSource extends AsyncService { abstract getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> }`
  - `class FilesystemMigrationSource extends MigrationSource` — `@Injectable(MigrationSource)`
  - `class DiRegistryMigrationSource extends MigrationSource` — `@Injectable(MigrationSource)`
- Also produces the config key `system.dirs.migrations` (array of absolute paths).

- [ ] **Step 1: Write the fixture migrations**

Three real migration files, committed rather than written to a scratch directory at run time. They
must genuinely extend `OrmMigration` — the source filters exports on exactly that — which means
they must import from this package, which a temp directory with no `node_modules` cannot resolve.
`ts-mocha` registers `ts-node`, so importing a `.ts` file at run time works, and this is how the
repo's other packages load `src` assets in tests.

None of them carries `@Migration()`: a decorator here would register the class into the root
container's `__migrations__` for the whole test process and leak into `migration.test.ts`, which
asserts on how many migrations the Orm found.

Create `packages/orm/test/mocks/migration-env/Always_2026_07_29_10_00_00.ts`:

```ts
import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

// records that this module was EXECUTED - the sharpest assertion in migration-sources.test.ts is
// that a foreign-environment migration is never even imported
((globalThis as unknown as Record<string, string[]>).__migrationSideEffects__ ??= []).push('Always_2026_07_29_10_00_00.ts');

export class Always_2026_07_29_10_00_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}
  public async down(_connection: OrmDriver): Promise<void> {}
}
```

Create `packages/orm/test/mocks/migration-env/OnlyLocal_2026_07_29_10_01_00.local.ts`:

```ts
import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

((globalThis as unknown as Record<string, string[]>).__migrationSideEffects__ ??= []).push('OnlyLocal_2026_07_29_10_01_00.local.ts');

export class OnlyLocal_2026_07_29_10_01_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}
  public async down(_connection: OrmDriver): Promise<void> {}
}
```

Create `packages/orm/test/mocks/migration-env/OnlyDev_2026_07_29_10_02_00.dev.ts`:

```ts
import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

((globalThis as unknown as Record<string, string[]>).__migrationSideEffects__ ??= []).push('OnlyDev_2026_07_29_10_02_00.dev.ts');

export class OnlyDev_2026_07_29_10_02_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}
  public async down(_connection: OrmDriver): Promise<void> {}
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/orm/test/migration-sources.test.ts`. Note the suite structure: the `prod` block is
declared FIRST and does its discovery once, in `before`. That ordering is load-bearing — Node
caches a module after its first import, so a "was never imported" assertion made after any test
that legitimately imported the file would pass for the wrong reason.

```ts
import { Configuration } from '@spinajs/configuration';
import { ClassInfo, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as path from 'node:path';
import { DiRegistryMigrationSource, FilesystemMigrationSource, MIGRATION_DI_SOURCE, Migration, OrmDriver, OrmMigration } from '../src/index.js';
import { ConnectionConf, registerFakes } from './misc.js';
import '@spinajs/log';

const expect = chai.expect;

const FIXTURES = path.resolve(path.join(process.cwd(), 'test', 'mocks', 'migration-env'));

const sideEffects = ((globalThis as unknown as Record<string, string[]>).__migrationSideEffects__ ??= []);

/** Configuration whose only job is to point `system.dirs.migrations` at the fixture directory. */
class MigrationSourcesConf extends ConnectionConf {
  public static Env = 'prod';
  public static Dirs: string[] = [FIXTURES];

  public async resolve(): Promise<void> {
    await super.resolve();

    this.set('system.dirs.migrations', MigrationSourcesConf.Dirs);
    this.set('process.env.APP_ENV', MigrationSourcesConf.Env);
  }
}

@Migration('sqlite', { Env: 'local' })
class MigrationSourcesTest_Registered_2026_07_29_10_00_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

async function discover(): Promise<Array<ClassInfo<OrmMigration>>> {
  DI.clearCache();
  return await (await DI.resolve(FilesystemMigrationSource)).getMigrations();
}

describe('FilesystemMigrationSource under prod', () => {
  let found: Array<ClassInfo<OrmMigration>>;

  before(async () => {
    registerFakes();
    DI.register(MigrationSourcesConf).as(Configuration);

    MigrationSourcesConf.Env = 'prod';
    MigrationSourcesConf.Dirs = [FIXTURES];
    found = await discover();
  });

  it('finds the unsuffixed migration', () => {
    expect(found.map((f) => f.name)).to.include('Always_2026_07_29_10_00_00');
  });

  it('reports the file it came from', () => {
    const always = found.find((f) => f.name === 'Always_2026_07_29_10_00_00');

    expect(always!.file.replace(/\\/g, '/')).to.contain('mocks/migration-env/Always_2026_07_29_10_00_00.ts');
  });

  it('does not find migrations belonging to other environments', () => {
    expect(found.map((f) => f.name)).to.not.include('OnlyLocal_2026_07_29_10_01_00');
    expect(found.map((f) => f.name)).to.not.include('OnlyDev_2026_07_29_10_02_00');
  });

  it('never IMPORTS a migration from another environment', () => {
    // importing fires @Migration, which would register the class no matter what filter ran after
    expect(sideEffects, 'a foreign-environment migration was executed by the mere act of discovery').to.not.include('OnlyLocal_2026_07_29_10_01_00.local.ts');
    expect(sideEffects).to.not.include('OnlyDev_2026_07_29_10_02_00.dev.ts');
    // the matching one was executed, so the absence above is a filter and not a broken fixture
    expect(sideEffects).to.include('Always_2026_07_29_10_00_00.ts');
  });

  it('returns nothing when no directory is configured', async () => {
    MigrationSourcesConf.Dirs = [];

    expect(await discover()).to.have.lengthOf(0);

    MigrationSourcesConf.Dirs = [FIXTURES];
  });

  it('survives a directory that does not exist', async () => {
    MigrationSourcesConf.Dirs = [path.join(FIXTURES, 'no-such-dir')];

    expect(await discover()).to.have.lengthOf(0);

    MigrationSourcesConf.Dirs = [FIXTURES];
  });
});

describe('FilesystemMigrationSource under local', () => {
  let found: Array<ClassInfo<OrmMigration>>;

  before(async () => {
    MigrationSourcesConf.Env = 'local';
    found = await discover();
  });

  after(() => {
    MigrationSourcesConf.Env = 'prod';
  });

  it('finds this environment\'s migration alongside the unsuffixed one', () => {
    expect(found.map((f) => f.name)).to.include('OnlyLocal_2026_07_29_10_01_00');
    expect(found.map((f) => f.name)).to.include('Always_2026_07_29_10_00_00');
  });

  it('still excludes another environment\'s', () => {
    expect(found.map((f) => f.name)).to.not.include('OnlyDev_2026_07_29_10_02_00');
  });
});

describe('DiRegistryMigrationSource', () => {
  after(() => {
    DI.unregister(MigrationSourcesTest_Registered_2026_07_29_10_00_00);
  });

  it('yields DI-registered migrations with the file the decorator captured', async () => {
    DI.clearCache();
    const found = await (await DI.resolve(DiRegistryMigrationSource)).getMigrations();
    const entry = found.find((f) => f.name === 'MigrationSourcesTest_Registered_2026_07_29_10_00_00');

    expect(entry, 'the DI registry source did not report a decorated migration').to.not.equal(undefined);
    expect(entry!.file.replace(/\\/g, '/')).to.contain('test/migration-sources.test.ts');
    expect(entry!.file).to.not.equal(MIGRATION_DI_SOURCE);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/migration-sources.test.ts`
Expected: FAIL — `FilesystemMigrationSource` is not exported from `../src/index.js`.

- [ ] **Step 4: Write the sources**

Create `packages/orm/src/migration-sources.ts`:

```ts
import { Configuration, normalizeEnvironment } from '@spinajs/configuration-common';
import { AsyncService, Autoinject, Class, ClassInfo, DI, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import glob from 'glob';
import _ from 'lodash';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMigrationDescriptor, OrmMigration } from './interfaces.js';
import { MIGRATION_DI_SOURCE } from './migration-environment.js';
import { MIGRATION_DESCRIPTION_SYMBOL } from './symbols.js';

/**
 * Supplies migration types to `Orm`.
 *
 * Sources only DISCOVER migrations ( type + origin file ) - they never construct or run them.
 * `Orm` merges every registered source, resolves each migration's environment, dedupes and
 * registers what is left.
 *
 * To plug in another discovery mechanism ( a plugin manifest, a remote registry ) implement this
 * class and decorate it `@Injectable(MigrationSource)`.
 */
export abstract class MigrationSource extends AsyncService {
  public abstract getMigrations(): Promise<Array<ClassInfo<OrmMigration>>>;
}

/**
 * Discovers migrations by scanning the directories configured at `system.dirs.migrations`.
 *
 * Two globs per directory: unsuffixed files, which belong to every environment, and files carrying
 * this environment's tag. Files belonging to another environment are never MATCHED, and therefore
 * never imported - which is the whole point rather than an optimization. Importing a migration
 * fires its `@Migration` decorator, which registers the class into `__migrations__`, and
 * `DiRegistryMigrationSource` would then hand it back no matter what filter ran afterwards.
 *
 * This is also why `@ListFromFiles` from `@spinajs/reflection` is not used here: it imports
 * everything it lists, and its glob is fixed at decoration time while the environment is only
 * known at runtime.
 */
@Injectable(MigrationSource)
export class FilesystemMigrationSource extends MigrationSource {
  @Logger('ORM')
  protected Log: Log;

  @Autoinject()
  protected Configuration: Configuration;

  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    const dirs = this.Configuration.get<string[]>('system.dirs.migrations', []) ?? [];

    if (dirs.length === 0) {
      return [];
    }

    const env = normalizeEnvironment(this.Configuration.get<string>('process.env.APP_ENV', undefined));

    // `!(*.*)` - a basename with no dot at all, so it also excludes `*.d.ts` for free
    const patterns = ['/**/!(*.*).{ts,js}', `/**/*.${env}.{ts,js}`];

    const files = _.uniq(dirs)
      .filter((d) => {
        if (fs.existsSync(d)) {
          return true;
        }

        this.Log.trace(`Migration directory ${d} does not exist - skipped`);
        return false;
      })
      .flatMap((d) => patterns.flatMap((p) => glob.sync(path.join(d, p).replace(/\\/g, '/'))))
      .map((f) => path.normalize(path.resolve(f)));

    const result: Array<ClassInfo<OrmMigration>> = [];

    // the same file is reachable from two configured directories ( `lib/migrations` and a path
    // that resolves to it ), and importing it twice would report the same class twice
    for (const file of _.uniq(files)) {
      this.Log.trace(`Loading migration file ${file}`);

      let module: Record<string, unknown>;

      try {
        module = (await DI.__spinajs_require__(file)) as Record<string, unknown>;
      } catch (err) {
        // reachable in normal operation: the default directories include `src/migrations`, so a
        // compiled deployment tries the `.ts` copy of every migration and fails. The `.js` copy is
        // found by the same scan, so warning and moving on is right - throwing would make a
        // shipped default take the boot down
        this.Log.warn(`Could not load migration file ${file}: ${(err as Error).message}`);
        continue;
      }

      for (const [name, exported] of Object.entries(module)) {
        if (typeof exported !== 'function' || !(exported.prototype instanceof OrmMigration)) {
          continue;
        }

        result.push({ file, name: (exported as Class<OrmMigration>).name || name, type: exported as Class<OrmMigration> });
      }
    }

    return result;
  }
}

/**
 * Discovers migrations registered in the DI container under `__migrations__` - which is what the
 * `@Migration` decorator does, so this covers every migration reached by IMPORT: a package
 * re-exporting its migrations from `index.ts`, a test declaring one inline, or a file this
 * process's `FilesystemMigrationSource` has just imported.
 *
 * The origin file is the path `@Migration` captured off the stack, and the sentinel
 * `MIGRATION_DI_SOURCE` when that capture came back empty.
 */
@Injectable(MigrationSource)
export class DiRegistryMigrationSource extends MigrationSource {
  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    const types = (DI.getRegisteredTypes<OrmMigration>('__migrations__') ?? []) as Array<Class<OrmMigration>>;

    return types.map((type) => {
      const descriptor = (type as unknown as Record<symbol, IMigrationDescriptor | undefined>)[MIGRATION_DESCRIPTION_SYMBOL];

      return { file: descriptor?.SourceFile ?? MIGRATION_DI_SOURCE, name: type.name, type };
    });
  }
}
```

- [ ] **Step 5: Ship the config defaults**

Create `packages/orm/src/config/orm.ts`:

```ts
import { join, normalize, resolve } from 'path';

/**
 * Migration directories are the APPLICATION's, not this package's - `@spinajs/orm` ships no
 * migrations of its own. So these resolve off the process working directory, matching the default
 * `@spinajs/orm-cli`'s `migrate-create` writes to.
 *
 * All three build layouts are listed because a project is scanned wherever it happens to have been
 * compiled to. A migration found in more than one of them is the same class name twice and is
 * deduped by `Orm`; the `src` copy of a compiled project fails to import and is warned about.
 */
function dir(...parts: string[]) {
  return resolve(normalize(join(process.cwd(), ...parts)));
}

const orm = {
  system: {
    dirs: {
      migrations: [dir('src', 'migrations'), dir('lib', 'migrations'), dir('dist', 'migrations')],
    },
  },
};

export default orm;
```

Add to `packages/orm/src/index.ts`, right after the `export * from './migration-environment.js';` line added in Task 3:

```ts
export * from './migration-sources.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/migration-sources.test.ts`
Expected: PASS, 9 passing.

- [ ] **Step 7: Commit**

```bash
git add packages/orm/src/migration-sources.ts packages/orm/src/config/orm.ts packages/orm/src/index.ts packages/orm/test/migration-sources.test.ts packages/orm/test/mocks/migration-env/
git commit -m "feat(orm): injectable MigrationSource with env-aware file discovery"
```

---

### Task 5: Wire discovery, dedupe and filtering into `Orm`

**Files:**
- Modify: `packages/orm/src/orm.ts:172-178` (the registration block), `packages/orm/src/orm.ts:342-358` (`registerMigration`)
- Test: `packages/orm/test/migration-env.test.ts`

**Interfaces:**
- Consumes: `MigrationSource` (Task 4), `resolveMigrationEnv` / `mergeMigrationEnv` / `MIGRATION_DI_SOURCE` (Task 3), `normalizeEnvironment` (Task 1), `MIGRATION_DESCRIPTION_SYMBOL` (Task 2).
- Produces: `Orm.Migrations` now holds only migrations belonging to the current environment, each `ClassInfo.file` carrying its real origin path. `registerMigration(migration: Class<T>, file?: string)` — the second parameter is new and defaults to the previous `${name}.registered` sentinel.

- [ ] **Step 1: Write the failing test**

Create `packages/orm/test/migration-env.test.ts`:

```ts
import { Configuration } from '@spinajs/configuration';
import { ClassInfo, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import { Migration, MigrationSource, Orm, OrmDriver, OrmException, OrmMigration } from '../src/index.js';
import { ConnectionConf, bootstrapAll, registerFakes } from './misc.js';
import '../src/bootstrap.js';
import '@spinajs/log';

const expect = chai.expect;

class MigrationEnvTest_Always_2026_07_29_10_00_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

class MigrationEnvTest_Local_2026_07_29_10_01_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

/**
 * Reaches the Orm through the DI registry the decorator writes to - no file suffix in play, which
 * is the shape a package re-exporting its migrations from `index.ts` has.
 */
@Migration('sqlite', { Env: 'local' })
class MigrationEnvTest_Decorated_2026_07_29_10_02_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

/**
 * A source under the test's control, so these cases never depend on files on disk. It reports
 * exactly the entries a test hands it, `file` included - which is what carries the env suffix.
 */
class FakeMigrationSource extends MigrationSource {
  public static Entries: Array<ClassInfo<OrmMigration>> = [];

  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    return FakeMigrationSource.Entries;
  }
}

class EnvConf extends ConnectionConf {
  public static Env = 'prod';

  public async resolve(): Promise<void> {
    await super.resolve();
    this.set('process.env.APP_ENV', EnvConf.Env);
  }
}

const entry = (type: any, file: string): ClassInfo<OrmMigration> => ({ file, name: type.name, type });

describe('Orm migration environments', () => {
  before(() => {
    registerFakes();
    DI.register(EnvConf).as(Configuration);
    DI.register(FakeMigrationSource).as(MigrationSource);
  });

  after(() => {
    DI.unregister(FakeMigrationSource);
    // `@Migration` registers into the ROOT container and the registration outlives this file -
    // migration.test.ts asserts on how many migrations the Orm found
    DI.unregister(MigrationEnvTest_Decorated_2026_07_29_10_02_00);
  });

  beforeEach(async () => {
    DI.removeAllListeners('di.resolve.Configuration');
    FakeMigrationSource.Entries = [];
    await bootstrapAll();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('registers an unsuffixed migration under any environment', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Always_2026_07_29_10_00_00, '/app/MigrationEnvTest_Always_2026_07_29_10_00_00.js')];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.map((m) => m.name)).to.include('MigrationEnvTest_Always_2026_07_29_10_00_00');
  });

  it('registers a suffixed migration under its own environment', async () => {
    EnvConf.Env = 'local';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/MigrationEnvTest_Local_2026_07_29_10_01_00.local.js')];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.map((m) => m.name)).to.include('MigrationEnvTest_Local_2026_07_29_10_01_00');
  });

  it('makes a foreign-environment migration entirely invisible', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/MigrationEnvTest_Local_2026_07_29_10_01_00.local.js')];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.map((m) => m.name)).to.not.include('MigrationEnvTest_Local_2026_07_29_10_01_00');

    // and invisible to the report too, not merely skipped by the run
    const status = await orm.Migration.status();
    expect(status.map((s) => s.name)).to.not.include('MigrationEnvTest_Local_2026_07_29_10_01_00');
  });

  it('keeps the env tag when the same class is reported by a second, untagged origin', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [
      entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/MigrationEnvTest_Local_2026_07_29_10_01_00.local.js'),
      // the DI registry's view of the very same class, with no suffix to read
      entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '<di>'),
    ];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.map((m) => m.name), 'the untagged duplicate dropped the .local tag').to.not.include('MigrationEnvTest_Local_2026_07_29_10_01_00');
  });

  it('registers a duplicated migration exactly once', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Always_2026_07_29_10_00_00, '/app/src/MigrationEnvTest_Always_2026_07_29_10_00_00.js'), entry(MigrationEnvTest_Always_2026_07_29_10_00_00, '/app/lib/MigrationEnvTest_Always_2026_07_29_10_00_00.js')];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.filter((m) => m.name === 'MigrationEnvTest_Always_2026_07_29_10_00_00')).to.have.lengthOf(1);
  });

  it('honours an Env declared on the decorator alone, with no file suffix in play', async () => {
    // registered through DI by the decorator below, not by any source this test controls - the
    // path a package re-exporting its migrations from index.ts takes
    EnvConf.Env = 'prod';

    const underProd = await DI.resolve(Orm);
    expect(underProd.Migrations.map((m) => m.name)).to.not.include('MigrationEnvTest_Decorated_2026_07_29_10_02_00');

    DI.clearCache();
    EnvConf.Env = 'local';

    const underLocal = await DI.resolve(Orm);
    expect(underLocal.Migrations.map((m) => m.name)).to.include('MigrationEnvTest_Decorated_2026_07_29_10_02_00');
  });

  it('refuses one class claimed by two different environments', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/src/MigrationEnvTest_Local_2026_07_29_10_01_00.local.js'), entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/lib/MigrationEnvTest_Local_2026_07_29_10_01_00.dev.js')];

    let err: unknown;
    try {
      await DI.resolve(Orm);
    } catch (e) {
      err = e;
    }

    expect(err, 'two environments for one migration were accepted').to.be.instanceOf(OrmException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/migration-env.test.ts`
Expected: FAIL — the Orm ignores `MigrationSource` entirely, so the suffixed migration is registered under `prod`.

- [ ] **Step 3: Replace the registration block**

In `packages/orm/src/orm.ts`, add to the existing `@spinajs/configuration-common` import on line 2:

```ts
import { Configuration, normalizeEnvironment } from '@spinajs/configuration-common';
```

Add these imports next to the other relative ones:

```ts
import { MIGRATION_DESCRIPTION_SYMBOL } from './symbols.js';
import { IMigrationDescriptor } from './interfaces.js';
import { mergeMigrationEnv, resolveMigrationEnv } from './migration-environment.js';
import { MigrationSource } from './migration-sources.js';
```

`IMigrationDescriptor` may need adding to the existing `./interfaces.js` import on line 6 instead of a second import line — merge it there.

Replace lines 172-178:

```ts
    // add all registered migrations via DI
    const migrations = DI.getRegisteredTypes<OrmMigration>('__migrations__');
    if (migrations) {
      migrations.forEach((m) => {
        this.registerMigration(m);
      });
    }
```

with:

```ts
    // Every registered MigrationSource, merged, env-filtered and deduped. Deliberately BEFORE the
    // model registration below: a discovered file may declare models as well, and importing it
    // has to happen before `__models__` is read.
    for (const m of await this.discoverMigrations()) {
      this.registerMigration(m.type, m.file);
    }
```

- [ ] **Step 4: Add the discovery method**

In `packages/orm/src/orm.ts`, add this method directly above `registerMigration` (which is at line 342 before this change):

```ts
  /**
   * Everything every `MigrationSource` found, reduced to the migrations this environment runs.
   *
   * Three passes, in this order and for a reason each:
   *
   * - env resolution happens per ENTRY, before anything is merged, because it is the entry's FILE
   *   that carries the suffix;
   * - dedupe merges entries sharing a class name - the normal case, since a file discovered on
   *   disk is also registered through DI by the import that discovered it, and `src` and `lib`
   *   hold the same class twice;
   * - filtering happens here rather than in `MigrationRunner.plan()` so a migration belonging to
   *   another environment never enters `Orm.Migrations` at all, and is therefore absent from
   *   `up`, `down` AND `status` alike.
   */
  protected async discoverMigrations(): Promise<Array<{ type: Class<OrmMigration>; file: string }>> {
    const sources = await this.Container.resolve(Array.ofType(MigrationSource));
    const merged = new Map<string, { type: Class<OrmMigration>; file: string; env?: string }>();

    for (const source of sources) {
      for (const found of await source.getMigrations()) {
        const descriptor = (found.type as unknown as Record<symbol, IMigrationDescriptor | undefined>)[MIGRATION_DESCRIPTION_SYMBOL];
        const env = resolveMigrationEnv(found.name, found.file, descriptor?.Env);
        const previous = merged.get(found.name);

        if (!previous) {
          merged.set(found.name, { type: found.type, file: found.file, env });
          continue;
        }

        if (previous.type !== found.type) {
          // two DIFFERENT classes under one name - the runner records migrations by name, so only
          // one of them can ever be tracked. Nothing here can tell which is meant
          this.Log.warn(`Two different migration classes are both named ${found.name} ( ${previous.file} and ${found.file} ) - keeping the first. Rename one of them.`);
        }

        merged.set(found.name, {
          type: previous.type,
          file: previous.file,
          env: mergeMigrationEnv(found.name, { env: previous.env, file: previous.file }, { env, file: found.file }),
        });
      }
    }

    const environment = normalizeEnvironment(this.Configuration.get<string>('process.env.APP_ENV', undefined));

    return [...merged.values()].filter((m) => {
      if (m.env === undefined || m.env === environment) {
        return true;
      }

      this.Log.trace(`Migration ${m.type.name} belongs to environment '${m.env}' and this process runs as '${environment}' - it is not registered`);
      return false;
    });
  }
```

- [ ] **Step 5: Let `registerMigration` carry the origin file**

In `packages/orm/src/orm.ts`, replace the signature and the push in `registerMigration`:

```ts
  protected registerMigration<T extends OrmMigration>(migration: Class<T>, file?: string) {
```

and

```ts
    this.Migrations.push({
      file: file ?? `${migration.name}.registered`,
      name: `${migration.name}`,
      type: migration,
    });
```

Leave the name validation above it untouched.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/migration-env.test.ts`
Expected: PASS, 7 passing.

- [ ] **Step 7: Run the whole orm suite**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json "test/**/*.test.ts"`
Expected: PASS. `migration.test.ts` asserts on how many migrations the Orm found — if a count moved, the cause is `DiRegistryMigrationSource` reporting the same registrations the old block read, which must produce the identical set. Investigate rather than adjusting the expected number.

- [ ] **Step 8: Commit**

```bash
git add packages/orm/src/orm.ts packages/orm/test/migration-env.test.ts
git commit -m "feat(orm): register only migrations belonging to the current environment"
```

---

### Task 6: `migrate-create --env`

**Files:**
- Modify: `packages/orm-cli/src/cli/MigrateCreate.ts`
- Test: `packages/orm-cli/test/cli.test.ts` (add to the existing `describe('migrate-create')` block, which ends at line 1112)

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime; the emitted scaffold uses `@Migration(connection, { Env })` from Task 2.
- Produces: `IMigrateCreateCommandOptions` gains `env?: string`; `migrationTemplate(cls: string, connection: string, env?: string): string`; `ENV_NAME_REGEXP`.

- [ ] **Step 1: Write the failing test**

Add these three tests inside the existing `describe('migrate-create', ...)` in `packages/orm-cli/test/cli.test.ts`, immediately before its closing `});` on line 1112:

```ts
  it('writes an env-suffixed file and tags the class to match', async () => {
    const dir = path.join(scratch, 'env');
    const cmd = await DI.resolve(MigrateCreateCommand);

    await captureStdout(() => cmd.execute({ name: 'SeedTestData', dir, connection: 'default', env: 'local' }));

    const file = fs.readdirSync(dir)[0];
    expect(file).to.match(/^SeedTestData_\d{4}(_\d{2}){5}\.local\.ts$/);

    const cls = file.replace(/\.local\.ts$/, '');
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');

    // both, on purpose: they agree so the conflict check passes, and the tag then survives
    // whichever way the file ends up registered - discovered from disk, or re-exported
    expect(content).to.contain(`@Migration('default', { Env: 'local' })`);
    expect(content).to.contain(`export class ${cls} extends OrmMigration {`);
  });

  it('writes no suffix and no Env when --env is absent', async () => {
    const dir = path.join(scratch, 'no-env');
    const cmd = await DI.resolve(MigrateCreateCommand);

    await captureStdout(() => cmd.execute({ name: 'NoEnv', dir }));

    const file = fs.readdirSync(dir)[0];
    expect(file).to.match(/^NoEnv_\d{4}(_\d{2}){5}\.ts$/);
    expect(fs.readFileSync(path.join(dir, file), 'utf-8')).to.contain(`@Migration('default')`);
  });

  it('refuses an env name that could not be a file suffix', async () => {
    const dir = path.join(scratch, 'bad-env');
    const cmd = await DI.resolve(MigrateCreateCommand);

    for (const env of ['', 'has space', 'has.dot', "quote')"]) {
      const err = await thrownBy(() => cmd.execute({ name: 'Fine', dir, env }));
      expect(err, `"${env}" was accepted`).to.be.instanceOf(InvalidArgument);
    }

    expect(fs.existsSync(dir), 'a refused env still created its target directory').to.equal(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/orm-cli && npx ts-mocha -p tsconfig.json test/cli.test.ts -g "migrate-create"`
Expected: FAIL — TypeScript rejects `env` on the options object.

- [ ] **Step 3: Implement the flag**

In `packages/orm-cli/src/cli/MigrateCreate.ts`:

Add `env` to the options interface:

```ts
export interface IMigrateCreateCommandOptions {
  name: string;
  dir?: string;
  connection?: string;
  env?: string;
}
```

Add the env charset guard next to the two existing ones:

```ts
/**
 * The env tag becomes a dot-segment in the file name AND a string literal inside `@Migration()`,
 * so it may carry neither a dot ( which would read as a second tag ) nor anything that could close
 * that literal.
 */
export const ENV_NAME_REGEXP = /^[A-Za-z][A-Za-z0-9-]*$/;
```

Replace `migrationTemplate` (lines 37-63) — only the signature and the decorator line change:

```ts
export function migrationTemplate(cls: string, connection: string, env?: string): string {
  return `/* eslint-disable @typescript-eslint/no-unused-vars */
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/**
 * TODO: describe the schema change this migration makes.
 */
@Migration('${connection}'${env ? `, { Env: '${env}' }` : ''})
export class ${cls} extends OrmMigration {
  /**
   * Schema changes. Models are NOT wired up yet at this point - reach the database through
   * \`connection\`, never through a model class.
   */
  public async up(connection: OrmDriver): Promise<void> {
    // TODO: await connection.schema().createTable('table_name', (table) => { ... });
  }

  /**
   * Undoes \`up()\`. Leave it empty only when the change genuinely cannot be reversed - an empty
   * \`down()\` makes migrate-down report success while changing nothing.
   */
  public async down(connection: OrmDriver): Promise<void> {
    // TODO: await connection.schema().dropTable('table_name');
  }
}
`;
}
```

Add the option declaration under the existing ones on the class:

```ts
@Option('-e, --env [env]', false, 'environment this migration belongs to, eg. local - omit to run it in every environment')
```

In `execute`, add the validation after the connection check:

```ts
    if (options.env !== undefined && !ENV_NAME_REGEXP.test(options.env)) {
      throw new InvalidArgument(`Invalid environment name "${options.env}" - a letter followed by letters, digits or dashes. It becomes both a file suffix and a string inside @Migration().`);
    }
```

Then change the file name and the template call:

```ts
    const file = path.join(dir, `${cls}${options.env ? `.${options.env}` : ''}.ts`);
```

```ts
      fs.writeFileSync(file, migrationTemplate(cls, connection, options.env), { flag: 'wx', encoding: 'utf-8' });
```

And extend the closing log line so the env is stated:

```ts
    this.Log.info(`Created migration ${cls} for connection "${connection}"${options.env ? ` in environment "${options.env}"` : ''}. It only takes effect once the class is imported - re-export it from your package or application index, the way src/migrations files are re-exported elsewhere, so the @Migration decorator runs and registers it. A file under system.dirs.migrations is discovered without that.`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/orm-cli && npx ts-mocha -p tsconfig.json test/cli.test.ts -g "migrate-create"`
Expected: PASS, 7 passing.

- [ ] **Step 5: Run the whole orm-cli suite**

Run: `cd packages/orm-cli && npx ts-mocha -p tsconfig.json test/cli.test.ts`
Expected: PASS, no failures.

- [ ] **Step 6: Commit**

```bash
git add packages/orm-cli/src/cli/MigrateCreate.ts packages/orm-cli/test/cli.test.ts
git commit -m "feat(orm-cli): migrate-create --env scaffolds an environment-scoped migration"
```

---

### Task 7: Documentation

**Files:**
- Modify: `packages/orm/docs/10-schema-and-migrations.md` (insert a new `###` section after `### The name is data`, which ends where `### The three hooks` begins on line 19)

**Interfaces:**
- Consumes: everything from Tasks 1-6. Produces no code.

- [ ] **Step 1: Write the section**

Insert into `packages/orm/docs/10-schema-and-migrations.md`, between `### The name is data` and `### The three hooks`:

````markdown
### Environments

A migration may belong to one environment. The environment is a dot-suffix on the FILE name — the
same convention `@spinajs/configuration` uses for config files:

```
src/migrations/
  CreateUsers_2026_07_29_10_00_00.ts         every environment
  SeedTestData_2026_07_29_10_05_00.local.ts  APP_ENV=local only
  SeedFixtures_2026_07_29_10_06_00.dev.ts    APP_ENV=dev or development
```

The tag is matched after the same normalization config files get: `development` and `dev` are one
environment, `production` and `prod` are another, anything else is taken verbatim, and an unset
`APP_ENV` means `prod`. Case is not folded — `Local` and `local` are different.

A migration belonging to another environment is **entirely invisible**: it is never imported, never
registered, and absent from `migrate-up`, `migrate-down` and `migrate-status` alike. One
consequence is worth knowing before you rely on it — a `.local` migration applied on a machine that
later boots as another environment leaves a tracking row with no migration behind it, and
`migrate-down` reports that row as an orphan whose file was "deleted or renamed". Nothing is
actually wrong; do not follow that advice for such a row.

Scaffold one with the CLI:

```bash
spinajs migrate-create --name SeedTestData --env local
```

#### Where migrations are found

Files are discovered under `system.dirs.migrations`, which defaults to `src/migrations`,
`lib/migrations` and `dist/migrations` relative to the process working directory. Point it wherever
your migrations live:

```js
// config file
export default {
  system: {
    dirs: {
      migrations: [`${process.cwd()}/lib/migrations`],
    },
  },
};
```

A migration reached by `import` rather than by discovery — a package re-exporting its migrations
from `index.ts` — declares its environment on the decorator instead:

```ts
@Migration('default', { Env: 'local' })
export class SeedTestData_2026_07_29_10_05_00 extends OrmMigration {}
```

Both may be present, and `migrate-create --env` writes both. They must agree: a file suffixed
`.local` whose decorator says `dev` fails the boot rather than picking a winner.

#### Plugging in your own discovery

`Orm` takes migrations from every `MigrationSource` registered in the container. Two ship with the
package — one scanning the filesystem, one reading the `@Migration` registrations — and another is
a class away:

```ts
import { ClassInfo, Injectable } from '@spinajs/di';
import { MigrationSource, OrmMigration } from '@spinajs/orm';

@Injectable(MigrationSource)
export class ManifestMigrationSource extends MigrationSource {
  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    return [{ file: '<manifest>', name: MyMigration_2026_07_29_10_00_00.name, type: MyMigration_2026_07_29_10_00_00 }];
  }
}
```

A source only discovers — it never constructs or runs anything. The `file` it reports is what the
suffix rule reads, so a source that has no real file should report a sentinel and declare the
environment on the decorator instead.
````

- [ ] **Step 2: Verify the doc matches the code**

Read back the section and check each claim against the implementation: the default `system.dirs.migrations` value against `packages/orm/src/config/orm.ts`, the decorator shape against `packages/orm/src/decorators.ts`, and the `MigrationSource` signature against `packages/orm/src/migration-sources.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/orm/docs/10-schema-and-migrations.md
git commit -m "docs(orm): per-environment migrations"
```

---

## Final verification

- [ ] **Run every affected suite**

```bash
cd packages/configuration-common && npx ts-mocha -p tsconfig.json "test/**/*.test.ts"
cd ../configuration && npx ts-mocha -p tsconfig.json "test/**/*.test.ts"
cd ../orm && npx ts-mocha -p tsconfig.json "test/**/*.test.ts"
cd ../orm-cli && npx ts-mocha -p tsconfig.json "test/**/*.test.ts"
```

Expected: PASS in all four, no failures.

- [ ] **Build the changed packages** — the test runner uses `ts-mocha`, so a type error in a path no test exercises would otherwise ship

```bash
cd packages/configuration-common && npm run compile
cd ../configuration && npm run compile
cd ../orm && npm run compile
cd ../orm-cli && npm run compile
```

Expected: no `tsc` errors.

- [ ] **Lint the changed packages**

```bash
cd packages/orm && npm run lint
cd ../orm-cli && npm run lint
```

Expected: no errors.

- [ ] **Verify the dependents still build** — `@spinajs/queue`, `@spinajs/rbac`, `@spinajs/tasks` and `@spinajs/orm-http` all ship migrations registered by import, which is the path Task 5 rewrote

```bash
cd packages/queue && npx ts-mocha -p tsconfig.json test/core.test.ts
cd ../orm-http && npx ts-mocha -p tsconfig.json test/dto-relation-resolve.test.ts
```

Expected: PASS. Cross-package tests run against the compiled `lib` of their dependencies, so run the `npm run compile` step above before these.
