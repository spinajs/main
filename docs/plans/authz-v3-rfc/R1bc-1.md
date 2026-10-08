# R1bc-1: drop a stale sentence from the `Authenticated` doc comment

Status: proposed (R1bc, 2026-10-09)
Owners of the change: the frozen file `packages/authn-http/src/api.ts` (and
the api snapshot `packages/authn-http/etc/authn-http.api.md`), N8b (the lane
file `packages/authn-http/src/policies/v3/principal.ts`), R1 (the grep gate).
Not applied: R1bc may not edit frozen files.

## Problem

The doc comment of `Authenticated` in `packages/authn-http/src/api.ts:23`
ends "Replaces LoggedPolicy and AuthorizedPolicy." The lane file
`packages/authn-http/src/policies/v3/principal.ts:21` carries the same
sentence.

Plan §6 R1 has a grep gate: `LoggedPolicy|AuthorizedPolicy` over
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
