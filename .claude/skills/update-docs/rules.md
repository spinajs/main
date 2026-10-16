# What to document

Docs describe what a package user can see, configure, extend and rely on, in its current state.

## Document

- Public exports reachable from `packages/<pkg>/src/index.ts`: classes, functions, decorators, types, constants.
- Execution flow of each feature: entry point, every step with the class or method that runs it, the result, the errors on the way.
- Decorators: target (class, method, property, parameter), options, effect, order with other decorators.
- Configuration: every key, its type, default, allowed values and effect.
- Schema: tables, columns, indexes and models the feature reads or writes; migrations it ships.
- DI surface: injectable services, default implementations, named services, classes a user overrides or extends, and how to register the replacement.
- Events, hooks and middleware a user subscribes to or plugs in.
- HTTP surface: routes, status codes, request and response shapes.
- Important behaviour: ordering, atomicity, caching, concurrency, security guarantees, failure modes, surprising defaults.
- Best practices, tips, patterns to follow, and antipatterns seen in this monorepo, each tied to the feature's real API.
- Relations: packages, features and services this one depends on or feeds, and why.
- Removed public API: delete its docs.
- Breaking change: a "Migration" note with before and after code.

## Skip

- Private and protected members, internal helpers, file moves.
- Refactors and performance work with no caller-visible effect.
- Test, build and tooling changes.
- History: write the current behavior, with no "previously" or "now" phrasing.
- Generic advice that holds for any library ("write tests", "handle errors"); a tip earns its place by naming this package's API.
