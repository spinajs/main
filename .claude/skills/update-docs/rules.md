# What to document

Docs describe what a package user can see and rely on, in its current state.

## Document

- Public exports reachable from `packages/<pkg>/src/index.ts`: classes, functions, decorators, types, constants. New, removed, renamed, changed signature.
- Configuration: keys, defaults, validation rules.
- DI surface a user touches: services they resolve or override, named services, injection targets, registration order that matters.
- Observable behavior: errors thrown and their types, return values, ordering, atomicity, concurrency guarantees, security properties.
- HTTP surface: routes, status codes, request and response shapes.
- Removed public API: delete its docs.
- Breaking change: a "Migration" note with before and after code.

## Skip

- Private and protected members, internal helpers, file moves.
- Refactors and performance work with no caller-visible effect.
- Test, build and tooling changes.
- History: write the current behavior, with no "previously" or "now" phrasing.
