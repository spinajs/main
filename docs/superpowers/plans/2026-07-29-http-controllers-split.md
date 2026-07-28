# HTTP Controllers Split & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `packages/http/src/controllers.ts` into focused files, extract controller discovery into injectable `ControllerSource` services, and make registration failures throw typed exceptions.

**Architecture:** `BaseController` moves to `base-controller.ts` and delegates route wiring to pure helpers in `route-builder.ts`. Discovery becomes a DI collection of `ControllerSource` implementations (filesystem scan + DI registry). `Controllers` stays the orchestrator: merge sources, register types, one `Array.ofType(BaseController)` resolve pass, override/shadow reporting, mount shared router. Fail-fast via `ControllerRegistrationException` / `RouteRegistrationException`.

**Tech Stack:** TypeScript ESM, `@spinajs/di`, Express 4, ts-mocha + chai tests (`npm test` inside `packages/http`).

## Global Constraints

- Public API through `@spinajs/http` barrel unchanged; `Controllers.Controllers` list property MUST keep working (http-swagger `swagger-service.ts:100` and tests depend on it).
- Fail-fast is unconditional — no lenient config flag.
- Warn (not throw) stays for: controller without descriptor (abstract base), file-scan entry without `type`.
- Per-request runtime error handling (policy gate, action wrapper) preserved verbatim.
- Spec: `docs/superpowers/specs/2026-07-29-http-controllers-split-design.md`.
- All commands run from `packages/http` unless noted. Test: `npx ts-mocha -p tsconfig.json test/<file>.test.ts`.

---

### Task 1: Typed exceptions

**Files:**
- Modify: `packages/http/src/exceptions.ts`

**Interfaces:**
- Produces: `ControllerRegistrationException`, `RouteRegistrationException` (both `extends Exception` from `@spinajs/exceptions`). Used by Tasks 2, 3, 5.

- [ ] **Step 1: Add exceptions**

```ts
/** Controller-level registration failure (unresolved instance, missing router). Thrown during startup — fail fast. */
export class ControllerRegistrationException extends Exception {}

/** Route-level registration failure (unknown route type, unresolvable policy, missing route member). Thrown during startup — fail fast. */
export class RouteRegistrationException extends Exception {}
```

- [ ] **Step 2: Commit** — `git commit -m "feat(http): typed exceptions for controller/route registration"`

### Task 2: Extract `route-builder.ts`

**Files:**
- Create: `packages/http/src/route-builder.ts`
- Test: `packages/http/test/route-builder.test.ts`

**Interfaces (Produces, consumed by Task 3):**

```ts
export function buildRoutePath(basePath: string, route: IRoute, globalPrefix?: string): string;
export function resolveRouteMiddlewares(descriptor: IControllerDescriptor, route: IRoute, container: IContainer): Promise<RouteMiddleware[]>;
// throws RouteRegistrationException when a string policy name has no resolvable type in config
export function resolveRoutePolicies(descriptor: IControllerDescriptor, route: IRoute, container: IContainer, cfg: Configuration, log: Log, controllerName: string, path: string): Promise<BasePolicy[]>;
export function createPolicyGate(policies: BasePolicy[], route: IRoute, controller: IController, log: Log): Express.RequestHandler;
export function wrapMiddlewareAction(source: object, action: (req, res, route, controller) => Promise<void>, route: IRoute, controller: IController): Express.RequestHandler;
export function createActionHandler(controller: BaseControllerLike, route: IRoute, enabledMiddlewares: RouteMiddleware[], storage: AsyncLocalStorage<IActionLocalStoregeContext>): Express.RequestHandler;
export function extractRouteArgs(route: IRoute, req: Request, res: Express.Response, controllerName: string): Promise<any[]>;
```

`BaseControllerLike` = minimal structural type `{ constructor; [action: string]: any }` + `IController` bits needed (avoids importing BaseController → no cycle).

Bodies are moved verbatim from `controllers.ts` lines 88-296 with these changes:
- `self` references become explicit `controller`/`controllerName` parameters.
- Policy resolution: config-name miss throws `RouteRegistrationException` (message keeps config key + controller + route) instead of warn+null. Class-typed policies unchanged.
- `acionWrapper` renamed `actionHandler` inside `createActionHandler`.
- Policy gate logic (allSettled, enabled-policy early exit, next(err) forwarding) copied unchanged, comments included.

- [ ] **Step 1: Write failing tests** for `buildRoutePath` (route path '/', nested path, no path → method name, global prefix, basePath '/') and `resolveRoutePolicies` string-miss throw. Test file skeleton:

