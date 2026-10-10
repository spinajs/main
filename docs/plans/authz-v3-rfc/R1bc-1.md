# R1bc-1: drop a stale sentence from the `Authenticated` doc comment

Status: approved by the controller; applied by R1f (2026-10-09)
Owners of the change: the frozen file `packages/authn-http/src/api.ts` (and
the api snapshot `packages/authn-http/etc/authn-http.api.md`) and
`packages/authn-http/src/policies/v3/principal.ts`; plan §6 R1 gives both
doc comments to R1 final, which applies the change.
Applied by R1f: both `Authenticated` comments and the snapshot line; the `Access` comment in `packages/authz-http/src/access/decorators.ts` was also reworded (not in a snapshot).

## Problem

The doc comment of `Authenticated` in `packages/authn-http/src/api.ts:23`
ends "Replaces LoggedPolicy and AuthorizedPolicy." The lane file
`packages/authn-http/src/policies/v3/principal.ts:21` carries the same
sentence.

Plan §6 R1 has a grep gate: `\bLoggedPolicy\b|\bAuthorizedPolicy\b` over
`packages/*/src` must come back empty, doc comments included. R1bc deleted
`LoggedPolicy`. `AuthorizedPolicy` goes in R1d. These two lines keep both
names in the gate's output after R1d, and `api.ts` is frozen, so no lane can
fix it without this RFC.

## Change

Drop the sentence from both files. The comment then reads:

```ts
/** Passes when an authn principal exists; a pending (pre-MFA) session yields none and fails (D25, SR-07). */
```

Regenerate the snapshot with `node scripts/api-snapshot.mjs --update`. Only
the doc line of `Authenticated` changes in
`packages/authn-http/etc/authn-http.api.md`; no signature changes.

## Affected lanes

- authn-http: `api.ts`, `policies/v3/principal.ts` and the
  `authn-http.api.md` snapshot.
- R1 final: the grep gate passes for these two lines.
- X1: the migration guide names the 2.x policies and what replaces them; the
  doc comment does not need to.

## Snapshot impact

`packages/authn-http/etc/authn-http.api.md`: one doc comment line. No export
or signature changes.
