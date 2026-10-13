# RFC AT-1: `MfaStep.storesSecrets` replaces `SecretStoringMfaStep`

Status: APPLIED on `authz/authn-todo-cleanup` (authn review TODO cleanup, plan
`docs/superpowers/plans/2026-10-12-authn-todo-cleanup.md`, Task 3).

Affected: `MfaStep` in `packages/authn/src/contracts/mfa.ts` (frozen; snapshot `packages/authn/etc/authn.api.md`).

## Problem

A review TODO in authn asked to move `storesSecrets` onto `MfaStep`. It lived on a side interface,
`SecretStoringMfaStep` (`readonly storesSecrets: true`), outside the contract, and the boot secret check
duck-typed every step through `isSecretStoringMfaStep` to learn whether it keeps secrets.

## Change

- `MfaStep` gains `readonly storesSecrets: boolean`, initialised to `false` in the abstract class, with a doc
  comment: true when the step keeps secrets; boot then requires `authn.mfa.encryptionKey.secret` outside
  development and test (A24).
- `SecretStoringMfaStep` and `isSecretStoringMfaStep` are removed from `@spinajs/authn`. The boot check reads
  `storesSecrets` (truthy), which can only widen the fail-closed secret check.
- `TotpMfaStep` (authn-totp) keeps `storesSecrets = true`.

## Breaking impact

- Existing steps that extend `MfaStep` compile and behave as before: they inherit `false`.
- A step that implemented `SecretStoringMfaStep` already sets `storesSecrets = true` and keeps working.
  Code that imports the interface or the guard no longer compiles; in the repo only authn's boot check did.
