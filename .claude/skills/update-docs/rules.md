# What to document

Docs describe what a package user can see, configure, extend and rely on, in its current state.

## Document

- Public exports reachable from `packages/<pkg>/src/index.ts`: classes, functions, decorators, types, constants.
- Execution flow of each feature: entry point, every step with the class or method that runs it, the result, the errors on the way.
- Decorators: target (class, method, property, parameter), options, effect, order with other decorators.
- Configuration: every key, its type, default, allowed values and effect.
- Schema: tables, columns, indexes and models the feature reads or writes; migrations it ships.
- Extensibility, for every class a user can replace or extend: see [Extensibility](#extensibility).
- Events, hooks and middleware a user subscribes to or plugs in.
- HTTP surface: routes, status codes, request and response shapes.
- Important behaviour: ordering, atomicity, caching, concurrency, security guarantees, failure modes, surprising defaults.
- Best practices, tips, patterns to follow, and antipatterns seen in this monorepo, each tied to the feature's real API.
- Relations: packages, features and services this one depends on or feeds, and why.
- Removed public API: delete its docs.
- Breaking change: a "Migration" note with before and after code.

## Extensibility

Find every extension point in the package: classes decorated `@Injectable`, `@Singleton`, `@NewInstance` or `@PerChildInstance`; `DI.register(...)` calls in the package (often in a bootstrapper or `resolve()`); abstract classes; factories and factory functions; named services resolved by config; interfaces with more than one implementation; `declare module` augmentations other packages make.

For each one, document:

- How it is registered: the DI token, lifetime (singleton, new instance, per child), and where the registration happens.
- How it is resolved: by type, by name from config, as a list (`Array.ofType`), lazily or at boot.
- The default implementation and the shipped alternatives.
- How to replace it: `DI.register(MyImpl).as(Base)`, a named registration, a config key, or a subclass. Say when the replacement must be registered (before or after which bootstrap step).
- How to extend it instead of replacing it: which methods are meant to be overridden, which hooks exist.
- A complete example of a custom implementation, registered and used.

## Skip

- Private and protected members, internal helpers, file moves.
- Refactors and performance work with no caller-visible effect.
- Test, build and tooling changes.
- History: write the current behavior, with no "previously" or "now" phrasing.
- Generic advice that holds for any library ("write tests", "handle errors"); a tip earns its place by naming this package's API.
