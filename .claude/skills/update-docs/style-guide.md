# Style guide

Reference pages: `docs/authn/README.md` (one long page) and `docs/orm-http/README.md` (multi-page home). Match them.

## Voice

- English, present tense, active voice; second person for instructions ("register the strategy").
- Open each page and section with what it does for the reader in one or two sentences, then the detail.
- State limits plainly: "It does **not** generate controllers."

## Structure

- Package README H1: `` # `@spinajs/<pkg>` documentation ``. Topic pages get a plain title.
- A multi-page home lists its pages in a table (`| | Page | Covers |`) and numbers them: `01-overview.md`, `02-<topic>.md`.
- A long single page has a `## Contents` list of anchor links under the intro.
- Link with relative paths (`../authz/README.md#anchor`). Point to another package's docs instead of restating them.

## Code

- ` ```ts sample `: a complete sample carrying its own imports; `npm run docs:check` type-checks these.
- ` ```ts `: a partial snippet.
- Imports come from the package entry (`@spinajs/<pkg>`), as a user writes them.
- Inline code for every identifier, config key, path and command.
- Option lists as tables: `| Option | Type | Default | Description |`.