```ts
import 'mocha';
import { expect } from 'chai';
import { buildRoutePath } from '../src/route-builder.js';

describe('route-builder', () => {
  it('builds base path for route path "/"', () => {
    expect(buildRoutePath('user', { Path: '/' } as any)).to.eq('/user');
  });
  it('joins base and route path', () => {
    expect(buildRoutePath('user', { Path: 'grants' } as any)).to.eq('/user/grants');
  });
  it('handles basePath "/"', () => {
    expect(buildRoutePath('/', { Path: 'grants' } as any)).to.eq('/grants');
  });
  it('falls back to method name', () => {
    expect(buildRoutePath('user', { Method: 'refresh' } as any)).to.eq('/user/refresh');
  });
  it('prepends global prefix', () => {
    expect(buildRoutePath('user', { Path: 'grants' } as any, 'api/v1')).to.eq('/api/v1/user/grants');
  });
});
```

Policy-throw test uses fake container/cfg objects (`{ get: () => undefined }`) and expects `RouteRegistrationException`.

- [ ] **Step 2: Run** `npx ts-mocha -p tsconfig.json test/route-builder.test.ts` — FAIL (module not found).
- [ ] **Step 3: Create `route-builder.ts`** with the moved implementations.
- [ ] **Step 4: Run test** — PASS.
- [ ] **Step 5: Commit** — `feat(http): extract route wiring helpers to route-builder`

### Task 3: Extract `base-controller.ts`

**Files:**
- Create: `packages/http/src/base-controller.ts`
- Modify: `packages/http/src/controllers.ts` (remove BaseController, import from new file)
- Modify: `packages/http/src/cache.ts` (type import → `./base-controller.js`)

**Interfaces:**
- Consumes: Task 2 helpers, Task 1 exceptions.
- Produces: `BaseController` (unchanged public surface: `Router`, `Descriptor`, `BasePath`, `resolve()`), exported from `base-controller.ts` and re-exported by barrel.

`resolve()` becomes orchestration only:

```ts
public async resolve() {
  await super.resolve();
  if (!this.Descriptor) {
    this._log.warn(`Controller ${this.constructor.name} does not have descriptor. If its abstract or base class ignore this message.`);
    return;
  }
  this._router = Express.Router();
  for (const [, route] of this.Descriptor.Routes) {
    if (route.InternalType === 'unknown') {
      throw new RouteRegistrationException(`Unknown route type for ${this.constructor.name}::${String(route.Method)}`);
    }
    const path = buildRoutePath(this.BasePath, route, this._cfg.get('http.controllers.route.prefix'));
    const middlewares = await resolveRouteMiddlewares(this.Descriptor, route, this._container);
    const policies = await resolveRoutePolicies(this.Descriptor, route, this._container, this._cfg, this._log, this.constructor.name, path);
    const enabled = middlewares.filter((m) => m.isEnabled(route, this));
    const handlers = [
      createPolicyGate(policies, route, this, this._log),
      ...enabled.map((m) => wrapMiddlewareAction(m, m.onBefore.bind(m), route, this)),
      createActionHandler(this, route, enabled, this._actionLocalStorage),
      ...enabled.map((m) => wrapMiddlewareAction(m, m.onAfter.bind(m), route, this)),
      __handle_response__(),
      __handle_error__(),
    ];
    (this._router as any)[route.InternalType as string](path, handlers);
  }
}
```

Note unknown-type check moved BEFORE wiring and THROWS (old code `return`ed mid-loop, silently dropping all remaining routes).

- [ ] **Step 1: Move class**, update imports (drop duplicate `Request` import — keep `Request as sRequest` only where used by route-builder).
- [ ] **Step 2: `controllers.ts`** imports `BaseController` from `./base-controller.js`; keep `export { BaseController }` OUT of controllers.ts (barrel handles it, Task 6).
- [ ] **Step 3: Add barrel export now** in `index.ts`: `export * from './base-controller.js';` and `export * from './route-builder.js';` (tests import from `../src/index.js`).
- [ ] **Step 4: Run** `npx ts-mocha -p tsconfig.json test/controllers.test.ts` — PASS (suite covers real route registration end-to-end).
- [ ] **Step 5: Commit** — `refactor(http): move BaseController to base-controller.ts`

### Task 4: `controller-sources.ts`

**Files:**
- Create: `packages/http/src/controller-sources.ts`
- Test: `packages/http/test/controller-sources.test.ts`

**Interfaces (Produces, consumed by Task 5):**

```ts
export abstract class ControllerSource {
  public abstract getControllers(): Promise<Array<ClassInfo<BaseController>>>;
}

@Injectable(ControllerSource)
export class FilesystemControllerSource extends ControllerSource {
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')
  public Controllers!: Promise<Array<ClassInfo<BaseController>>>;
  public async getControllers() { return (await this.Controllers) ?? []; }
}

@Injectable(ControllerSource)
export class DiRegistryControllerSource extends ControllerSource {
  // Types registered `as(BaseController)` before Controllers.resolve()
  // (e.g. by a package Bootstrapper). File comes from Descriptor.SourceFile
  // captured at decoration time, sentinel '<di>' otherwise.
  public async getControllers() {
    return DI.getRegisteredTypes(BaseController).map((type) => {
      const ci = new ClassInfo<BaseController>();
      ci.name = type.name;
      ci.type = type as Class<BaseController>;
      ci.file = (Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, type.prototype) as IControllerDescriptor)?.SourceFile ?? '<di>';
      return ci;
    });
  }
}
```

