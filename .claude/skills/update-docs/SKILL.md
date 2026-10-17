---
name: update-docs
description: Write or sync package documentation in docs/<package>/. Use when given a commit SHA or range to document, when asked to update docs after code changes, or to document a whole package.
argument-hint: <commit-sha> | <base>..<head> | package <name>
---

# Update docs: $ARGUMENTS

The run is unattended: decide from the code, leave every change uncommitted, and write only inside `docs/<package>/` folders, plus the link fixes of step 3.

## 1. Read the source

**Commit mode** (the argument is a SHA or a range `<base>..<head>`):

- A SHA: `git show --stat <sha>`, then `git show <sha> -- ':(glob)packages/*/src/**' ':(glob)packages/*/etc/**'`.
- A range: `git log --format='%h %s%n%b' <range>` for intent, `git diff --stat <range>`, then `git diff <range> -- ':(glob)packages/*/src/**' ':(glob)packages/*/etc/**'`. Document the end state of the range, not each commit.
- A changed `packages/<pkg>/etc/<pkg>.api.md` is the exact public API delta of that package; start from it.
- Commit messages give intent. `!` after the type or a `BREAKING CHANGE:` footer marks a breaking change.
- Scope is the features these changes touch. Pages of untouched features stay as they are, even when missing or stale. A package with no docs yet gets a README listing only the touched features; the full package waits for a `package <pkg>` run.

Done when every changed source file is mapped to its package and feature, and classified as document or skip by [rules.md](rules.md).

**Package mode** (the argument is `package <pkg>`):

- Start from the exports of `packages/<pkg>/src/index.ts`, then read every source file they reach, the package tests, and `packages/<pkg>/etc/<pkg>.api.md` when present.
- Search the other packages for how they extend this one: `declare module '@spinajs/<pkg>'`, assignments to `<Class>.prototype`, subclasses of its classes, `DI.register(...).as(<its class>)`. Each is an extension point to document.
- Group the public surface into features: the capabilities a user turns on, configures or extends. Every extension mechanism (scopes, prototype extensions, middleware, overridable services) gets its own feature page, not a subsection of another page.

Done when every public export is assigned to a feature, or classified as skip by [rules.md](rules.md).

## 2. Find the pages

Every package has its own docs in `docs/<pkg>/`, the folder named exactly like the package directory:

- `docs/<pkg>/README.md`: the package index, per [templates/package-readme.md](templates/package-readme.md).
- `docs/<pkg>/NN-<feature>.md`: one page per feature, per [templates/feature.md](templates/feature.md).

A feature is a capability a user turns on, configures or extends: a login strategy, a store, a middleware, a query API, a decorator set. Map each change to the feature page that owns it. A missing README or feature page gets created from its template. Every other folder under `docs/` is outside this skill.

## 3. Write

- Read the whole target page first, then the feature's source: entry point, decorators, services it resolves, config schema, models, tests (they show intended use and edge cases).
- Fill every template section that applies; drop a section only when the feature has nothing for it.
- Keep the README features table in sync: every feature page listed, each with a one-line description.
- Write per [style-guide.md](style-guide.md).
- Every statement traces to the diff or to current source. When the source cannot settle a behavior, write `<!-- TODO(docs-hook): verify <what> -->` in place of the claim.

A package page that predates this layout (one long page): move the touched feature into its own page, link it from the README, and leave the rest of the old page as it is.

A renamed or removed page breaks links into it: update every link to it in `docs/` and in `packages/*/README.md`, anchors included.

Done when every "document" item from step 1 is covered, each touched feature page has its flow, config, services, behaviour and examples sections current, and every name, signature, config key, default and import path matches current source.

## 4. Report

End with one line per touched file, `<path>: <what changed>`, or `no doc changes: <reason>`.
