# Memory Throttle Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build `MemoryAuthnThrottle` on a generic `KeyedBackoff` limiter in `@spinajs/util`, with one DI-resolved `FlowLimiter` per flow, configurable constants, and a throttle README.

**Spec (source of truth for interfaces and behaviour):** `docs/superpowers/specs/2026-10-14-memory-throttle-refactor-design.md`

**Tech Stack:** TypeScript ESM, mocha + ts-node/esm, chai/assert, `@spinajs/di`, `@spinajs/configuration`.

## Global Constraints

- Branch `feat/authz-v3` (work on a feature branch `authz/memory-throttle` created from it).
- English code, comments and docs. Comments only where code cannot say why.
- `AuthnThrottle` contract, `DbAuthnThrottle` and every caller stay unchanged.
- Behaviour of `MemoryAuthnThrottle` must be identical: every existing behavioural test passes; the mutation suite still kills every mutant.
- Tests: in a package run `npm run pretest` once, then `npx mocha` (authn's mocharc runs the whole suite). Typecheck `npx tsc -p tsconfig.json --noEmit`. Rebuild util lib (`npm run build` or its compile scripts) before authn uses it.
- Not ours, never stage/edit: `packages/authz-rbac/test/stores/db-link-store.test.ts`, `packages/telemetry/test/cache/*` deletions, `docs/auth-feat/`.

---

### Task 1: `KeyedBackoff` in `@spinajs/util`

**Files:**
- Create: `packages/util/src/resilience/keyed-backoff.ts`; export from `packages/util/src/resilience/index.ts`
- Test: `packages/util/test/keyed-backoff.test.ts`
- Modify: `packages/authn/src/contracts/throttle.ts` — `BackoffParams` and `backoffDelayMs` become re-exports of the util ones (keep names and shape)

**Interfaces (produced):** exactly spec §1 (`BackoffParams`, `backoffDelayMs`, `KeyedBackoffGate`, `KeyedBackoffVerdict`, `KeyedBackoffRow`, `KeyedBackoffOptions`, `KeyedBackoff` with `attempt`, `peek`, `sweep`, `row`, `delete`, `release`, `size`, `entries`).

- [ ] Step 1: Write `keyed-backoff.test.ts` covering every bullet of spec §5 "util" (port the expectations from `packages/authn/test/throttle/memory-throttle.test.ts` capacity/eviction/decay cases to the generic API: same numbers). Run `npx mocha` in packages/util → FAIL (module missing).
- [ ] Step 2: Implement by porting the generic parts of `packages/authn/src/throttle/memory-throttle.ts` (`stale`, `live`, `count`, `sweepSome`, `makeRoom`, `evict`, `waitMs`, `refused`) into the class. Keep the existing comments that explain non-obvious rules (Map iterator survives deletes; idle does not cut a running delay; slack target; hold-off).
- [ ] Step 3: Re-export from authn contracts; `npm run build` in util; `npx tsc --noEmit` in authn and authn-orm.
- [ ] Step 4: `npx mocha` in util → PASS; authn suite still PASS (unchanged behaviour so far).
- [ ] Step 5: Commit `feat(util): add KeyedBackoff, a per-key backoff limiter`.

### Task 2: `FlowLimiter` per flow and `MemoryAuthnThrottle` on top

**Files:**
- Create: `packages/authn/src/throttle/flow-limiter.ts`; export from `packages/authn/src/throttle/index.ts`
- Modify: `packages/authn/src/throttle/memory-throttle.ts` (drop `ThrottleRow`, `ThrottleTable`, `tables`, `sweepBatch`, the three constants and all four TODOs; add `limiter(flow)`)
- Modify: `packages/authn/src/throttle/params.ts` (`ThrottleConfig.memory?`), `packages/authn/src/schemas/authn.configuration.ts` (spec §3), `packages/authn/src/config/authn.ts`
- Test: `packages/authn/test/throttle/memory-throttle.test.ts`, `packages/authn/test/mutation/throttle-mutants.ts`, `packages/authn/test/boot/config-defaults.test.ts`, `packages/authn/test/contracts/config-schema.test.ts`

**Interfaces:** consumes Task 1's `KeyedBackoff`; produces `FlowLimiter` (spec §2) and protected `MemoryAuthnThrottle.limiter(flow): FlowLimiter`, keeping protected `delayMs`, `keyId`, `reportFull`.

- [ ] Step 1: Add tests first: (a) a registered `FlowLimiter` subclass is the one each flow uses; (b) `authn.throttle.memory.{sweepBatch, fullRetrySeconds, holdOffMs}` reach the limiter (e.g. a full table refuses with Retry-After = fullRetrySeconds); (c) schema defaults/floors for `memory.*`. Run → FAIL.
- [ ] Step 2: Refactor `MemoryAuthnThrottle` per spec §2; rewrite `Probe`, `ReadModifyWrite`, `AccountOnly` (memory-throttle.test.ts) and `SuccessClearsIp` (throttle-mutants.ts) on `limiter(flow)` keeping each one's intent; schema + defaults per spec §3.
- [ ] Step 3: `npm run pretest` + `npx mocha` in authn → all PASS, including the mutation suite; run authn-orm throttle tests, authn-testing, authn-local, authn-totp, authn-keys suites (the ones that use `MemoryAuthnThrottle`) → PASS or classify failures against the base commit.
- [ ] Step 4: Commit `refactor(authn): build MemoryAuthnThrottle on per-flow KeyedBackoff limiters`.

### Task 3: Docs, release notes, API snapshot

**Files:**
- Create: `packages/authn/src/throttle/README.md` (spec §4 contents; style of packages/authn-token/README.md; link from packages/authn/README.md "Module guides" and docs/authn/README.md Throttling section)
- Modify: util README (if it documents resilience) or rely on JSDoc; `RELEASE_NOTES.md`; `packages/*/etc/*.api.md` via `node scripts/api-snapshot.mjs --update` then `--check` and `--check-rfc <base>`; add an RFC under `docs/plans/authz-v3-rfc/` only if `--check-rfc` requires it (follow AT-1.md format)

- [ ] Step 1: Write README; verify every claim against the Task 2 code (config keys, defaults, error classes, D8 rule).
- [ ] Step 2: Release notes + snapshot; checks exit 0.
- [ ] Step 3: Commit `docs(authn): throttle README; release notes for KeyedBackoff`.
