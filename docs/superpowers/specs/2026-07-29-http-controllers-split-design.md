# HTTP Controllers Split & Hardening — Design

Date: 2026-07-29
Package: `packages/http`
Branch: `http-refactor`

## Goal

`packages/http/src/controllers.ts` currently holds two services with tangled
responsibilities: `BaseController` (per-controller route/policy/middleware
wiring) and `Controllers` (app-wide discovery, registration and Express
mounting). Split them into focused files, extract controller discovery into
injectable source services, and replace silent warn-and-skip failure handling
with fail-fast typed exceptions.

## Decisions (user-approved)

1. **Error policy: fail-fast.** Real registration errors throw typed
   exceptions during startup. Warnings remain only for legitimate cases
   (abstract base controller without a descriptor).
2. **Discovery: abstract `ControllerSource` resolved as a DI collection.**
   Filesystem scan and DI-registry are two built-in implementations; future
   sources are new `@Injectable(ControllerSource)` classes.

## File layout (all in `packages/http/src/`)

| File | Content |
|---|---|
| `base-controller.ts` | `BaseController` class only. |
| `route-builder.ts` | Extracted route wiring helpers: route path computation (incl. global prefix), policy resolution + policy gate request handler, middleware resolution + before/after wrappers, route argument extraction. Exported functions with explicit inputs (container, config, log, descriptor data) so they are unit-testable without a controller instance. |
| `controller-sources.ts` | `abstract class ControllerSource` with `getControllers(): Promise<ClassInfo<BaseController>[]>`; `FilesystemControllerSource` (wraps `@ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')`); `DiRegistryControllerSource` (types registered as `BaseController` in DI before `Controllers.resolve()`, e.g. by bootstrappers). |
| `controllers.ts` | `Controllers` orchestrator only: resolves `Array.ofType(ControllerSource)`, merges and dedupes `ClassInfo` lists, registers types as `BaseController`, single `Array.ofType(BaseController)` resolve pass, override/shadow reporting, `register()`, dynamic `add()`, mounts shared `ControllersRouter`. |
| `exceptions.ts` | Extended with typed exceptions (below). |

`index.ts` re-exports the new files. `cache.ts` type import updated to
`./base-controller.js`. Public API through the `@spinajs/http` barrel is
unchanged.

## Source flow

Sources only *supply* `ClassInfo<BaseController>` entries (type + file, no
instance). `Controllers.resolve()`:

1. `await DI.resolve(Array.ofType(ControllerSource))` → gather all lists.
2. Dedupe by class identity (fall back to name for file entries without type).
3. Register each type `as(BaseController)` (idempotent in DI).
4. Resolve `Array.ofType(BaseController)` once — preserves current
   class-identity dedupe and singleton semantics.
5. Keep existing override/shadow detection (subclass overrides scanned base →
   info; unregistered shadow → warn).
6. `register()` each instance, mount shared router once.

`DiRegistryControllerSource` reports types already registered as
`BaseController` at the time it runs, so bootstrapper-registered controllers
keep working with no behavior change.

## Fail-fast error handling

New exceptions in `exceptions.ts` (all extend `@spinajs/exceptions`
`Exception`):

- `ControllerRegistrationException` — controller-level failures.
- `RouteRegistrationException` — route-level failures.

Throw (previously warn/error + skip):

| Condition | Was | Now |
|---|---|---|
| Controller instance not resolved in `register()` | warn + skip | throw `ControllerRegistrationException` |
| Cached parameter map missing route member | `Log.error` + register with broken arg binding | throw `RouteRegistrationException` |
| `route.InternalType === 'unknown'` | warn + `return` (bug: aborts ALL remaining routes) | throw `RouteRegistrationException` |
| String policy name not resolvable via config | warn + silently drop policy (security hole) | throw `RouteRegistrationException` |
| `controller.instance.Router` missing after resolve | warn + skip | throw `ControllerRegistrationException` |
| File-scanned entry without `type` | warn + skip | keep warn (reflection edge case, cannot throw meaningfully) |
| No descriptor on controller | warn + skip | keep warn (legit abstract base) |

`add()` failure cleanup: if instance resolve or `register()` throws after
`DI.register(type).as(BaseController)`, the registration is rolled back
(uncheck from DI / RegisteredTypes stays clean) so a retry is possible and the
broken type is not silently mounted by later resolves.

Runtime (per-request) error propagation is already correct (policy gate
`allSettled` + `next(err)`, action wrapper try/catch) and is preserved verbatim
by the extraction; audit confirms `onResponse` middleware calls sit inside the
guarded paths in both sync and async branches.

## Known bugs fixed along the way

- `return` instead of `continue`/throw on unknown route type (kills remaining
  routes of the controller).
- `acionWrapper` typo → `actionWrapper`.
- Duplicate `Request` import (`sRequest` + `Request` from interfaces).
- Dead `self` aliases after extraction to standalone functions.

## Testing

- Existing suites in `packages/http/test` must pass; any test asserting
  lenient warn+skip behavior is updated to expect throws.
- New tests: `ControllerSource` collection resolution (fs + DI registry +
  custom source), fail-fast throws for each condition above, `add()` rollback.
- Cross-package: packages depending on `@spinajs/http` compile against the
  unchanged barrel; `packages/http` must be rebuilt before dependent package
  tests run (compiled `lib` is what they consume).

## Out of scope

- No changes to route-args, response handling, middleware implementations.
- No changes to `DefaultControllerCache` beyond the type-import path.
- No config flag for lenient mode (fail-fast is unconditional).
