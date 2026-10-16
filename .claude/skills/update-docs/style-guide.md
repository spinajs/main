# Style guide

Plain, direct, scannable. A reader finds the answer in seconds.

## Language

- Simple English, present tense, active voice. Second person for instructions: "register the strategy".
- Sentences up to ~20 words. Paragraphs up to 3 sentences.
- One idea per bullet. Lists and tables over prose.
- Start with the point: what it does, then how.
- Concrete over abstract: name the class, the key, the value.
- State limits plainly: "It does **not** generate controllers."
- Words with zero information go: "simply", "just", "easily", "powerful", "seamless", "in order to".

## Structure

- Package README H1: `` # `@spinajs/<pkg>` ``. Feature page H1: the feature name.
- Feature pages are numbered in reading order: `01-<feature>.md`, `02-<feature>.md`.
- Execution flows are numbered steps; each step names the class or method that runs it. A flow with several actors also gets a ` ```mermaid ` `sequenceDiagram`.
- Link with relative paths (`../authz/README.md#anchor`). Link another package's docs instead of restating them.

## Tables

- Configuration: `| Key | Type | Default | Allowed values | Meaning |`, full dotted key path (`authn.session.ttl`).
- Decorators: `| Decorator | Target | Options | Effect |`.
- Services: `| Service | Role | Default implementation | How to override |`.
- Schema: one table per DB table, `| Column | Type | Meaning |`.

## Code

- ` ```ts sample `: a complete sample carrying its own imports; `npm run docs:check` type-checks these. Use it for examples.
- ` ```ts `: a partial snippet.
- Imports come from the package entry (`@spinajs/<pkg>`), as a user writes them.
- Examples are real tasks ("lock an account after 5 failed logins"), never `foo`/`bar`.
- Antipatterns come as a pair: a ` ```ts ` block with `// Don't` and the reason, then the `// Do` version.
- Inline code for every identifier, config key, path and command.