- [ ] **Step 1: Failing tests** — `DiRegistryControllerSource` returns entry for a type registered `as(BaseController)` in a fresh child scenario (register, call, expect name/type/file; unregister + uncache in afterEach exactly like `controller-inheritance.test.ts` teardown). `FilesystemControllerSource.getControllers()` returns `[]`-safe result.
- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement**, export from `index.ts`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(http): injectable ControllerSource services (filesystem, DI registry)`

### Task 5: Rework `Controllers` orchestrator + fail-fast

**Files:**
- Modify: `packages/http/src/controllers.ts`
- Modify: `packages/http/test/controller-inheritance.test.ts` (test harness only)
- Test: fail-fast cases in `packages/http/test/controllers-failfast.test.ts`

**Interfaces:**
- Consumes: `ControllerSource` (Task 4), exceptions (Task 1).
- Produces: `Controllers` with:
  - `public get Controllers(): Promise<Array<ClassInfo<BaseController>>>` — merged, deduped source list (compat for http-swagger; getter replaces old `@ListFromFiles` field, resolves sources lazily and caches).
  - `protected async getSources(): Promise<ControllerSource[]>` — `DI.resolve(Array.ofType(ControllerSource))`; override point for tests.
  - `register(ci)`, `add(type)`, `resolve()` as today, with throws.

Key changes in `resolve()`:
1. Replace `const listed = await this.Controllers;` (old scanned field) with merge of `getSources()` results; dedupe rule: entries with a real on-disk `file` win over `<di>`/`<dynamic>` sentinels for the same `type`; then `uniqueBy(name)` as today.
2. Rest of flow (register as BaseController, `Array.ofType(BaseController)` single pass, override/shadow report, per-instance `register()`, single mount) unchanged.

`register()` fail-fast (was warn/error + skip):

```ts
if (!controller.instance) {
  throw new ControllerRegistrationException(`Controller ${controller.name} in file ${controller.file} is not resolved. ...`);
}
// inside descriptor branch:
if (!parameters[name as string]) {
  throw new RouteRegistrationException(`Controller ${controller.name} does not have member ${String(name)} for route ${route.Path}`);
}
if (!controller.instance.Router) {
  throw new ControllerRegistrationException(`Controller ${controller.name} in file ${controller.file} has no router instance. Check if it extends BaseController and super.resolve() is called`);
}
```

`add()` rollback:

```ts
DI.register(type as any).as(BaseController);
try {
  const instance = (await DI.resolve(type)) as BaseController;
  ...
  await this.register(ci);
} catch (err) {
  DI.unregister(type);
  DI.uncache(BaseController);
  throw err;
}
```

Test-harness update in `controller-inheritance.test.ts`: delete the `Object.defineProperty(TestControllers.prototype, 'Controllers', ...)` shadow; instead override

```ts
protected async getSources() {
  return [{ getControllers: async () => this.Scanned }] as any;
}
```

- [ ] **Step 1: Failing fail-fast tests** (`controllers-failfast.test.ts`): register() throws on missing instance / missing Router / missing member (drive `register()` directly with hand-built ClassInfo + recording log, same pattern as inheritance suite); `add()` rollback: failing controller type not left registered as BaseController.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** changes.
- [ ] **Step 4: Run** new suite + `test/controller-inheritance.test.ts` + `test/controllers.test.ts` + `test/conditional-controller.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(http): controller sources in loader, fail-fast registration`

### Task 6: Barrel, build, full suite, cross-package check

**Files:**
- Modify: `packages/http/src/index.ts` (ensure exports: base-controller, route-builder, controller-sources; controllers.js stays)
- Verify: `packages/http-swagger` compiles.

- [ ] **Step 1: Full http suite** — `npx ts-mocha -p tsconfig.json "test/**/*.test.ts"` — PASS.
- [ ] **Step 2: Build** — `npm run compile` in `packages/http` — clean.
- [ ] **Step 3: Compile http-swagger** against rebuilt lib (`npm run compile` in `packages/http-swagger`) — clean (memory: cross-package tests/compile use compiled lib, rebuild dependency first).
- [ ] **Step 4: Commit** — `refactor(http): finalize controllers split exports`

## Self-Review Notes

- Spec coverage: file split (T2-T4), sources (T4-T5), fail-fast table (T1, T3, T5), compat getter (T5), bugs (T3: return→throw, typo, dup import; T5: add() rollback), tests (each task + T6).
- Type consistency: `getControllers(): Promise<Array<ClassInfo<BaseController>>>` used in T4 and T5; exceptions names consistent T1/T2/T3/T5.
