---
name: update-docs
description: Sync package documentation in docs/<package>/ with a commit's source changes. Use when given a commit SHA to document, or asked to update docs after code changes.
argument-hint: <commit-sha>
---

# Update docs for commit $ARGUMENTS

The run is unattended: decide from the code, leave every change uncommitted, and write only inside `docs/<package>/` folders.

## 1. Read the change

- `git show --stat $ARGUMENTS`, then `git show $ARGUMENTS -- 'packages/*/src/' 'packages/*/etc/'`.
- A changed `packages/<pkg>/etc/<pkg>.api.md` is the exact public API delta of that package; start from it.
- The commit message gives intent. `!` after the type or a `BREAKING CHANGE:` footer marks a breaking change.

Done when every changed source file is mapped to its package and feature, and classified as document or skip by [rules.md](rules.md).

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

Done when every "document" item from step 1 is covered, each touched feature page has its flow, config, services, behaviour and examples sections current, and every name, signature, config key, default and import path matches current source.

## 4. Report

End with one line per touched file, `<path>: <what changed>`, or `no doc changes: <reason>`.
