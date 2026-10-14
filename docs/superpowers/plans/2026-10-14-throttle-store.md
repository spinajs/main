# Generic Throttle + Stores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Move the whole throttle into `@spinajs/util` as `Throttle` + `ThrottleStore`; rebuild `MemoryAuthnThrottle` and `DbAuthnThrottle` as small subclasses of an authn `StoreAuthnThrottle`.

**Spec (source of truth):** `docs/superpowers/specs/2026-10-14-throttle-store-design.md` (builds on `2026-10-14-memory-throttle-refactor-design.md`).

## Global Constraints

- Branch `authz/memory-throttle` (continue on it).
- English code/comments/docs; comments only for non-obvious why.
- `AuthnThrottle`/`PeekableThrottle` contracts, all callers, config keys and DB rows unchanged. Behaviour of both throttles identical: every existing behavioural test passes; authn mutation suite kills every mutant; authn-orm throttle suites pass on sqlite.
- authn contracts boundary unchanged (contracts import only `@spinajs/di`).
- Tests: `npm run pretest` once per package, then `npx mocha`; typecheck `npx tsc -p tsconfig.json --noEmit`. util: build both mjs and cjs (`npm run build` + `npm run compile:cjs` if separate) before dependants run.
- Not ours, never stage/edit: `packages/authz-rbac/test/stores/db-link-store.test.ts`, `packages/telemetry/test/cache/*` deletions, `docs/auth-feat/`.

---

### Task 1: util `Throttle`, `ThrottleStore`, `MemoryThrottleStore`

**Files:** Create `packages/util/src/resilience/throttle.ts`, `packages/util/src/resilience/memory-throttle-store.ts`; export from resilience index. Tests `packages/util/test/throttle.test.ts`, `packages/util/test/memory-throttle-store.test.ts`.

**Interfaces:** spec §1 and §2 exactly.

- [ ] Tests first per spec §5 util bullets (RED), then implement, GREEN; util full suite green; build mjs+cjs.
- [ ] Commit `feat(util): add Throttle with pluggable ThrottleStore and MemoryThrottleStore`.

### Task 2: authn `StoreAuthnThrottle`; `MemoryAuthnThrottle` on it

**Files:** Create `packages/authn/src/throttle/store-throttle.ts`; modify `memory-throttle.ts` (shrinks to config + store + keyId + seams), `flow-limiter.ts` (unchanged API), `throttle/index.ts`; export `StoreAuthnThrottle` so authn-orm can import it (check `packages/authn/package.json` exports; add a `./throttle` subpath only if the root entry is unsuitable, and keep the contracts boundary). Tests: authn throttle tests + mutants adapted, new test for `rules()` table.

- [ ] Test the flow-rule table (spec §3) first; adapt seams; authn suite incl. mutation suite green; authn-testing, authn-local, authn-totp, authn-keys suites green.
- [ ] Commit `refactor(authn): StoreAuthnThrottle on util Throttle; MemoryAuthnThrottle as a store subclass`.

### Task 3: authn-orm `DbThrottleStore`; `DbAuthnThrottle` on `StoreAuthnThrottle`

**Files:** Create `packages/authn-orm/src/throttle/db-throttle-store.ts`; modify `db-throttle.ts`, `throttle/index.ts`; tests `packages/authn-orm/test/{db-throttle,throttle-config,throttle-conformance,throttle-dialects}.test.ts` (adapt only seams that read internals).

- [ ] Move the DB row logic into the store unchanged (CAS + undo, dialects, times, purge helpers); `DbAuthnThrottle` keeps `init`, `purge`, `checkConfiguration`, `rowKey` (its keyId), options and public surface; `attempt/peek/succeed` from the base. Keep the existing succeed order semantics (consume account-ip → lower ip by largest → clear account). authn-orm throttle suites green on sqlite; note skipped Postgres cases.
- [ ] Commit `refactor(authn-orm): DbAuthnThrottle on StoreAuthnThrottle with DbThrottleStore`.

### Task 4: Docs, release notes, snapshot

- [ ] util `documentation/resilience.md`: `Throttle`/`ThrottleStore` + "writing a store" (atomic attempt, lower/clear semantics, Redis sketch in prose); authn throttle README trimmed to authn-specific parts (spec §6); authn-orm README throttle section if any; RELEASE_NOTES; `node scripts/api-snapshot.mjs --check` (+ `--update` if API snapshots changed, `--check-rfc f616796fc`).
- [ ] Commit `docs: generic throttle and stores`.
