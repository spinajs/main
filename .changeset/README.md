# Changesets

Every PR that changes `packages/*/src` adds a changeset: run `npx changeset`, pick the bump
type (all `@spinajs/*` packages are versioned in lockstep) and commit the generated file.

The weekly release workflow collects pending changesets into a "version packages" PR.
