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

Done when every changed source file is mapped to its package and classified as document or skip by [rules.md](rules.md).

## 2. Find the doc home

`packages/<pkg>/` is documented in `docs/<pkg>/`, the folder named exactly like the package directory. A package without one gets `docs/<pkg>/README.md` from [templates/package-readme.md](templates/package-readme.md). Every other folder under `docs/` is outside this skill.

## 3. Write

- Read the whole target page first. Edit the section that owns the topic; keep headings, anchors and the Contents list or Pages table in sync.
- A topic too big for a section gets its own numbered page from [templates/page.md](templates/page.md), linked from the folder's `README.md`.
- Write per [style-guide.md](style-guide.md).
- Every statement traces to the diff or to current source. When the source cannot settle a behavior, write `<!-- TODO(docs-hook): verify <what> -->` in place of the claim.

Done when every "document" item from step 1 is covered on a page, and every name, signature, config key, default and import path in the touched sections matches current source.

## 4. Report

End with one line per touched file, `<path>: <what changed>`, or `no doc changes: <reason>`.
