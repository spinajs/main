# WebSocket layer: gated follow-ups G2–G6 (incl. W4 Task 9) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the authz-v3 follow-ups of `@spinajs/http-socket` v3 now that their gates hold: authz-http's input field filter on socket payloads (G3), `@SocketAccess` converged with authz-http's `AccessPolicy` plus output field filtering (G4), trusted proxies and the authn-http policies on sockets (G5), and the session-cookie principal source at `@spinajs/authn-http/socket` (G6, which is also W4 Task 9). G2 is verified as already done.

**Architecture:** The socket layer keeps its W1 seams: `SocketPrincipalSource` over the handshake view (`ISocketHandshake`), the principal guard's tri-state revalidation, `SocketAccessPolicy` in `access.ts`, the arguments stage (`PayloadArg`, which already runs http's `ArgInputFilter`s), the stage order (Ordering 550, Policies 600, Arguments 700), the exports snapshot test and `RELEASE_NOTES.md`. authz-http did not expose `AccessPolicy`'s decision step, so `SocketAccessPolicy` mirrors it on `@spinajs/authz` primitives, and a new `AccessFieldsStage` (Policies + 50) filters results. The handshake address follows authn-http `ClientIp`'s trusted-proxy rule through `@spinajs/http`'s `parseTrustProxy` / `trustedClientAddress`. The session source lives in authn-http under a new `./socket` subpath (owner answer Q1); it restores the cookie's session and resolves it with authn-http's own `SessionPrincipalResolver` through one additive method.

**Tech Stack:** TypeScript 7 (`node node_modules/typescript-7/lib/tsc.js`, ESM `node16`, dual mjs/cjs), socket.io 4.8 / socket.io-client 4.8, `@spinajs/di`, `@spinajs/configuration`, `@spinajs/http`, `@spinajs/authz`, `@spinajs/authn/contracts`, `@spinajs/authn-session`, mocha + chai + sinon through `ts-mocha`.

**Inputs:** `.superpowers/sdd/w1-task-16-brief.md` ("Gated follow-up tasks", "Coordination with authz-v3", owner questions; G1 is done), `.superpowers/sdd/w4-task-9-brief.md` (identical copy in `C:\Users\grzch\SourceCodes\Spinajs\ws-w4\.superpowers\sdd\`), spec `docs/superpowers/specs/2026-10-02-spinajs-websocket-design.md` (§3 and §8 already record the Q1 answer).

---

## Gate status (checked 2026-10-08)

`feat/authz-v3` (38b5837ae, containing bd48425dd) is an ancestor of `feat/websocket-layer` HEAD (merge 7d26118c2). Merged lanes: F4 `dd723b425`, L4 `b10f9b3f5`, L5 `b8e41d053`, N1 `6d7534bcc`, N2 `75f33b140`, N8a `0f6b01d4b`. Owner Q1: the session source goes to `@spinajs/authn-http` as a `/socket` subpath. Every gate holds.

## The briefs against the merged code

| Brief item | Merged reality (verified) | This plan |
|---|---|---|
| **G2** B09 socket part | **Already done** by lane C9: `dcfa5e34a` (B09 socket part on the real engine), `b5f385369` + `bad4af613` (sources may not yield SYSTEM/UNATTENDED). `packages/http-socket/test/authz/behaviour.test.ts` runs `B09.socket` (the kit case "a socket handler without a principal source fails closed on a scoped model") plus own parts `socket-system`, `socket-user`, `socket-source`, `socket-queue`, in its own mocha process (`.mocharc.authz.json`). `packages/authz-orm/src/middleware.ts` `decide()` (~line 377) throws `AccessDenied` for a denied type-level check, which is what UNATTENDED gets. The kit still tags the part `C9`, which is now accurate, so RFC `W1-1` (retag to W1) is moot. | Task 0 re-runs it and records it. No code. |
| **G3** `ArgInputFilter` | `packages/http/src/arg-input-filter.ts`: `abstract filter(input, parameter, route?)`; its doc says socket handlers call it for the payload without a route. L5 already wired it: `PayloadArg.filter` (`packages/http-socket/src/args.ts:41-56`, commits `468316bd2`, `406e7f3ef`) runs every registered filter on an object payload as a `FromBody` parameter named `payload`, before schema validation and hydration, inside the call's ALS store. The signature needs nothing express-only, so RFC `W1-2` is not needed. | Task 1: prove authz-http's `AuthzInputFieldFilter` works on socket payloads; carry its `fields_not_writable` refusal (and every http "stable code") in `details`. |
| **G3/G4** `AuthzInputFieldFilter` | `packages/authz-http/src/fields.ts:69-99`: reads `authzStorage().getStore()` for `AuthzDecision` and the `AuthzHttpRoute` mark (`{ domain, unfilteredInput? }`), filters `BODY_ARGS` (includes `FromBody`), strips or, in `reject` mode, throws `BadRequest` with own props `{ error: 'fields_not_writable', fields }`. Without mark and decision it does nothing. | Task 1 (decision path), Task 2 (mark + `unfilteredInput`). |
| **G4** `AccessPolicy` | `packages/authz-http/src/access/policy.ts`. The decision step was **not** exposed as a function (coordination request 3 not done): `decide/load/refOf/trace` are protected and the rule is read from the http controller descriptor (`routeAccess`). Differences from `SocketAccessPolicy` (`packages/http-socket/src/access.ts`): extractor returning nothing ⇒ `InvalidArgument` (socket silently fell back to the type-level ref); `subject: 'load'`; only the route's own rule (else the class's) writes `AuthzDecision` (socket: last writer wins); the `AuthzHttpRoute` mark; `fields: 'filter'` (`AuthzFieldsMiddleware`); a non-production trace on 403; `fromModel` refs via `ResourceAdapter.refOf`. Boot: `access/contributor.ts` feeds `@Access` permissions to boot rule 7 (B02). | Tasks 2–3 mirror all of these on `@spinajs/authz` primitives (http-socket must not depend on authz-http), except trace and `fromModel` (open questions). |
| **G4** `SocketAccessPolicy` | http-socket keeps its own `SocketAccessPolicy` in `src/access.ts`. | Modified in place. |
| **G5** trusted proxies | `authn.http.trustProxy`, else `http.trustProxy` when the former is null/absent: `proxyTrustOf` and `ClientIp` in `packages/authn-http/src/middleware/client-ip.ts`. `parseTrustProxy` and `trustedClientAddress` come from `@spinajs/http` (`packages/http/src/middlewares/RealIp.ts`) and need no express request, so RFC `W1-3` is not needed. | Task 4: `handshake.address` follows that rule; `handshake.peerAddress` is the raw peer. |
| **G5** authn-http policies | `packages/authn-http/src/policies/v3/{principal,mfa,fresh-auth,groups}.ts`: `Authenticated`, `NoSession`, `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy`, `FreshAuth`, `MfaSatisfied`, `PendingMfaEnrolment`. They read `req.storage.AuthnPrincipal` (the socket call store has it, D14); `NoSession`, `FreshAuth` and `PendingMfaEnrolment` also read `req.storage.AuthnSession`, which no socket call carries. The package root still exports the **2.x** `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy` until N8c; the 3.0 ones are reachable only through `src/v3/index.ts`, which no `package.json` export names. | Task 6: re-export the five socket-usable 3.0 policies from `@spinajs/authn-http/socket`; run them end to end. |
| **G6 / W4 T9** session source | authn-http's `package.json` exports only `"."`. `SessionPrincipalResolver.resolve(req, credentials, ctx)` (`src/resolvers/session.ts`) takes an express `Request` but reads only `req.storage.AuthnSession`, then goes through `AuthnImpersonationService.principalOf` (impersonation, lifetime, banned identities, SR-06) and `ActiveRole`. Cookie restore lives in the protected `AuthnMiddleware.restoreSession` (`src/middleware/authn.ts:147-163`); the helpers `sessionCookieName`, `appEnvOf`, `assertSessionCookieSecret` come from `@spinajs/authn-session`. The W4 T9 brief built the principal with `PrincipalFactory` directly, which skips impersonation and SR-06, and its test lacked `DI.setESMModuleSupport()`. | Task 5 supersedes W4 T9: source in authn-http `./socket`, resolved through a new additive `SessionPrincipalResolver.principalOfSession`. |

## Decision: where the session source lives (G6)

**In `@spinajs/authn-http`, under a new `./socket` subpath export (owner answer Q1).** authn-http owns the cookie name, the signing secret, the restore rules and `SessionPrincipalResolver`; a socket-side adapter would have to copy all of them, and `@spinajs/http-socket` must not depend on `authn-http` (W1 rule). **This edits authn-http, an authz-v3 lane package (N8a).** The change is minimal and additive:

- new `src/socket/` (two files), not imported by `src/index.ts`, so apps without sockets never load `@spinajs/http-socket`;
- one new public method `SessionPrincipalResolver.principalOfSession(session, ctx)`; `resolve()` delegates to it with unchanged behaviour;
- `package.json`: `exports["./socket"]`, `typesVersions`, an **optional** peer dependency on `@spinajs/http-socket`, dev dependencies; `tsconfig*.json` references;
- tests in a new, separate mocha process (`test/v3-socket/`, `.mocharc.v3-socket.json`).

It adds no `authz*` or `users*` edge to authn-http; `@spinajs/http-socket` depends on `@spinajs/authz`, which the Q1 answer accepted for an optional peer.

## Open questions (owner) — the plan uses the recommended default

- **Q1. Trace on socket denials.** authz-http adds an explain trace to a 403 outside production when the caller holds the explain permission (B23/B41). **Default: no trace on sockets** (`AccessDeniedMapping` stays trace-free; sockets offer no explain).
- **Q2. `fromModel`-style resource extractors.** **Default: not offered.** Socket extractors return refs (`fromPayload`, custom); an unloaded model instance would need `ResourceAdapter.refOf` mapping.
- **Q3. Meaning of `handshake.address`.** **Default: it becomes the trusted client address** (unchanged without a trust setting, SR-03 safe), and the raw peer moves to the new `handshake.peerAddress`. Every current consumer (authn context ip, policy `ip`, call store `realIp`) wants the client address. Alternative: keep `address` raw and add `clientAddress`.
- **Q4. One trust rule for the socket address.** **Default: authn-http `ClientIp`'s rule** (`authn.http.trustProxy`, else `http.trustProxy`), because the address feeds authn's throttle keys and audit; http's `RealIp` uses `http.trustProxy` only, so the two differ only when `authn.http.trustProxy` is set.
- **Q5. Revalidation slides the session.** `SessionIssuer.restore` refreshes an active session, so an open socket revalidating every `revalidateMs` keeps its sliding session alive until the `maxLifetime` cap. **Default: accept** (an open socket is user activity). Alternative: a non-sliding peek on `SessionIssuer` (an authn-session change).
- **Q6. Session-reading policies on sockets.** **Default: unsupported.** `NoSession`, `FreshAuth` and `PendingMfaEnrolment` need `AuthnSession` in the call store; `FreshAuth`/`PendingMfaEnrolment` fail closed, `NoSession` would pass everything, so none is re-exported from `./socket` and the README says not to use them.
- **Q7. Re-export the 3.0 policies before N8c.** **Default: yes**, `Authenticated`, `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy`, `MfaSatisfied` from `@spinajs/authn-http/socket`; after N8c the root exports the same classes.
- **Q8. G5 end-to-end strategy.** The brief asked for authn-token's `TokenStrategy` on SQLite. **Default: authn-testing's `FakeStrategy.bearer` inside the real v3 app** (real `DefaultAuthnService`, real authn-http bearer extractor, real session issuer and resolvers); `TokenStrategy` is pinned by authn-token's own conformance suite.
- **Q9. Session source order.** **Default: 40** (before `AuthnCredentialSource` 50), as W4 plan Q1: an active session wins over bearer credentials, as in http. The G6 brief's "order 100" would let a bearer token win.
- **Q10. Boot checks for `@SocketAccess` permissions (B02).** **Default: yes** (`SocketAccessContributor`, Task 2): an unregistered permission now fails the domain's boot, as `@Access` does. Before, it booted and every check denied.

## Global Constraints

- **Repo / branch.** Worktree `C:\Users\grzch\SourceCodes\Spinajs\websocket-layer`, branch `feat/websocket-layer`. Never touch another Spinajs checkout.
- **Shared worktree.** Other agents work here; one is in `packages/http-socket` now (config schema checks, a flaky e2e test). Stage only the exact paths a step lists (never `git add -A` / `git add .`). Never `git stash`, `git reset`, `git checkout -- …`, `git clean`. Every commit checks the branch in the same command: `test "$(git branch --show-current)" = feat/websocket-layer && git add … && git commit …`.
- **Hands off:** `packages/http-socket/src/schema.ts`, `src/config/**`, `test/durable-e2e.test.ts`, `test/harness.ts` (the other agent's and W1's). Before a task that edits `packages/http-socket/src`, run `git status --short -- packages/http-socket` and do not start while another agent has uncommitted changes in a file the task lists.
- **No installs, no lock file.** Do not run `npm install`; root `node_modules/@spinajs/*` links every workspace package (`authz-http`, `authn-http`, `authn-session`, `authn-testing`, `http-socket`) and `socket.io-client` / `cookie-signature` are hoisted. Never commit `package-lock.json`.
- **Versions.** `@spinajs/http-socket` `2.0.549`; `@spinajs/authn-http`, `@spinajs/authz-http` `3.0.0-alpha.0`. Internal deps are pinned exactly.
- **Package rules.** `@spinajs/http-socket` `src/` imports `@spinajs/authz`, `@spinajs/authn/contracts`, `@spinajs/http` and the other packages it already depends on; never `authn-http` or `authz-http` (a test-only dev dependency on `authz-http` is allowed, Task 1). `@spinajs/authn-http`'s root `src/index.ts` must never import `./socket`. `src/socket/**` imports `Principal` from `@spinajs/authn/contracts`.
- **Release notes.** `packages/http-socket/RELEASE_NOTES.md` only (X1 merges it); never the root notes.
- **Builds.** Packages consume each other through `lib/`. Root commands (from the worktree root):
  - typecheck one config: `node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/<pkg>/tsconfig.json` (also `tsconfig.mjs.json`, `tsconfig.cjs.json`)
  - build one package: `node node_modules/typescript-7/lib/tsc.js -b packages/<pkg>/tsconfig.mjs.json packages/<pkg>/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs`
  - `-b` also rebuilds stale references. Build `http-socket` (or anything referencing it) only when no task is mid-edit in `packages/http-socket/src`.
- **Tests.** From inside the package: `npx ts-mocha -p tsconfig.json <files>`. Never `npm test` in authn-http (its `pretest` cleans and rebuilds `lib/`). DI keys classes by name: every test-only class gets a unique, exported name. Socket controller prefixes used here: `inf`, `acp`, `acf`, `acfc`, `cip` (http-socket), `sess`, `authnsock` (authn-http).
- **Style.** English identifiers and comments; comment only a non-obvious "why". Prettier: `printWidth 1500`, single quotes, trailing commas; ESM imports with `.js`. `noUnusedLocals` / `noUnusedParameters` are on.
- **Commits.** `feat(http-socket): …`, `feat(authn-http): …`, `test(authn-http): …`, `docs(http-socket): …`.

## Task order and parallelism

| Task | Package / files | Depends on | Runs in parallel with |
|---|---|---|---|
| 0 Gates, baselines, G2 close-out | none (builds `authz-http`, `authn-http` libs) | — | — |
| 1 G3 input filters + error details | http-socket: `src/errors.ts`, `package.json`, `tsconfig.json`, `test/scripted-authz.ts`, `test/input-filter.test.ts` | 0 | 4 (own worktree), 5 |
| 2 G4 `@SocketAccess` decision parity | http-socket: `src/access.ts`, `src/access-contributor.ts`, `src/index.ts`, `test/scripted-authz.ts`, `test/access-parity.test.ts`, `test/exports.test.ts` | 1 | 4 (own worktree), 5 |
| 3 G4 `fields: 'filter'` | http-socket: `src/access.ts`, `src/stages/access-fields.ts`, `src/stages/index.ts`, `test/access-fields.test.ts`, `test/exports.test.ts` | 2 | 4 (own worktree), 5 |
| 4 G5 trusted-proxy address | http-socket: `src/client-address.ts`, `src/interfaces.ts`, `src/connection.ts`, `src/server.ts`, `test/client-address.test.ts`, `test/authn-source.test.ts`, `test/revalidation.test.ts` | 0 | 1–3 by files; 5 |
| 5 G6 / W4 T9 session source | authn-http: `src/resolvers/session.ts`, `src/socket/*`, `package.json`, `tsconfig*.json`, `.mocharc*.json`, `test/v3-socket/{support,session.test}.ts` | 0 | 1–4 |
| 6 G5 authn + policies end to end | authn-http: `src/socket/index.ts`, `test/v3-socket/authn.test.ts` | 1, 5 (and 2–4 finished: it rebuilds the http-socket lib) | — |
| 7 Docs, full build, all suites | http-socket: `README.md`, `RELEASE_NOTES.md` | 1–6 | — |

Tasks 1→2→3 share files and run in order. Task 4 touches none of their files, but ts-node type-checks every `src` file a test loads, so a half-done edit in one lane breaks the other's test run: run Task 4 in its own git worktree (then merge) or after Task 3. Task 5 is in another package and can run from the start, alongside everything in http-socket.

---

### Task 0: Gates, baselines and G2 close-out

**Files:** none changed. Builds the stale `lib/` of `authz-http`, `authn-http` and their references (`authn-session`, `users`, `authn-token`, … still hold their 2026-10-02 stubs).

**Interfaces:**
- Consumes: nothing.
- Produces: the baseline counts B1 (http-socket main suite), B2 (http-socket authz suite), B3 (authn-http v3-app suite), B4 (authn-http main suite) that later tasks compare against.

- [ ] **Step 1: Check the gates**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && git merge-base --is-ancestor feat/authz-v3 HEAD && echo ANCESTOR && git log --oneline feat/authz-v3 | grep -E "Merge authz/(F4|L4|L5|N1|N2|N8a)"`
Expected: `ANCESTOR`, then six merge lines (F4-host, L4-orm, L5-http, N1-authn-core, N2-session, N8a-authn-http). Otherwise stop.

- [ ] **Step 2: Check what other agents have in flight**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && git status --short -- packages/http-socket packages/authn-http packages/http && git log --oneline -5 -- packages/http-socket`
Expected: a list (possibly empty). Note every modified file; a task that lists one of them waits until it is committed.

- [ ] **Step 3: Build the libs the tests load**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/authz-http/tsconfig.mjs.json packages/authz-http/tsconfig.cjs.json packages/authn-http/tsconfig.mjs.json packages/authn-http/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs && ls packages/authz-http/lib/mjs/fields.js packages/authn-session/lib/mjs/cookie.js packages/authn-http/lib/mjs/resolvers/session.js`
Expected: exit 0 and the three files listed. Neither project references `http-socket`, so this does not compile the other agent's work. If a referenced package outside this plan fails to compile, stop and report it: the merge left that package broken.

- [ ] **Step 4: Record the baselines**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/*.test.ts 2>&1 | tail -5`
Record "B1 = N passing" and any failing titles (a failing `durable-e2e` case belongs to the other agent).

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json --config .mocharc.authz.json 2>&1 | tail -5`
Record "B2 = N passing", expected 0 failing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json 2>&1 | tail -5`
Record "B3 = N passing", expected 0 failing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json 2>&1 | tail -5`
Record "B4 = N passing" (the authn-http main process), expected 0 failing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.json; node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/authn-http/tsconfig.json`
Record the error count of each (expected 0); later tasks add none.

- [ ] **Step 5: Close G2**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json --config .mocharc.authz.json --grep "fails closed on a scoped model"`
Expected: 1 passing ("a socket handler without a principal source fails closed on a scoped model", part `B09.socket`), 0 failing.

Record in the progress notes: "G2 done by C9 (dcfa5e34a, b5f385369, bad4af613); B09.socket passes on the real engine; RFC W1-1 moot." No commit.

---

### Task 1: G3 — authz-http's input field filter on socket payloads; http error codes in `details`

`PayloadArg` already runs the `ArgInputFilter`s (L5). This task proves the authz filter works with the decision `@SocketAccess` leaves in the call store, and makes its refusal readable: `codeMapping` mappings and `InvalidArgumentMapping` now answer the `error` code and `fields` that http spreads into its body.

**Files:**
- Modify: `packages/http-socket/src/errors.ts:42-56` (`codeMapping`, `InvalidArgumentMapping`)
- Modify: `packages/http-socket/package.json` (dev dependency `@spinajs/authz-http`)
- Modify: `packages/http-socket/tsconfig.json` (reference `../authz-http/tsconfig.json`)
- Create: `packages/http-socket/test/scripted-authz.ts`
- Test: `packages/http-socket/test/input-filter.test.ts`

**Interfaces:**
- Consumes: `ArgInputFilter` (`@spinajs/http`), `AuthzInputFieldFilter` (registered by importing `@spinajs/authz-http`), `SocketAccess`, `fromPayload`, harness `startServer`/`open`/`command`/`errorOf`/`resultOf`.
- Produces:
  - every `codeMapping(code)` mapping and `InvalidArgumentMapping` add `details.error` (string own prop `error`) and `details.fields` (string array own prop `fields`) when the error carries them;
  - `test/scripted-authz.ts`: `class ScriptedSocketAuthz extends AuthzService` with `static script: (input: CheckInput, domain: string) => ScriptedDecision`, `static checks: Array<{ domain: string; input: CheckInput }>`, `domain = 'root'`; `type ScriptedDecision = Partial<Omit<Decision, 'allowed'>> & { readonly allowed: boolean }`.

- [ ] **Step 1: Add the scripted AuthzService helper**

Create `packages/http-socket/test/scripted-authz.ts`:

```ts
import { AuthzService, FALSE, TRUE } from '@spinajs/authz';
import type { AccessSummary, AuthorizationModel, AuthzAdmin, CheckInput, Decision, Permission, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';

function unused(member: string): never {
  throw new Error(`${member} is not used by socket tests`);
}

/** What one check answers; the rest of the Decision is filled in. */
export type ScriptedDecision = Partial<Omit<Decision, 'allowed'>> & { readonly allowed: boolean };

/** A scripted AuthzService for socket tests: `script` answers every check, `checks` records them. */
export class ScriptedSocketAuthz extends AuthzService {
  public static script: (input: CheckInput, domain: string) => ScriptedDecision = () => ({ allowed: false });

  public static checks: Array<{ domain: string; input: CheckInput }> = [];

  public domain = 'root';

  public async check(input: CheckInput): Promise<Decision> {
    ScriptedSocketAuthz.checks.push({ domain: this.domain, input });
    const answer = ScriptedSocketAuthz.script(input, this.domain);

    return {
      permission: input.permission,
      resource: (input.resource ?? { type: 'none' }) as ResourceRef,
      principal: { type: input.principal.type, id: input.principal.id },
      residual: answer.allowed ? TRUE : FALSE,
      fields: { read: ['*'], write: ['*'] },
      roles: {},
      domain: this.domain,
      ...(answer.allowed ? {} : { reason: { code: 'no_access', model: 'm1' } }),
      ...answer,
    };
  }

  public current(): Principal {
    return unused('ScriptedSocketAuthz.current');
  }

  public runAs<T>(): Promise<T> {
    return unused('ScriptedSocketAuthz.runAs');
  }

  public can(): Promise<boolean> {
    return unused('ScriptedSocketAuthz.can');
  }

  public assert(): Promise<Decision> {
    return unused('ScriptedSocketAuthz.assert');
  }

  public checkMany(): Promise<ReadonlyMap<Permission, Decision>> {
    return unused('ScriptedSocketAuthz.checkMany');
  }

  public filter(): Promise<ResourceFilter> {
    return unused('ScriptedSocketAuthz.filter');
  }

  public filterNow(): ResourceFilter | undefined {
    return unused('ScriptedSocketAuthz.filterNow');
  }

  public explain(): Promise<Decision> {
    return unused('ScriptedSocketAuthz.explain');
  }

  public summary(): Promise<AccessSummary> {
    return unused('ScriptedSocketAuthz.summary');
  }

  public covers(): Promise<boolean> {
    return unused('ScriptedSocketAuthz.covers');
  }

  public preload(): Promise<void> {
    return unused('ScriptedSocketAuthz.preload');
  }

  public invalidate(): void {
    unused('ScriptedSocketAuthz.invalidate');
  }

  public models(): readonly AuthorizationModel[] {
    return unused('ScriptedSocketAuthz.models');
  }

  public admin(): AuthzAdmin {
    return unused('ScriptedSocketAuthz.admin');
  }
}
```

- [ ] **Step 2: Add `@spinajs/authz-http` as a test-only dependency**

In `packages/http-socket/package.json`, replace

```json
    "@spinajs/authz-orm": "3.0.0-alpha.0",
```

with

```json
    "@spinajs/authz-http": "3.0.0-alpha.0",
    "@spinajs/authz-orm": "3.0.0-alpha.0",
```

(it is inside `devDependencies`; `src/` never imports it). In `packages/http-socket/tsconfig.json`, replace

```json
    { "path": "../authz-orm/tsconfig.json" },
```

with

```json
    { "path": "../authz-http/tsconfig.json" },
    { "path": "../authz-orm/tsconfig.json" },
```

- [ ] **Step 3: Write the failing test**

Create `packages/http-socket/test/input-filter.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthenticationFailed, BadRequest, Forbidden } from '@spinajs/exceptions';
import { ArgInputFilter, BasePolicy } from '@spinajs/http';
import { AuthzService } from '@spinajs/authz';
// registers authz-http's AuthzInputFieldFilter as an ArgInputFilter
import '@spinajs/authz-http';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess, fromPayload } from '../src/access.js';
import { ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';
import { ScriptedSocketAuthz } from './scripted-authz.js';

let infWrite: readonly string[] = ['*'];

/** Refuses an `owner` key the way authz-http refuses a write in `reject` mode. */
export class InfRejectOwner extends ArgInputFilter {
  public filter(input: unknown): unknown {
    if (input !== null && typeof input === 'object' && 'owner' in input) {
      throw Object.assign(new BadRequest('fields not writable: owner'), { error: 'fields_not_writable', fields: ['owner'] });
    }
    return input;
  }
}

export class InfNeedsSession extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw Object.assign(new Forbidden('this route needs a session, not a per-request credential'), { error: 'session_required' });
  }
}

export class InfNeedsCaller extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw Object.assign(new AuthenticationFailed('this route needs an authenticated caller'), { error: 'unauthenticated' });
  }
}

@SocketController('inf')
export class InputFilterSocket extends BaseSocketController {
  @Command('update')
  @SocketAccess('doc:update', { resource: fromPayload('id', 'doc') })
  public async update(@Payload() doc: Record<string, unknown>) {
    return doc;
  }

  @Command('open')
  public async open(@Payload() body: Record<string, unknown>) {
    return body;
  }

  @Command('session')
  @SocketPolicy(InfNeedsSession)
  public async session() {
    return 'unreachable';
  }

  @Command('caller')
  @SocketPolicy(InfNeedsCaller)
  public async caller() {
    return 'unreachable';
  }
}

describe('socket payloads through the ArgInputFilters; http error codes in details (G3)', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;

  before(() => {
    DI.register(ScriptedSocketAuthz).as(AuthzService);
  });

  after(() => {
    DI.unregister(ScriptedSocketAuthz);
  });

  beforeEach(async () => {
    infWrite = ['*'];
    ScriptedSocketAuthz.checks = [];
    ScriptedSocketAuthz.script = () => ({ allowed: true, fields: { read: ['*'], write: infWrite } });
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'inf-alice', token: 'good' } });
  });

  afterEach(async () => {
    alice.close();
    await t.close();
  });

  it('B17 strips the payload fields the @SocketAccess decision does not let the caller write', async () => {
    infWrite = ['id', 'title'];
    expect(resultOf(await command(alice, 'inf.update', { id: 'd1', title: 'new', owner: 'mallory' }))).to.deep.equal({ id: 'd1', title: 'new' });
  });

  it('B17 strips fields.neverRead ( Password ) even when the decision lets the caller write every field', async () => {
    expect(resultOf(await command(alice, 'inf.update', { id: 'd1', title: 'new', Password: 'hash' }))).to.deep.equal({ id: 'd1', title: 'new' });
  });

  it('leaves the payload of a command without @SocketAccess untouched, as http leaves a route without @Access', async () => {
    expect(resultOf(await command(alice, 'inf.open', { login: 'alice', Password: 'secret' }))).to.deep.equal({ login: 'alice', Password: 'secret' });
  });

  it('answers a refused write invalid_argument with the error code and the refused fields in details', async () => {
    DI.register(InfRejectOwner).as(ArgInputFilter);
    DI.uncache(ArgInputFilter);
    try {
      expect(errorOf(await command(alice, 'inf.open', { title: 't', owner: 'x' }))).to.deep.equal({ code: 'invalid_argument', message: 'fields not writable: owner', retryable: false, details: { error: 'fields_not_writable', fields: ['owner'] } });
    } finally {
      DI.unregister(InfRejectOwner);
      DI.uncache(InfRejectOwner);
      DI.uncache(ArgInputFilter);
    }
  });

  it("answers a policy's stable code in details: forbidden", async () => {
    expect(errorOf(await command(alice, 'inf.session'))).to.deep.equal({ code: 'forbidden', message: 'this route needs a session, not a per-request credential', retryable: false, details: { error: 'session_required' } });
  });

  it("answers a policy's stable code in details: unauthenticated", async () => {
    expect(errorOf(await command(alice, 'inf.caller'))).to.deep.equal({ code: 'unauthenticated', message: 'this route needs an authenticated caller', retryable: false, details: { error: 'unauthenticated' } });
  });
});
```

- [ ] **Step 4: Run it to see the error-detail cases fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/input-filter.test.ts`
Expected: 3 passing (the three filter cases: L5's hook and authz-http already work), 3 failing — the refused write and both policy cases, with the actual error lacking `details` (`{ code: 'invalid_argument', message: 'fields not writable: owner', retryable: false }`).
If a filter case fails too, stop and report: the merged `PayloadArg` hook or the ALS store differs from what this plan verified.

- [ ] **Step 5: Carry the stable code and the refused fields**

In `packages/http-socket/src/errors.ts`, replace

```ts
export function codeMapping(code: ErrorCode): new () => { map(error: Error): SocketError } {
  return class extends SocketErrorMapping {
    public map(error: Error): SocketError {
      return { code, message: error.message, retryable: DEFAULT_RETRYABLE[code] };
    }
  };
}

@HandleSocketException([InvalidArgument, BadRequest, JsonValidationFailed])
export class InvalidArgumentMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    const field = (error as InvalidArgument).fieldName;
    return { code: 'invalid_argument', message: error.message, retryable: false, ...(typeof field === 'string' ? { details: { field } } : {}) };
  }
}
```

with

```ts
/**
 * The stable code ( `error` ) and the refused `fields` that authz-http and authn-http put on an error: http spreads them
 * into its response body, a socket answers them in `details`.
 */
function bodyDetails(error: Error): Record<string, unknown> {
  const { error: code, fields } = error as { error?: unknown; fields?: unknown };
  return {
    ...(typeof code === 'string' ? { error: code } : {}),
    ...(Array.isArray(fields) && fields.every((f) => typeof f === 'string') ? { fields: [...fields] } : {}),
  };
}

const withDetails = (details: Record<string, unknown>) => (Object.keys(details).length > 0 ? { details } : {});

export function codeMapping(code: ErrorCode): new () => { map(error: Error): SocketError } {
  return class extends SocketErrorMapping {
    public map(error: Error): SocketError {
      return { code, message: error.message, retryable: DEFAULT_RETRYABLE[code], ...withDetails(bodyDetails(error)) };
    }
  };
}

@HandleSocketException([InvalidArgument, BadRequest, JsonValidationFailed])
export class InvalidArgumentMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    const field = (error as InvalidArgument).fieldName;
    return { code: 'invalid_argument', message: error.message, retryable: false, ...withDetails({ ...(typeof field === 'string' ? { field } : {}), ...bodyDetails(error) }) };
  }
}
```

- [ ] **Step 6: Run the new and the neighbouring suites**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/input-filter.test.ts test/error-mapping.test.ts test/access.test.ts test/controller-model.test.ts test/authn-source.test.ts`
Expected: all passing, 0 failing (input-filter: 6 passing).

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/*.test.ts 2>&1 | tail -5`
Expected: the main-suite count after the previous http-socket task + 6 (B1 + 6 when Task 4 has not run yet), no new failure. This also shows that loading `@spinajs/authz-http` in the main test process changes no other suite.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.mjs.json`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/errors.ts packages/http-socket/package.json packages/http-socket/tsconfig.json packages/http-socket/test/scripted-authz.ts packages/http-socket/test/input-filter.test.ts && \
git commit -m "feat(http-socket): authz-http input field filters on socket payloads, http error codes in details"
```

---

### Task 2: G4 — `@SocketAccess` decides as authz-http's `AccessPolicy`

Mirrors every `AccessPolicy` difference except trace and `fromModel` (Q1, Q2): an extractor that finds nothing is refused; `subject: 'load'`; only the handler's own rule (else the class's) writes `AuthzDecision`; the `AuthzHttpRoute` mark (with `unfilteredInput`) for authz-http's input filter; and the permissions feed authz's boot checks (B02).

**Files:**
- Modify (replace): `packages/http-socket/src/access.ts`
- Create: `packages/http-socket/src/access-contributor.ts`
- Modify: `packages/http-socket/src/index.ts` (one export line)
- Modify (replace): `packages/http-socket/test/scripted-authz.ts` (adds `ScriptedSocketDomains`)
- Modify: `packages/http-socket/test/exports.test.ts` (two names)
- Test: `packages/http-socket/test/access-parity.test.ts`

**Interfaces:**
- Consumes: `ScriptedSocketAuthz` (Task 1); `IRoute` passed by `SocketPolicyGate` as the policy's second argument (its `Policies` are the handler's own groups); `AuthzContributor`, `ResourceAdapter`, `FALSE`, `parsePermission` from `@spinajs/authz`.
- Produces:
  - `interface ISocketAccessOptions` gains `subject?: 'load' | 'none'` and `unfilteredInput?: string`;
  - `interface ISocketAccess` gains required `scope: 'handler' | 'class'` (set by `@SocketAccess`);
  - `export function socketAccessOf(groups: readonly IPolicyGroup[] | undefined): ISocketAccess | undefined`;
  - `SocketAccessPolicy.execute(req: unknown, route?: IRoute): Promise<void>`; writes `storage.AuthzHttpRoute = { domain, unfilteredInput? }` and `storage.AuthzDecision` only when deciding;
  - `export class SocketAccessContributor extends AuthzContributor` (`contribute(domain): AuthzContribution`);
  - `test/scripted-authz.ts`: `class ScriptedSocketDomains extends AuthzDomains` with `static adapters: Array<new () => ResourceAdapter>`.

- [ ] **Step 1: Add scripted domains to the helper**

Replace `packages/http-socket/test/scripted-authz.ts` with:

```ts
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AuthzDomains, AuthzService, FALSE, ResourceAdapter, TRUE } from '@spinajs/authz';
import type { AccessSummary, AuthorizationModel, AuthzAdmin, CheckInput, Decision, Permission, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';

function unused(member: string): never {
  throw new Error(`${member} is not used by socket tests`);
}

/** What one check answers; the rest of the Decision is filled in. */
export type ScriptedDecision = Partial<Omit<Decision, 'allowed'>> & { readonly allowed: boolean };

/** A scripted AuthzService for socket tests: `script` answers every check, `checks` records them. */
export class ScriptedSocketAuthz extends AuthzService {
  public static script: (input: CheckInput, domain: string) => ScriptedDecision = () => ({ allowed: false });

  public static checks: Array<{ domain: string; input: CheckInput }> = [];

  public domain = 'root';

  public async check(input: CheckInput): Promise<Decision> {
    ScriptedSocketAuthz.checks.push({ domain: this.domain, input });
    const answer = ScriptedSocketAuthz.script(input, this.domain);

    return {
      permission: input.permission,
      resource: (input.resource ?? { type: 'none' }) as ResourceRef,
      principal: { type: input.principal.type, id: input.principal.id },
      residual: answer.allowed ? TRUE : FALSE,
      fields: { read: ['*'], write: ['*'] },
      roles: {},
      domain: this.domain,
      ...(answer.allowed ? {} : { reason: { code: 'no_access', model: 'm1' } }),
      ...answer,
    };
  }

  public current(): Principal {
    return unused('ScriptedSocketAuthz.current');
  }

  public runAs<T>(): Promise<T> {
    return unused('ScriptedSocketAuthz.runAs');
  }

  public can(): Promise<boolean> {
    return unused('ScriptedSocketAuthz.can');
  }

  public assert(): Promise<Decision> {
    return unused('ScriptedSocketAuthz.assert');
  }

  public checkMany(): Promise<ReadonlyMap<Permission, Decision>> {
    return unused('ScriptedSocketAuthz.checkMany');
  }

  public filter(): Promise<ResourceFilter> {
    return unused('ScriptedSocketAuthz.filter');
  }

  public filterNow(): ResourceFilter | undefined {
    return unused('ScriptedSocketAuthz.filterNow');
  }

  public explain(): Promise<Decision> {
    return unused('ScriptedSocketAuthz.explain');
  }

  public summary(): Promise<AccessSummary> {
    return unused('ScriptedSocketAuthz.summary');
  }

  public covers(): Promise<boolean> {
    return unused('ScriptedSocketAuthz.covers');
  }

  public preload(): Promise<void> {
    return unused('ScriptedSocketAuthz.preload');
  }

  public invalidate(): void {
    unused('ScriptedSocketAuthz.invalidate');
  }

  public models(): readonly AuthorizationModel[] {
    return unused('ScriptedSocketAuthz.models');
  }

  public admin(): AuthzAdmin {
    return unused('ScriptedSocketAuthz.admin');
  }
}

/** Named domains answer through ScriptedSocketAuthz; `container()` holds `adapters`, which `subject: 'load'` asks for rows. */
export class ScriptedSocketDomains extends AuthzDomains {
  public static adapters: Array<new () => ResourceAdapter> = [];

  public async service(name: string): Promise<AuthzService> {
    const service = new ScriptedSocketAuthz();
    service.domain = name;
    return service;
  }

  public create(): IContainer {
    return unused('ScriptedSocketDomains.create');
  }

  public container(): IContainer {
    const container = DI.RootContainer.child();
    for (const adapter of ScriptedSocketDomains.adapters) {
      container.register(adapter).as(ResourceAdapter);
    }
    return container;
  }

  public names(): readonly string[] {
    return ['root', 'tenant'];
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/http-socket/test/access-parity.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { AuthzDomains, AuthzService, ResourceAdapter } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
// registers authz-http's AuthzInputFieldFilter, which reads the AuthzHttpRoute mark
import '@spinajs/authz-http';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess, fromPayload } from '../src/access.js';
import { SocketAccessContributor } from '../src/access-contributor.js';
import { ISocketCallStorage } from '../src/interfaces.js';
import { ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';
import { ScriptedSocketAuthz, ScriptedSocketDomains } from './scripted-authz.js';

interface IAcpNote {
  id: string;
  owner: string;
}

const ACP_NOTES = new Map<string, IAcpNote>([
  ['n1', { id: 'n1', owner: '1' }],
  ['n2', { id: 'n2', owner: 'bob' }],
]);

export const acpLoads: ResourceRef[] = [];

/** Loads notes for `subject: 'load'`; owner '1' is the harness's alice. */
export class AcpNoteAdapter extends ResourceAdapter<IAcpNote> {
  public readonly kind = 'acp';
  public readonly types = ['note'];

  public accepts(_target: unknown): _target is IAcpNote {
    return false;
  }

  public refOf(target: IAcpNote): ResourceRef {
    return { type: 'note', id: target.id };
  }

  public async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return [ref];
  }

  public async load(ref: ResourceRef): Promise<unknown | null> {
    acpLoads.push(ref);
    return ACP_NOTES.get(ref.id ?? '') ?? null;
  }
}

export class AcpAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

const store = () => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();

@SocketController('acp')
@SocketAccess('note:list')
export class AccessParitySocket extends BaseSocketController {
  @Command('nothing')
  @SocketAccess('note:read', { resource: () => undefined as unknown as ResourceRef })
  public async nothing() {
    return 'unreachable';
  }

  @Command('load')
  @SocketAccess('note:read', { resource: fromPayload('id', 'note'), subject: 'load' })
  public async load() {
    return 'loaded';
  }

  @Command('residual')
  @SocketAccess('note:read', { resource: fromPayload('id', 'note') })
  public async residual() {
    return 'left to the handler';
  }

  @Command('own')
  @SocketAccess('note:read', { domain: 'tenant' })
  public async own() {
    const s = store();
    return { permission: s?.AuthzDecision?.permission ?? null, domain: s?.AuthzDecision?.domain ?? null, mark: s?.AuthzHttpRoute ?? null };
  }

  @Command('inherited')
  public async inherited() {
    const s = store();
    return { permission: s?.AuthzDecision?.permission ?? null, mark: s?.AuthzHttpRoute ?? null };
  }

  @Command('alt')
  @SocketAccess('note:write')
  @SocketPolicy(AcpAllow)
  public async alt(@Payload() note: Record<string, unknown>) {
    return { note, decision: store()?.AuthzDecision?.permission ?? null };
  }

  @Command('password')
  @SocketAccess('note:read', { unfilteredInput: 'the caller sets its own password' })
  public async password(@Payload() body: Record<string, unknown>) {
    return body;
  }
}

describe('@SocketAccess decides as authz-http AccessPolicy (G4)', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;

  const readChecks = () => ScriptedSocketAuthz.checks.filter((c) => c.input.permission === 'note:read');

  before(() => {
    DI.register(ScriptedSocketAuthz).as(AuthzService);
    DI.register(ScriptedSocketDomains).as(AuthzDomains);
    ScriptedSocketDomains.adapters = [AcpNoteAdapter];
  });

  after(() => {
    DI.unregister(ScriptedSocketAuthz);
    DI.unregister(ScriptedSocketDomains);
    ScriptedSocketDomains.adapters = [];
  });

  beforeEach(async () => {
    acpLoads.length = 0;
    ScriptedSocketAuthz.checks = [];
    ScriptedSocketAuthz.script = (input) => {
      if (input.permission === 'note:write') {
        return { allowed: false };
      }
      const ref = input.resource as ResourceRef | undefined;
      if (input.permission === 'note:read' && ref?.id !== undefined) {
        // owner only: a conditional allow until the row is known
        if (input.subject === undefined) {
          return { allowed: true, residual: { op: 'relation', relation: 'owner' } };
        }
        return { allowed: (input.subject as IAcpNote).owner === input.principal.id };
      }
      return { allowed: true };
    };
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'acp-alice', token: 'good' } });
  });

  afterEach(async () => {
    alice.close();
    await t.close();
  });

  it('refuses a resource extractor that finds no resource with invalid_argument, without a type-level check', async () => {
    expect(errorOf(await command(alice, 'acp.nothing'))).to.include({ code: 'invalid_argument', message: 'the resource extractor of acp.nothing found no resource' });
    expect(readChecks()).to.have.length(0);
  });

  it("subject: 'load' settles a conditional allow against the row the domain's ResourceAdapter loads", async () => {
    expect(resultOf(await command(alice, 'acp.load', { id: 'n1' }))).to.equal('loaded');
    expect(acpLoads).to.deep.equal([{ type: 'note', id: 'n1' }]);
    expect(readChecks().map((c) => c.input.subject ?? null)).to.deep.equal([null, { id: 'n1', owner: '1' }]);
  });

  it("subject: 'load' denies another owner's row, and a missing row with unknown_resource", async () => {
    expect(errorOf(await command(alice, 'acp.load', { id: 'n2' })).details).to.deep.equal({ permission: 'note:read', resource: { type: 'note', id: 'n2' }, reason: { code: 'no_access', model: 'm1' } });
    expect(errorOf(await command(alice, 'acp.load', { id: 'n3' })).details).to.deep.equal({ permission: 'note:read', resource: { type: 'note', id: 'n3' }, reason: { code: 'unknown_resource' } });
  });

  it("without subject: 'load' a conditional allow passes and loads no row; the residual is the handler's to apply", async () => {
    expect(resultOf(await command(alice, 'acp.residual', { id: 'n2' }))).to.equal('left to the handler');
    expect(acpLoads).to.have.length(0);
  });

  it("leaves the handler's own decision, not the class's, in the call store, with the AuthzHttpRoute mark of its domain", async () => {
    expect(resultOf(await command(alice, 'acp.own'))).to.deep.equal({ permission: 'note:read', domain: 'tenant', mark: { domain: 'tenant' } });
  });

  it("leaves the class's decision and mark for a handler without its own @SocketAccess", async () => {
    expect(resultOf(await command(alice, 'acp.inherited'))).to.deep.equal({ permission: 'note:list', mark: { domain: 'root' } });
  });

  it('keeps no decision for a call another policy group admitted, yet authz-http still strips fields.neverRead from its payload', async () => {
    expect(resultOf(await command(alice, 'acp.alt', { title: 't', Password: 'hash' }))).to.deep.equal({ note: { title: 't' }, decision: null });
  });

  it('unfilteredInput opts a command out of the input field filter, as @UnfilteredInput does', async () => {
    expect(resultOf(await command(alice, 'acp.password', { Password: 'new secret' }))).to.deep.equal({ Password: 'new secret' });
  });

  it('B02 contributes every @SocketAccess permission to the boot checks of the domain it checks in', () => {
    const ours = (domain: string) => (new SocketAccessContributor().contribute(domain).permissionRefs ?? []).filter((r) => r.source.startsWith('@SocketAccess on AccessParitySocket'));

    expect(ours('root')).to.deep.include.members([
      { permission: 'note:list', type: 'note', source: '@SocketAccess on AccessParitySocket' },
      { permission: 'note:read', source: '@SocketAccess on AccessParitySocket.load' },
      { permission: 'note:write', type: 'note', source: '@SocketAccess on AccessParitySocket.alt' },
    ]);
    expect(ours('tenant')).to.deep.equal([{ permission: 'note:read', type: 'note', source: '@SocketAccess on AccessParitySocket.own' }]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/access-parity.test.ts`
Expected: FAIL to compile with `Cannot find module '../src/access-contributor.js'` (and `subject` / `unfilteredInput` not in `ISocketAccessOptions`).

- [ ] **Step 4: Rewrite `access.ts`**

Replace `packages/http-socket/src/access.ts` with:

```ts
import { Class, DI, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BasePolicy, IPolicyGroup } from '@spinajs/http';
import type { IRoute } from '@spinajs/http';
import { AccessDenied, AuthzDomains, AuthzService, FALSE, ResourceAdapter, Unauthenticated, parsePermission } from '@spinajs/authz';
import type { Decision, Permission, Principal, ResourceRef, ResourceType } from '@spinajs/authz';
import { SocketPolicyGroup } from './decorators.js';
import { ISocketPolicyRequest } from './policies.js';

export type SocketResourceExtractor = (call: ISocketPolicyRequest) => ResourceRef | object | Promise<ResourceRef | object>;

export interface ISocketAccessOptions {
  /** default: the type-level ref of each permission's resource ( `doc:read` → `{ type: 'doc' }` ) */
  resource?: SocketResourceExtractor;
  /** more policies in the same group ( AND ), as authz-http's `AccessOptions.also` ( B23 ) */
  also?: readonly Class<BasePolicy>[];
  /** authz domain; default 'root' */
  domain?: string;
  /** let an unauthenticated principal ( UNATTENDED, anonymous ) reach the engine instead of answering unauthenticated */
  allowAnonymous?: boolean;
  /** 'load': a conditional allow is checked again against the row the domain's ResourceAdapter loads, so the answer is definite */
  subject?: 'load' | 'none';
  /** why the payload skips authz-http's input field filter, as `@UnfilteredInput(reason)` */
  unfilteredInput?: string;
}

export interface ISocketAccess extends ISocketAccessOptions {
  permissions: readonly Permission[];
  /** where `@SocketAccess` sits; the handler's own rule, else the class's, leaves its decision in the call storage */
  scope: 'handler' | 'class';
}

/** The resource ref from a payload field ( dotted path ). */
export function fromPayload(path: string, type: ResourceType): SocketResourceExtractor {
  const keys = path.split('.');

  return (call) => {
    let value: unknown = call.body;
    for (const key of keys) {
      value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    }

    if (typeof value === 'number' || (typeof value === 'string' && value.length > 0)) {
      return { type, id: String(value) };
    }

    throw new InvalidArgument(`payload.${path} is required`, path);
  };
}

/** The first `@SocketAccess` rule among one scope's policy groups ( a handler's, or its controller's ). */
export function socketAccessOf(groups: readonly IPolicyGroup[] | undefined): ISocketAccess | undefined {
  for (const member of (groups ?? []).flat()) {
    if (member.Type === SocketAccessPolicy) {
      return member.Options[0] as ISocketAccess;
    }
  }

  return undefined;
}

const isRef = (v: unknown): v is ResourceRef => typeof v === 'object' && v !== null && typeof (v as ResourceRef).type === 'string' && Object.keys(v).every((k) => k === 'type' || k === 'id');

/**
 * Decides one `@SocketAccess` group as authz-http's AccessPolicy decides `@Access` ( design §11.2 ): unauthenticated ⇒
 * Unauthenticated, an extractor that finds nothing ⇒ InvalidArgument, several permissions ⇒ any of them, `subject: 'load'` ⇒
 * a conditional allow settled against the loaded row, a denial ⇒ AccessDenied, never with a trace ( sockets offer no explain ).
 * The allowing decision of the handler's own rule, else the class's, stays in the call storage.
 */
@NewInstance()
export class SocketAccessPolicy extends BasePolicy {
  constructor(protected readonly access: ISocketAccess) {
    super();
  }

  public isEnabled(): boolean {
    return true;
  }

  /** @param route - the socket gate's route: its `Policies` are the handler's own groups */
  public async execute(req: unknown, route?: IRoute): Promise<void> {
    const call = req as ISocketPolicyRequest;
    const domain = this.access.domain ?? 'root';
    const deciding = this.access.scope === 'handler' || socketAccessOf(route?.Policies) === undefined;

    if (deciding) {
      // authz-http's AuthzInputFieldFilter reads this mark, so a call another policy group admitted still loses fields.neverRead
      call.storage.AuthzHttpRoute = { domain, ...(this.access.unfilteredInput !== undefined ? { unfilteredInput: this.access.unfilteredInput } : {}) };
    }

    const principal = call.storage.Principal;
    if (!principal.authenticated && !this.access.allowAnonymous) {
      throw new Unauthenticated(`${call.originalUrl} needs an authenticated principal`);
    }

    const authz = await this.service(domain);
    const resource = this.access.resource ? await this.access.resource(call) : undefined;
    if (this.access.resource && (resource === null || resource === undefined)) {
      throw new InvalidArgument(`the resource extractor of ${call.originalUrl} found no resource`, 'resource');
    }

    const decision = await this.decide(authz, domain, principal, resource);
    if (!decision.allowed) {
      throw new AccessDenied(decision);
    }

    if (deciding) {
      call.storage.AuthzDecision = decision;
    }
  }

  protected async decide(authz: AuthzService, domain: string, principal: Principal, resource: ResourceRef | object | undefined): Promise<Decision> {
    let denied: Decision | undefined;
    let row: Promise<unknown> | undefined;

    for (const permission of this.access.permissions) {
      let decision = await authz.check({ principal, permission, resource: resource ?? { type: parsePermission(permission).resource } });

      if (decision.allowed && decision.residual.op !== 'true' && this.access.subject === 'load') {
        row ??= this.load(domain, decision.resource);
        const subject = await row;
        decision = subject === null ? Object.freeze({ ...decision, allowed: false, residual: FALSE, reason: { code: 'unknown_resource' } }) : await authz.check({ principal, permission, resource: decision.resource, subject });
      }

      if (decision.allowed) {
        return decision;
      }

      denied ??= decision;
    }

    return denied!;
  }

  /** The row from the first adapter of the domain that serves the ref's type and can load; null when none can or the row is missing. */
  protected async load(domain: string, ref: ResourceRef): Promise<unknown> {
    if (!isRef(ref) || ref.id === undefined) {
      return null;
    }

    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    const adapters = [...(await domains.container(domain).resolve(Array.chainOf(ResourceAdapter)))] as ResourceAdapter[];
    const adapter = adapters.find((a) => typeof a.load === 'function' && a.types.includes(ref.type));
    return adapter ? ((await adapter.load!(ref)) ?? null) : null;
  }

  protected async service(domain: string): Promise<AuthzService> {
    if (domain === 'root') {
      return (await DI.resolve(AuthzService)) as AuthzService;
    }

    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    return domains.service(domain);
  }
}

/**
 * The socket form of authz-http's `@Access`, which writes http's controller descriptor and so
 * cannot sit on a socket controller ( D3 ). One group: SocketAccessPolicy AND the `also`
 * policies; other `@SocketPolicy` groups stay alternatives ( OR ).
 */
export function SocketAccess(permission: Permission | readonly Permission[], options: ISocketAccessOptions = {}) {
  const permissions: Permission[] = typeof permission === 'string' ? [permission] : [...permission];

  if (permissions.length === 0) {
    throw new Error('@SocketAccess needs at least one permission');
  }

  // a malformed name fails when the controller module loads, not on the first call
  permissions.forEach((p) => parsePermission(p));

  return (target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor): void => {
    const access: ISocketAccess = { ...options, permissions, scope: propertyKey === undefined ? 'class' : 'handler' };
    SocketPolicyGroup([{ Type: SocketAccessPolicy, Options: [access] }, ...(options.also ?? []).map((Type) => ({ Type, Options: [] }))] as IPolicyGroup)(target, propertyKey, indexOrDescriptor);
  };
}
```

- [ ] **Step 5: Add the boot contributor**

Create `packages/http-socket/src/access-contributor.ts`:

```ts
import { DI, Injectable } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import type { IPolicyGroup } from '@spinajs/http';
import { AuthzContributor, parsePermission } from '@spinajs/authz';
import type { AuthzContribution, PermissionRefDecl } from '@spinajs/authz';
import { BaseSocketController } from './controller.js';
import { ISocketControllerDescriptor, SOCKET_CONTROLLER_DESCRIPTOR } from './interfaces.js';
import { ISocketAccess, SocketAccessPolicy } from './access.js';

/**
 * Feeds the permissions of every registered socket controller's `@SocketAccess` to boot rule 7 of the domain it checks
 * in, as authz-http's AccessContributor does for `@Access`: an unregistered permission fails that domain's boot ( B02 ).
 */
@Injectable(AuthzContributor)
export class SocketAccessContributor extends AuthzContributor {
  public contribute(domain: string): AuthzContribution {
    const permissionRefs: PermissionRefDecl[] = [];

    for (const type of new Set(DI.getRegisteredTypes(BaseSocketController) ?? [])) {
      const controller = type as Class<BaseSocketController>;
      const descriptor = Reflect.getMetadata(SOCKET_CONTROLLER_DESCRIPTOR, controller.prototype) as ISocketControllerDescriptor | undefined;
      if (!descriptor) {
        continue;
      }

      const scopes: Array<[string, readonly IPolicyGroup[]]> = [[`@SocketAccess on ${controller.name}`, descriptor.Policies], ...[...descriptor.Handlers.values()].map((h): [string, readonly IPolicyGroup[]] => [`@SocketAccess on ${controller.name}.${String(h.Method)}`, h.Policies])];

      for (const [source, groups] of scopes) {
        for (const member of groups.flat()) {
          const access = member.Type === SocketAccessPolicy ? (member.Options[0] as ISocketAccess) : undefined;
          if (!access || (access.domain ?? 'root') !== domain) {
            continue;
          }

          for (const permission of access.permissions) {
            // without an extractor the check runs on the type-level ref of the permission's resource
            permissionRefs.push(access.resource ? { permission, source } : { permission, type: parsePermission(permission).resource, source });
          }
        }
      }
    }

    return { permissionRefs };
  }
}
```

In `packages/http-socket/src/index.ts`, replace

```ts
export * from './access.js';
```

with

```ts
export * from './access.js';
export { SocketAccessContributor } from './access-contributor.js';
```

- [ ] **Step 6: Pin the two new public names**

In `packages/http-socket/test/exports.test.ts`, replace

```ts
  'SocketAccess',
  'SocketAccessPolicy',
```

with

```ts
  'SocketAccess',
  'SocketAccessContributor',
  'SocketAccessPolicy',
```

and replace

```ts
  'payloadSize',
  'socketMetrics',
```

with

```ts
  'payloadSize',
  'socketAccessOf',
  'socketMetrics',
```

- [ ] **Step 7: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/access-parity.test.ts test/access.test.ts test/events.test.ts test/input-filter.test.ts test/exports.test.ts test/policies.test.ts`
Expected: all passing, 0 failing (access-parity: 9 passing).

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/*.test.ts 2>&1 | tail -5 && npx ts-mocha -p tsconfig.json --config .mocharc.authz.json 2>&1 | tail -3`
Expected: the main-suite count after the previous http-socket task + 9 (B1 + 15 when Task 4 has not run yet), B2 passing, no new failure. The authz process loads `SocketAccessContributor`; its B09 controllers carry no `@SocketAccess`, so their boots are unchanged.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.mjs.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.cjs.json`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/access.ts packages/http-socket/src/access-contributor.ts packages/http-socket/src/index.ts packages/http-socket/test/scripted-authz.ts packages/http-socket/test/access-parity.test.ts packages/http-socket/test/exports.test.ts && \
git commit -m "feat(http-socket): @SocketAccess decides as authz-http's AccessPolicy (subject load, own decision, input mark, boot refs)"
```

---

### Task 3: G4 — `@SocketAccess(…, { fields: 'filter' })` on results and stream chunks

**Files:**
- Modify: `packages/http-socket/src/access.ts` (one option)
- Create: `packages/http-socket/src/stages/access-fields.ts`
- Modify: `packages/http-socket/src/stages/index.ts`
- Modify: `packages/http-socket/test/exports.test.ts`
- Test: `packages/http-socket/test/access-fields.test.ts`

**Interfaces:**
- Consumes: `socketAccessOf`, `ISocketAccess` (Task 2); `isStreamResult` (`src/stream.ts`, internal); `filterObject`, `subtractFieldGlobs`, `readDomainConfig`, `DefaultAuthzDomains`, `AUTHZ_DEFAULTS` from `@spinajs/authz`; `ScriptedSocketAuthz` (Task 1); `rawStream` (`test/stream-client.ts`).
- Produces: `ISocketAccessOptions.fields?: 'filter' | 'none'`; `export class AccessFieldsStage extends SocketCommandStage` at `Order = STAGE_ORDER.Policies + 50` (650).

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/access-fields.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { AuthzService } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess } from '../src/access.js';
import { ITestServer, command, open, resultOf, startServer } from './harness.js';
import { rawStream } from './stream-client.js';
import { ScriptedSocketAuthz } from './scripted-authz.js';

const ACF_NOTE = { id: 'n1', title: 't', body: 'b', Password: 'hash' };

export class AcfAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

@SocketController('acf')
export class AccessFieldsSocket extends BaseSocketController {
  @Command('one')
  @SocketAccess('note:read', { fields: 'filter' })
  public async one() {
    return { ...ACF_NOTE };
  }

  @Command('many')
  @SocketAccess('note:read', { fields: 'filter' })
  public async many() {
    return [{ ...ACF_NOTE }, { ...ACF_NOTE, id: 'n2' }];
  }

  @Command('rows')
  @SocketAccess('note:read', { fields: 'filter' })
  public async *rows() {
    yield { ...ACF_NOTE };
    yield { ...ACF_NOTE, id: 'n2' };
  }

  @Command('raw')
  @SocketAccess('note:read')
  public async raw() {
    return { ...ACF_NOTE };
  }

  @Command('bytes')
  @SocketAccess('note:read', { fields: 'filter' })
  public async bytes() {
    return new Uint8Array([1, 2, 3]);
  }

  @Command('alt')
  @SocketAccess('note:write', { fields: 'filter' })
  @SocketPolicy(AcfAllow)
  public async alt() {
    return { ...ACF_NOTE };
  }
}

@SocketController('acfc')
@SocketAccess('note:list', { fields: 'filter' })
export class AccessFieldsClassSocket extends BaseSocketController {
  @Command('inherited')
  public async inherited() {
    return { ...ACF_NOTE };
  }
}

describe("@SocketAccess fields: 'filter' (G4)", function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;

  before(() => {
    DI.register(ScriptedSocketAuthz).as(AuthzService);
  });

  after(() => {
    DI.unregister(ScriptedSocketAuthz);
  });

  beforeEach(async () => {
    ScriptedSocketAuthz.checks = [];
    ScriptedSocketAuthz.script = (input) => (input.permission === 'note:write' ? { allowed: false } : { allowed: true, fields: { read: ['id', 'title', 'Password'], write: ['*'] } });
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'acf-alice', token: 'good' } });
  });

  afterEach(async () => {
    alice.close();
    await t.close();
  });

  it('B17 keeps the fields decision.fields.read allows, minus fields.neverRead', async () => {
    expect(resultOf(await command(alice, 'acf.one'))).to.deep.equal({ id: 'n1', title: 't' });
  });

  it('filters every element of a list result', async () => {
    expect(resultOf(await command(alice, 'acf.many'))).to.deep.equal([
      { id: 'n1', title: 't' },
      { id: 'n2', title: 't' },
    ]);
  });

  it('filters every chunk of a stream reply', async () => {
    const stream = rawStream(alice, 'acf.rows', null, 8);

    expect(await stream.reply).to.deep.include({ ok: true, stream: true });
    await stream.finished;
    expect(stream.chunks.map((c) => c.data)).to.deep.equal([
      { id: 'n1', title: 't' },
      { id: 'n2', title: 't' },
    ]);
    expect(stream.end).to.not.equal(null);
  });

  it("sends the result as the handler returned it without fields: 'filter'", async () => {
    expect(resultOf(await command(alice, 'acf.raw'))).to.deep.equal(ACF_NOTE);
  });

  it('passes a binary result through unchanged', async () => {
    expect(Array.from(resultOf(await command<Uint8Array>(alice, 'acf.bytes')))).to.deep.equal([1, 2, 3]);
  });

  it('applies the class rule to a handler without its own @SocketAccess', async () => {
    expect(resultOf(await command(alice, 'acfc.inherited'))).to.deep.equal({ id: 'n1', title: 't' });
  });

  it('drops only fields.neverRead for a call another policy group admitted: there is no decision', async () => {
    expect(resultOf(await command(alice, 'acf.alt'))).to.deep.equal({ id: 'n1', title: 't', body: 'b' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/access-fields.test.ts`
Expected: FAIL to compile: `Object literal may only specify known properties, and 'fields' does not exist in type 'ISocketAccessOptions'`.

- [ ] **Step 3: Add the option and the stage**

In `packages/http-socket/src/access.ts`, replace

```ts
  subject?: 'load' | 'none';
```

with

```ts
  subject?: 'load' | 'none';
  /** 'filter': the result, or each chunk of a stream reply, keeps only the fields `decision.fields.read` allows, minus the domain's `fields.neverRead` */
  fields?: 'filter' | 'none';
```

Create `packages/http-socket/src/stages/access-fields.ts`:

```ts
import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AUTHZ_DEFAULTS, AuthzDomains, DefaultAuthzDomains, filterObject, readDomainConfig, subtractFieldGlobs } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { IRegisteredHandler, ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { ISocketAccess, socketAccessOf } from '../access.js';
import { isStreamResult } from '../stream.js';

/** The handler's own `@SocketAccess` rule, else its controller's: the one whose decision is in the call storage. */
function accessOf(handler: IRegisteredHandler | undefined): ISocketAccess | undefined {
  return handler ? (socketAccessOf(handler.descriptor.Policies) ?? socketAccessOf(handler.controller.Descriptor?.Policies)) : undefined;
}

async function* filtered(source: AsyncIterable<unknown>, filter: (chunk: unknown) => unknown): AsyncGenerator<unknown> {
  for await (const chunk of source) {
    yield filter(chunk);
  }
}

/**
 * `@SocketAccess(…, { fields: 'filter' })`: the command result, or each chunk of a stream reply, limited to
 * `decision.fields.read` minus the domain's `fields.neverRead`, as authz-http's `fields: 'filter'` limits a response ( B17 ).
 * A call another policy group admitted has no decision, so only `neverRead` applies. Binary values pass unchanged.
 */
@Injectable(SocketCommandStage)
export class AccessFieldsStage extends SocketCommandStage {
  @Config('authz')
  protected Authz: unknown;

  public get Order(): number {
    // after the policies left the decision; wraps the arguments and the handler
    return STAGE_ORDER.Policies + 50;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const access = accessOf(ctx.handler);
    if (access?.fields !== 'filter') {
      return next();
    }

    const result = await next();
    const read = this.readable(ctx.storage.AuthzDecision, access.domain ?? 'root');
    const filter = (data: unknown): unknown => (data !== null && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) ? filterObject(read, data) : data);

    return isStreamResult(result) ? filtered(result, filter) : filter(result);
  }

  protected readable(decision: Decision | undefined, domain: string): readonly string[] {
    const domains = DI.get(AuthzDomains);
    const neverRead = domains instanceof DefaultAuthzDomains ? readDomainConfig(this.Authz, domains.lineage(decision?.domain ?? domain)).fields.neverRead : AUTHZ_DEFAULTS.fields.neverRead;
    const read = decision?.fields.read ?? ['*'];
    return neverRead.length === 0 ? read : subtractFieldGlobs(read, neverRead);
  }
}
```

In `packages/http-socket/src/stages/index.ts`, replace

```ts
export * from './policies.js';
```

with

```ts
export * from './policies.js';
export * from './access-fields.js';
```

In `packages/http-socket/test/exports.test.ts`, replace

```ts
  'AccessDeniedMapping',
  'ArgumentsStage',
```

with

```ts
  'AccessDeniedMapping',
  'AccessFieldsStage',
  'ArgumentsStage',
```

- [ ] **Step 4: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/access-fields.test.ts test/access-parity.test.ts test/access.test.ts test/stream.test.ts test/streams.test.ts test/idempotency.test.ts test/observability.test.ts test/exports.test.ts`
Expected: all passing, 0 failing (access-fields: 7 passing).

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/*.test.ts 2>&1 | tail -5`
Expected: the main-suite count after the previous http-socket task + 7 (B1 + 22 when Task 4 has not run yet), no new failure.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.mjs.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.cjs.json`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/access.ts packages/http-socket/src/stages/access-fields.ts packages/http-socket/src/stages/index.ts packages/http-socket/test/access-fields.test.ts packages/http-socket/test/exports.test.ts && \
git commit -m "feat(http-socket): @SocketAccess fields filter on command results and stream chunks"
```

---

### Task 4: G5 — the handshake client address behind trusted proxies

`handshake.address` becomes the client address by authn-http `ClientIp`'s rule (Q3, Q4); the raw peer moves to `handshake.peerAddress`. Every consumer already reads `address` (authn context `ip` in `AuthnCredentialSource`, policy `ip` in `policyRequest`, call store `realIp`), so none changes. Without a trust setting nothing changes (SR-03).

**Files:**
- Create: `packages/http-socket/src/client-address.ts`
- Modify: `packages/http-socket/src/interfaces.ts:97-98` (`ISocketHandshake.address`, new `peerAddress`)
- Modify: `packages/http-socket/src/connection.ts:41-54` (`toHandshake`)
- Modify: `packages/http-socket/src/server.ts` (imports, two `@Config` fields, `resolve()`, two `toHandshake` calls)
- Modify: `packages/http-socket/test/authn-source.test.ts:131,153`, `packages/http-socket/test/revalidation.test.ts:147` (fixtures)
- Test: `packages/http-socket/test/client-address.test.ts`

**Interfaces:**
- Consumes: `parseTrustProxy(value, key): ProxyTrust`, `trustedClientAddress(socketAddress, forwardedFor, trust): string | undefined`, `type ProxyTrust` from `@spinajs/http`; config `authn.http.trustProxy`, `http.trustProxy`.
- Produces: `ISocketHandshake.address` (trusted client address) and `ISocketHandshake.peerAddress: string` (required); internal `socketProxyTrust(authnTrust, httpTrust): ProxyTrust`, `clientAddressOf(peer, headers, trust): string`, `toHandshake(socket, trust)`. No new public export.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/client-address.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketHub } from '../src/hub.js';
import { ISocketCallStorage, ISocketHandshake } from '../src/interfaces.js';
import { ISocketPolicyRequest } from '../src/policies.js';
import { ITestServer, TestPrincipalSource, command, open, resultOf, startServer } from './harness.js';

export const cipSeen: { ip: string | null } = { ip: null };

export class CipCapture extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    cipSeen.ip = (req as ISocketPolicyRequest).ip;
  }
}

@SocketController('cip')
export class ClientAddressSocket extends BaseSocketController {
  @Command('where')
  @SocketPolicy(CipCapture)
  public async where() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    return { policy: cipSeen.ip, realIp: store?.realIp ?? null };
  }
}

describe('the handshake client address behind trusted proxies (G5)', function () {
  this.timeout(15000);

  let t: ITestServer | null = null;
  let sockets: ClientSocket[] = [];

  async function connectThrough(cfg: Record<string, unknown>, forwardedFor?: string): Promise<{ socket: ClientSocket; handshake: ISocketHandshake }> {
    t = await startServer(cfg);
    const socket = await open(t, forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } });
    sockets.push(socket);
    return { socket, handshake: DI.resolve(SocketHub).connection(socket.id!)!.handshake };
  }

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t?.close();
    t = null;
    cipSeen.ip = null;
  });

  it('SR-03 without a trusted proxy the address is the peer, whatever X-Forwarded-For claims', async () => {
    const { handshake } = await connectThrough({}, '203.0.113.7');

    expect(handshake.address).to.equal('127.0.0.1');
    expect(handshake.peerAddress).to.match(/127\.0\.0\.1$/);
  });

  it('takes the X-Forwarded-For client from a trusted proxy hop ( http.trustProxy ), and principal sources see it', async () => {
    const { handshake } = await connectThrough({ http: { trustProxy: 'loopback' } }, '203.0.113.7');

    expect(handshake.address).to.equal('203.0.113.7');
    expect(handshake.peerAddress).to.match(/127\.0\.0\.1$/);
    expect(TestPrincipalSource.lastHandshake?.address).to.equal('203.0.113.7');
  });

  it('stops at the first untrusted hop: an entry the client wrote itself is ignored', async () => {
    const { handshake } = await connectThrough({ http: { trustProxy: 'loopback' } }, '198.51.100.9, 203.0.113.7');

    expect(handshake.address).to.equal('203.0.113.7');
  });

  it('authn.http.trustProxy wins over http.trustProxy, as authn-http ClientIp reads them', async () => {
    const { handshake } = await connectThrough({ authn: { http: { trustProxy: [] } }, http: { trustProxy: 'loopback' } }, '203.0.113.7');

    expect(handshake.address).to.equal('127.0.0.1');
  });

  it('a null authn.http.trustProxy falls back to http.trustProxy', async () => {
    const { handshake } = await connectThrough({ authn: { http: { trustProxy: null } }, http: { trustProxy: 1 } }, '203.0.113.7');

    expect(handshake.address).to.equal('203.0.113.7');
  });

  it('policies and the call store see the trusted address', async () => {
    const { socket } = await connectThrough({ http: { trustProxy: 'loopback' } }, '203.0.113.7');

    expect(resultOf(await command(socket, 'cip.where'))).to.deep.equal({ policy: '203.0.113.7', realIp: '203.0.113.7' });
  });

  it('refuses to start with a trust entry that is no address or CIDR', async () => {
    await expect(startServer({ http: { trustProxy: ['not-an-address'] } })).to.be.rejectedWith(/http\.trustProxy entry "not-an-address"/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/client-address.test.ts`
Expected: FAIL to compile: `Property 'peerAddress' does not exist on type 'ISocketHandshake'`.

- [ ] **Step 3: Implement**

Create `packages/http-socket/src/client-address.ts`:

```ts
import type { IncomingHttpHeaders } from 'http';
import { parseTrustProxy, trustedClientAddress } from '@spinajs/http';
import type { ProxyTrust } from '@spinajs/http';

/**
 * authn-http ClientIp's rule ( its `proxyTrustOf` ): `authn.http.trustProxy`, else `http.trustProxy` when the former is null
 * or absent. One rule for the socket, because its address feeds authn's throttle and audit. Throws InvalidOption, naming
 * the key, for an entry that is no address or CIDR.
 */
export function socketProxyTrust(authnTrust: unknown, httpTrust: unknown): ProxyTrust {
  return authnTrust === null || authnTrust === undefined ? parseTrustProxy(httpTrust, 'http.trustProxy') : parseTrustProxy(authnTrust, 'authn.http.trustProxy');
}

/** The peer, or behind trusted proxy hops the X-Forwarded-For entry they vouch for ( SR-03 ). */
export function clientAddressOf(peer: string, headers: Readonly<IncomingHttpHeaders>, trust: ProxyTrust): string {
  return trustedClientAddress(peer, headers['x-forwarded-for'], trust) ?? peer;
}
```

In `packages/http-socket/src/interfaces.ts`, replace

```ts
  /** the socket's remote address; never taken from X-Forwarded-For */
  readonly address: string;
```

with

```ts
  /**
   * The client address: the socket's peer, or behind trusted proxy hops ( `authn.http.trustProxy`, else `http.trustProxy`,
   * as authn-http's ClientIp ) the X-Forwarded-For entry they vouch for. An untrusted peer's header is ignored ( SR-03 ).
   */
  readonly address: string;
  /** the socket's remote address as it connected; never taken from X-Forwarded-For */
  readonly peerAddress: string;
```

In `packages/http-socket/src/connection.ts`, replace

```ts
import { ISocketAuthState, ISocketClientState, ISocketHandshake } from './interfaces.js';
```

with

```ts
import type { ProxyTrust } from '@spinajs/http';
import { ISocketAuthState, ISocketClientState, ISocketHandshake } from './interfaces.js';
import { clientAddressOf } from './client-address.js';
```

and replace

```ts
export function toHandshake(socket: Socket): ISocketHandshake {
  const h = socket.handshake;

  return {
    auth: { ...(h.auth as Record<string, unknown>) },
    headers: h.headers,
    cookies: parseCookies(h.headers.cookie),
    address: h.address,
```

with

```ts
export function toHandshake(socket: Socket, trust: ProxyTrust): ISocketHandshake {
  const h = socket.handshake;

  return {
    auth: { ...(h.auth as Record<string, unknown>) },
    headers: h.headers,
    cookies: parseCookies(h.headers.cookie),
    address: clientAddressOf(h.address, h.headers, trust),
    peerAddress: h.address,
```

In `packages/http-socket/src/server.ts`:

1. Replace

```ts
import { SocketConnection, toHandshake } from './connection.js';
```

with

```ts
import type { ProxyTrust } from '@spinajs/http';
import { SocketConnection, toHandshake } from './connection.js';
import { socketProxyTrust } from './client-address.js';
```

2. Replace

```ts
  @Config('http.shutdownTimeout', { defaultValue: 10_000 })
  protected HttpShutdownTimeout: number;
```

with

```ts
  @Config('http.shutdownTimeout', { defaultValue: 10_000 })
  protected HttpShutdownTimeout: number;

  @Config('authn.http.trustProxy')
  protected AuthnTrustProxy: unknown;

  @Config('http.trustProxy')
  protected HttpTrustProxy: unknown;

  /** the proxy hops that may name the client address */
  protected trust: ProxyTrust = { hops: 0 };
```

3. Replace

```ts
  public async resolve(): Promise<void> {
    await super.resolve();
    assertIdempotencyConfig(this.Options.idempotency);
```

with

```ts
  public async resolve(): Promise<void> {
    await super.resolve();
    this.trust = socketProxyTrust(this.AuthnTrustProxy, this.HttpTrustProxy);
    assertIdempotencyConfig(this.Options.idempotency);
```

4. Replace `      const handshake = toHandshake(socket);` with `      const handshake = toHandshake(socket, this.trust);`.

5. Replace `    const handshake = this.handshakes.get(socket) ?? toHandshake(socket);` with `    const handshake = this.handshakes.get(socket) ?? toHandshake(socket, this.trust);`.

- [ ] **Step 4: Update the hand-built handshakes**

In both `packages/http-socket/test/authn-source.test.ts` and `packages/http-socket/test/revalidation.test.ts`, replace

```ts
cookies: {}, address: '127.0.0.1', url: '/socket.io/'
```

with

```ts
cookies: {}, address: '127.0.0.1', peerAddress: '127.0.0.1', url: '/socket.io/'
```

In `packages/http-socket/test/authn-source.test.ts`, replace

```ts
    it('SR-03 the client address is the socket address, never X-Forwarded-For', async () => {
```

with

```ts
    it('SR-03 without a trusted proxy the client address is the socket address, never X-Forwarded-For', async () => {
```

- [ ] **Step 5: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/client-address.test.ts test/authn-source.test.ts test/revalidation.test.ts test/handshake.test.ts test/handshake-security.test.ts test/origin.test.ts test/recovery.test.ts test/exports.test.ts`
Expected: all passing, 0 failing (client-address: 7 passing).

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/*.test.ts 2>&1 | tail -5 && npx ts-mocha -p tsconfig.json --config .mocharc.authz.json 2>&1 | tail -3`
Expected: main suite = its previous count + 7 passing (B1 + 7 when run before Tasks 1–3), B2 passing, no new failure.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.mjs.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket/tsconfig.cjs.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/http-socket-example/tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/client-address.ts packages/http-socket/src/interfaces.ts packages/http-socket/src/connection.ts packages/http-socket/src/server.ts packages/http-socket/test/client-address.test.ts packages/http-socket/test/authn-source.test.ts packages/http-socket/test/revalidation.test.ts && \
git commit -m "feat(http-socket): handshake client address through trusted proxies"
```

---

### Task 5: G6 / W4 Task 9 — the session-cookie principal source at `@spinajs/authn-http/socket`

**Edits authn-http, an authz-v3 lane package (N8a).** Additive only, see "Decision" above. The tests run the real 3.0 app of `test/v3-app/app.ts` (real login, MFA, role switch, logout, session issuer, resolvers) with a `SocketServer` on its http server, in their own mocha process.

**Files:**
- Modify: `packages/authn-http/src/resolvers/session.ts:39-44` (extract `principalOfSession`)
- Create: `packages/authn-http/src/socket/session-source.ts`, `packages/authn-http/src/socket/index.ts`
- Modify: `packages/authn-http/package.json` (`exports["./socket"]`, `typesVersions`, `peerDependencies`, `peerDependenciesMeta`, `devDependencies`, `scripts.test`)
- Modify: `packages/authn-http/tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json` (reference `http-socket`)
- Modify: `packages/authn-http/.mocharc.json` (ignore `test/v3-socket/**`); Create: `packages/authn-http/.mocharc.v3-socket.json`
- Create: `packages/authn-http/test/v3-socket/support.ts`
- Test: `packages/authn-http/test/v3-socket/session.test.ts`

**Interfaces:**
- Consumes: `SocketPrincipalSource`, `ISocketHandshake` (`handshake.cookies` raw-decoded values, `handshake.address`, `handshake.headers`), `SocketServer`, `AuthnCredentialSource` from `@spinajs/http-socket`; `SessionIssuer.restore(rawId)` from `@spinajs/authn/contracts`; `sessionCookieName`, `appEnvOf`, `assertSessionCookieSecret`, `ISessionCookieConfig` from `@spinajs/authn-session`; `cookie-signature` `unsign`; v3-app helpers `startApp`, `stopApp`, `switchHooksOn`, `useFakes`, `seedUser`, `loggedIn`, `Client`, `roles`, `step`, `tokens`, `config`, `cookieName`, `APP_ORIGIN`.
- Produces:
  - `SessionPrincipalResolver.principalOfSession(session: Restored, ctx: AuthnContext): Promise<Principal | null>` (public);
  - `class SessionSocketPrincipalSource extends SocketPrincipalSource`, `@Injectable(SocketPrincipalSource)`, `name = 'session'`, `order = 40`; inert without a registered `SessionIssuer`; revalidation is the inherited default (restore again: `null` ⇒ `'invalid'`, a throwing store ⇒ `'unavailable'`);
  - import path for apps: `import '@spinajs/authn-http/socket';`
  - `test/v3-socket/support.ts`: `startSockets(revalidateMs: number): Promise<void>`, `stopSockets(): Promise<void>`, `interface SocketOptions { cookie?: string | null; token?: string; origin?: string }`, `socketTo(o?: SocketOptions): ClientSocket`, `closeSockets(): void`, `connected(socket): Promise<void>`, `refusalOf(socket): Promise<SocketError>`, `command<R>(socket, name, payload?): Promise<CommandReply<R>>`, `resultOf<R>(reply): R`, `errorOf(reply): SocketError`, `disconnectNotice(socket, timeoutMs?): Promise<unknown>`.

- [ ] **Step 1: Make the session resolution callable without a request**

In `packages/authn-http/src/resolvers/session.ts`, replace

```ts
  public async resolve(req: Request, _credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined> {
    const session = req.storage.AuthnSession;
    if (!session) return undefined;
    if (session.handle.state !== 'active') return null;
```

with

```ts
  public async resolve(req: Request, _credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined> {
    const session = req.storage.AuthnSession;
    if (!session) return undefined;
    return this.principalOfSession(session, ctx);
  }

  /** The principal of a restored session without an http request: `@spinajs/authn-http/socket` resolves socket sessions with it. */
  public async principalOfSession(session: Restored, ctx: AuthnContext): Promise<Principal | null> {
    if (session.handle.state !== 'active') return null;
```

The rest of the old method body (impersonation, `endRefused`, `ActiveRole` ceiling) stays as it is and now closes `principalOfSession`.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json 2>&1 | tail -3 && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json 2>&1 | tail -3`
Expected: B4 and B3 passing, 0 failing: `resolve()` behaves as before (the v3-app login, MFA, role-switch and impersonation suites go through it). The package `.mocharc.json` names its own spec, so a positional file would not narrow the main run; run the whole process.

- [ ] **Step 2: Plumbing for the subpath and the separate test process**

In `packages/authn-http/package.json`, replace

```json
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    }
  },
```

with

```json
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    },
    "./socket": {
      "types": "./lib/mjs/socket/index.d.ts",
      "import": "./lib/mjs/socket/index.js",
      "require": "./lib/cjs/socket/index.js"
    }
  },
  "typesVersions": {
    "*": {
      "socket": [
        "lib/cjs/socket/index.d.ts"
      ]
    }
  },
```

replace

```json
    "test": "ts-mocha -p tsconfig.json && ts-mocha -p tsconfig.json --config .mocharc.v3-app.json",
```

with

```json
    "test": "ts-mocha -p tsconfig.json && ts-mocha -p tsconfig.json --config .mocharc.v3-app.json && ts-mocha -p tsconfig.json --config .mocharc.v3-socket.json",
```

and replace

```json
  "devDependencies": {
    "@spinajs/authn-testing": "3.0.0-alpha.0",
    "@spinajs/fs": "2.0.549",
    "@spinajs/intl": "2.0.549",
    "@spinajs/orm-sqlite": "2.0.549",
    "@types/uuid": "^9.0.0"
  }
```

with

```json
  "peerDependencies": {
    "@spinajs/http-socket": "2.0.549"
  },
  "peerDependenciesMeta": {
    "@spinajs/http-socket": {
      "optional": true
    }
  },
  "devDependencies": {
    "@spinajs/authn-testing": "3.0.0-alpha.0",
    "@spinajs/fs": "2.0.549",
    "@spinajs/http-socket": "2.0.549",
    "@spinajs/intl": "2.0.549",
    "@spinajs/orm-sqlite": "2.0.549",
    "@types/uuid": "^9.0.0",
    "socket.io-client": "^4.8.1"
  }
```

In `packages/authn-http/tsconfig.json` replace `{ "path": "../queue/tsconfig.json" }]` with `{ "path": "../queue/tsconfig.json" }, { "path": "../http-socket/tsconfig.json" }]`; in `tsconfig.mjs.json` replace `{ "path": "../queue/tsconfig.mjs.json" }]` with `{ "path": "../queue/tsconfig.mjs.json" }, { "path": "../http-socket/tsconfig.mjs.json" }]`; in `tsconfig.cjs.json` replace `{ "path": "../queue/tsconfig.cjs.json" }]` with `{ "path": "../queue/tsconfig.cjs.json" }, { "path": "../http-socket/tsconfig.cjs.json" }]`. (`http-socket` references no authn-http, so there is no cycle.)

In `packages/authn-http/.mocharc.json`, replace

```json
  "ignore": [
    "test/v3-app/**",
    "test/legacy-v2/**"
  ],
```

with

```json
  "ignore": [
    "test/v3-app/**",
    "test/v3-socket/**",
    "test/legacy-v2/**"
  ],
```

Create `packages/authn-http/.mocharc.v3-socket.json`:

```json
{
  "extensions": [
    "ts"
  ],
  "spec": [
    "test/v3-socket/**/*.test.ts"
  ],
  "node-option": [
    "experimental-specifier-resolution=node",
    "loader=ts-node/esm"
  ]
}
```

The socket suites get their own process so that `switchHooksOn()` (permanent) and the `@spinajs/http-socket` import never reach the account and behaviour suites of `.mocharc.v3-app.json`.

- [ ] **Step 3: Write the socket test support**

Create `packages/authn-http/test/v3-socket/support.ts`:

```ts
import { io } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { PROTOCOL_VERSION, SYSTEM_EVENTS, SocketDispatcher, SocketHandlerRegistry, SocketHub, SocketPrincipalGuard, SocketServer, WIRE_EVENTS } from '@spinajs/http-socket';
import type { CommandReply, CommandRequest, EventFrame, SocketError } from '@spinajs/http-socket';

import { APP_ORIGIN, config, cookieName } from '../v3-app/app.js';

/** Attaches a SocketServer to the running v3 app's http server ( HttpServerHost ); `revalidateMs` short enough to wait out. */
export async function startSockets(revalidateMs: number): Promise<void> {
  const cfg = config();
  if (cfg.get('http.socket.path') === undefined) {
    throw new Error('http.socket is not configured: build packages/http-socket, whose lib/mjs/config holds its defaults');
  }
  cfg.set(['http', 'socket', 'auth', 'revalidateMs'], revalidateMs);
  await DI.resolve(SocketServer);
}

/** Closes the socket server and forgets its singletons, so the next suite starts one on a fresh app. */
export async function stopSockets(): Promise<void> {
  await DI.get(SocketServer)?.dispose();
  for (const type of [SocketServer, SocketHub, SocketDispatcher, SocketPrincipalGuard, SocketHandlerRegistry] as Class<unknown>[]) {
    DI.uncache(type);
  }
}

export interface SocketOptions {
  /** the signed session cookie value, as `Client.cookie` holds it */
  cookie?: string | null;
  /** sent as `auth.token`, as a browser client sends a bearer token */
  token?: string;
  origin?: string;
}

const opened: ClientSocket[] = [];
let clients = 0;
let ids = 0;

export function socketTo(o: SocketOptions = {}): ClientSocket {
  const headers: Record<string, string> = {};
  if (o.cookie) headers.cookie = `${cookieName()}=${encodeURIComponent(o.cookie)}`;
  if (o.origin) headers.origin = o.origin;

  const socket = io(APP_ORIGIN, {
    path: config().get<string>('http.socket.path'),
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { protocol: PROTOCOL_VERSION, clientId: `v3-socket-${++clients}`, ...(o.token ? { token: o.token } : {}) },
    extraHeaders: headers,
  });
  opened.push(socket);
  return socket;
}

export function closeSockets(): void {
  opened.splice(0).forEach((s) => s.close());
}

export function connected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
}

/** The SocketError of a refused handshake; fails when the handshake is accepted. */
export function refusalOf(socket: ClientSocket): Promise<SocketError> {
  return connected(socket).then(
    () => {
      throw new Error('the handshake was accepted');
    },
    (err: { data: SocketError }) => err.data,
  );
}

export function command<R = unknown>(socket: ClientSocket, name: string, payload: unknown = null): Promise<CommandReply<R>> {
  const request: CommandRequest = { id: `v3-socket-cmd-${++ids}`, name, payload };
  return socket.timeout(5000).emitWithAck(WIRE_EVENTS.command, request) as Promise<CommandReply<R>>;
}

export function resultOf<R>(reply: CommandReply<R>): R {
  if (!reply.ok || !('result' in reply)) {
    throw new Error(`expected a result reply, got ${JSON.stringify(reply)}`);
  }
  return reply.result;
}

export function errorOf(reply: CommandReply): SocketError {
  if (reply.ok) {
    throw new Error(`expected an error reply, got ${JSON.stringify(reply)}`);
  }
  return reply.error;
}

/** The payload of the `sys.disconnect` notice the server sends before it closes the socket. */
export function disconnectNotice(socket: ClientSocket, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${SYSTEM_EVENTS.disconnect} within ${timeoutMs} ms`)), timeoutMs);
    socket.on(WIRE_EVENTS.event, (frame: EventFrame) => {
      if (frame.name === SYSTEM_EVENTS.disconnect) {
        clearTimeout(timer);
        resolve(frame.payload);
      }
    });
  });
}
```

- [ ] **Step 4: Write the failing test**

Create `packages/authn-http/test/v3-socket/session.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import { AuthnCredentialSource, BaseSocketController, Command, Connection, SocketConnection, SocketController } from '@spinajs/http-socket';

import { SessionSocketPrincipalSource } from '../../src/socket/index.js';
import { Client, loggedIn, roles, seedUser, startApp, step, stopApp, switchHooksOn, tokens, useFakes } from '../v3-app/app.js';
import { closeSockets, command, connected, disconnectNotice, refusalOf, resultOf, socketTo, startSockets, stopSockets } from './support.js';
import type { SocketOptions } from './support.js';

@SocketController('sess')
export class SocketSessionProbe extends BaseSocketController {
  @Command('who')
  public async who(@Connection() conn: SocketConnection) {
    return { type: conn.principal.type, id: conn.principal.id, source: conn.auth.source, roles: conn.principal.ceiling?.roles ?? null };
  }
}

const UNATTENDED_WHO = { type: 'unattended', id: 'unattended', source: null, roles: null };

async function who(o: SocketOptions) {
  const socket = socketTo(o);
  await connected(socket);
  return { socket, who: resultOf(await command(socket, 'sess.who')) };
}

async function bearerFor(): Promise<{ id: string; token: string }> {
  const u = await seedUser();
  const token = `spt_${randomUUID()}`;
  tokens.set(token, u.ref);
  return { id: u.ref.id, token };
}

describe('@spinajs/authn-http/socket: session cookie source (G6)', function () {
  this.timeout(60000);

  before(async () => {
    useFakes();
    await startApp();
    await switchHooksOn();
    await startSockets(200);
  });

  after(async () => {
    closeSockets();
    await stopSockets();
    await stopApp();
  });

  afterEach(() => {
    closeSockets();
    sinon.restore();
  });

  it('connects an active session cookie as its user', async () => {
    const u = await seedUser();
    const c = await loggedIn(u);

    expect((await who({ cookie: c.cookie })).who).to.deep.equal({ type: 'user', id: u.ref.id, source: 'session', roles: null });
  });

  it('runs before the bearer source: an active session wins over a bearer token, as in http', async () => {
    expect(new SessionSocketPrincipalSource().order).to.be.below(new AuthnCredentialSource().order);
    const u = await seedUser();
    const c = await loggedIn(u);
    const { token } = await bearerFor();

    expect((await who({ cookie: c.cookie, token })).who).to.deep.include({ id: u.ref.id, source: 'session' });
  });

  it('SR-07 gives no principal for a pending session, and a bearer token is still tried', async () => {
    const u = await seedUser();
    step.enrol(u.ref);
    const c = new Client();
    expect((await c.post('/auth/login', { login: u.login, password: u.password })).status).to.eq(200);
    const other = await bearerFor();

    expect((await who({ cookie: c.cookie })).who).to.deep.equal(UNATTENDED_WHO);
    expect((await who({ cookie: c.cookie, token: other.token })).who).to.deep.include({ id: other.id, source: 'authn' });
  });

  it('sets ceiling.roles to the ActiveRole of a role switch', async () => {
    const u = await seedUser();
    await roles.grant(u.ref, [{ role: 'editor', requirePassword: false }]);
    const c = await loggedIn(u);
    expect((await c.post('/auth/active-role', { role: 'editor' })).status).to.eq(200);

    expect((await who({ cookie: c.cookie })).who).to.deep.equal({ type: 'user', id: u.ref.id, source: 'session', roles: ['editor'] });
  });

  it('ignores a forged cookie without asking the session store', async () => {
    const restore = sinon.spy((await DI.resolve(SessionIssuer)) as SessionIssuer, 'restore');

    expect((await who({ cookie: 'raw-session-id.forged-signature' })).who).to.deep.equal(UNATTENDED_WHO);
    expect(restore.calledWith('raw-session-id')).to.eq(false);
  });

  it('SR-12 refuses a cross-origin handshake carrying the session cookie before the source runs', async () => {
    const c = await loggedIn(await seedUser());
    const restore = sinon.spy((await DI.resolve(SessionIssuer)) as SessionIssuer, 'restore');

    expect(await refusalOf(socketTo({ cookie: c.cookie, origin: 'https://evil.example' }))).to.deep.include({ code: 'forbidden', message: 'origin not allowed' });
    expect(restore.calledWith(c.sessionId!)).to.eq(false);
  });

  it('SR-08 closes the socket of a session that logout ended, at the next revalidation', async () => {
    const c = await loggedIn(await seedUser());
    const { socket } = await who({ cookie: c.cookie });
    const notice = disconnectNotice(socket);

    expect((await c.post('/auth/logout')).status).to.eq(200);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
  });

  it('closes a socket whose session id a role switch rotated; the new cookie connects', async () => {
    const u = await seedUser();
    await roles.grant(u.ref, [{ role: 'editor', requirePassword: false }]);
    const c = await loggedIn(u);
    const { socket } = await who({ cookie: c.cookie });
    const notice = disconnectNotice(socket);

    expect((await c.post('/auth/active-role', { role: 'editor' })).status).to.eq(200);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    expect((await who({ cookie: c.cookie })).who).to.deep.include({ id: u.ref.id, roles: ['editor'] });
  });
});
```

- [ ] **Step 5: Run it to see it fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-socket.json`
Expected: FAIL with `Cannot find module '../../src/socket/index.js'`.

- [ ] **Step 6: Implement the source**

Create `packages/authn-http/src/socket/session-source.ts`:

```ts
import * as cs from 'cookie-signature';
import { Autoinject, Container, DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Log, Logger } from '@spinajs/log';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, Principal } from '@spinajs/authn/contracts';
import { appEnvOf, assertSessionCookieSecret, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { SocketPrincipalSource } from '@spinajs/http-socket';
import type { ISocketHandshake } from '@spinajs/http-socket';

import { SessionPrincipalResolver } from '../resolvers/session.js';

/**
 * The browser session cookie as a socket principal: AuthnMiddleware's restore and SessionPrincipalResolver for a handshake.
 * Order 40, before AuthnCredentialSource ( 50 ): an active session wins over bearer credentials, as in http. A pending
 * session, or an unknown, ended or forged cookie, gives null, so a bearer token is still tried ( SR-07 ). http-socket
 * refuses a cross-site handshake before any source runs ( SR-12 ). Revalidation restores the session again, so logout,
 * revocation or an id rotation closes the socket.
 */
@Injectable(SocketPrincipalSource)
export class SessionSocketPrincipalSource extends SocketPrincipalSource {
  public readonly name = 'session';
  public readonly order = 40;

  @Autoinject(Container)
  protected Container!: IContainer;

  // appEnvOf reads the Configuration's Env for the SR-16 "no env named" rule, which @Config cannot give
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Config('http.cookie.secret')
  protected CookieSecret: string;

  @Config('authn.session.cookie')
  protected SessionCookie: ISessionCookieConfig | undefined;

  @Logger('authn-http')
  protected Log!: Log;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    // inert until the 3.0 session layer is registered, as AuthnCredentialSource is without an AuthnService
    if (!DI.check(SessionIssuer)) {
      return null;
    }

    const rawId = this.sessionId(handshake);
    if (rawId === null) {
      return null;
    }

    const session = await (await this.Container.resolve(SessionIssuer)).restore(rawId);
    if (!session) {
      return null;
    }

    const resolver = await this.Container.resolve(SessionPrincipalResolver);
    return resolver.principalOfSession(session, this.context(handshake));
  }

  /** The raw session id from the signed cookie; null when it is absent, unsigned or forged. */
  protected sessionId(handshake: ISocketHandshake): string | null {
    const env = appEnvOf(this.Configuration);
    const value = handshake.cookies[sessionCookieName(this.SessionCookie ?? {}, env)];
    if (typeof value !== 'string' || value === '') {
      return null;
    }

    assertSessionCookieSecret(this.CookieSecret, env);
    // @spinajs/http signs by hand ( cs.sign ); express res.cookie({ signed: true }) adds an `s:` prefix
    const id = cs.unsign(value.startsWith('s:') ? value.slice(2) : value, this.CookieSecret);
    if (id === false || id === '') {
      this.Log.warn('Rejected a socket session cookie with an invalid signature', { Ip: handshake.address });
      return null;
    }

    return id;
  }

  protected context(handshake: ISocketHandshake): AuthnContext {
    const userAgent = handshake.headers['user-agent'];
    return { ip: handshake.address, ...(typeof userAgent === 'string' ? { userAgent } : {}), now: new Date(), purpose: 'request' };
  }
}
```

Create `packages/authn-http/src/socket/index.ts`:

```ts
export { SessionSocketPrincipalSource } from './session-source.js';
```

Do not import `./socket` from `packages/authn-http/src/index.ts`.

- [ ] **Step 7: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-socket.json`
Expected: 8 passing, 0 failing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json 2>&1 | tail -3`
Expected: B3 passing, 0 failing (the v3-app process does not load the socket files).

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/authn-http/tsconfig.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/authn-http/tsconfig.mjs.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/authn-http/tsconfig.cjs.json && git diff --quiet -- packages/authn-http/src/index.ts && echo ROOT-UNTOUCHED`
Expected: exit 0 and `ROOT-UNTOUCHED`. (`--noEmit -p` reads http-socket's built `lib/` d.ts and does not rebuild it.)

- [ ] **Step 8: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/authn-http/src/resolvers/session.ts packages/authn-http/src/socket/session-source.ts packages/authn-http/src/socket/index.ts packages/authn-http/package.json packages/authn-http/tsconfig.json packages/authn-http/tsconfig.mjs.json packages/authn-http/tsconfig.cjs.json packages/authn-http/.mocharc.json packages/authn-http/.mocharc.v3-socket.json packages/authn-http/test/v3-socket/support.ts packages/authn-http/test/v3-socket/session.test.ts && \
git commit -m "feat(authn-http): session-cookie socket principal source at @spinajs/authn-http/socket"
```

---

### Task 6: G5 — authn end to end and the 3.0 authn-http policies on sockets

**Files:**
- Modify: `packages/authn-http/src/socket/index.ts`
- Test: `packages/authn-http/test/v3-socket/authn.test.ts`

**Interfaces:**
- Consumes: Task 1's `details.error` mapping (through a rebuilt http-socket `lib/`), Task 5's source, support and process; `Authenticated`, `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy` (`src/policies/v3/principal.ts`), `MfaSatisfied` (`src/policies/v3/mfa.ts`); v3-app `tokens` (`FakeStrategy.bearer`), `loggedInAal2`.
- Produces: `@spinajs/authn-http/socket` exports exactly `Authenticated`, `MfaSatisfied`, `NoImpersonationPolicy`, `NoTokenAuthPolicy`, `NotLoggedPolicy`, `SessionSocketPrincipalSource`.

- [ ] **Step 1: Rebuild the http-socket lib**

Only when Tasks 1–4 are committed and nobody is mid-edit in `packages/http-socket/src` (`git status --short -- packages/http-socket/src` empty):

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket/tsconfig.mjs.json packages/http-socket/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs && grep -c "bodyDetails" packages/http-socket/lib/mjs/errors.js`
Expected: exit 0 and a count of at least 1.

- [ ] **Step 2: Write the failing test**

Create `packages/authn-http/test/v3-socket/authn.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseSocketController, Command, Connection, SocketConnection, SocketController, SocketPolicy } from '@spinajs/http-socket';
import type { Socket as ClientSocket } from 'socket.io-client';

import * as socketApi from '../../src/socket/index.js';
import { Authenticated, MfaSatisfied, NoImpersonationPolicy, NoTokenAuthPolicy, NotLoggedPolicy } from '../../src/socket/index.js';
import * as v3 from '../../src/v3/index.js';
import { loggedIn, loggedInAal2, seedUser, startApp, stopApp, switchHooksOn, tokens, useFakes } from '../v3-app/app.js';
import { closeSockets, command, connected, disconnectNotice, errorOf, refusalOf, resultOf, socketTo, startSockets, stopSockets } from './support.js';
import type { SocketOptions } from './support.js';

@SocketController('authnsock')
export class SocketAuthnProbe extends BaseSocketController {
  @Command('who')
  public async who(@Connection() conn: SocketConnection) {
    return { type: conn.principal.type, id: conn.principal.id, source: conn.auth.source };
  }

  @Command('authenticated')
  @SocketPolicy(Authenticated)
  public async authenticated() {
    return 'ok';
  }

  @Command('notLogged')
  @SocketPolicy(NotLoggedPolicy)
  public async notLogged() {
    return 'ok';
  }

  @Command('noToken')
  @SocketPolicy(NoTokenAuthPolicy)
  public async noToken() {
    return 'ok';
  }

  @Command('noImpersonation')
  @SocketPolicy(NoImpersonationPolicy)
  public async noImpersonation() {
    return 'ok';
  }

  @Command('mfa')
  @SocketPolicy(MfaSatisfied)
  public async mfa() {
    return 'ok';
  }
}

async function bearerFor(): Promise<{ id: string; token: string }> {
  const u = await seedUser();
  const token = `spt_${randomUUID()}`;
  tokens.set(token, u.ref);
  return { id: u.ref.id, token };
}

async function opened(o: SocketOptions = {}): Promise<ClientSocket> {
  const socket = socketTo(o);
  await connected(socket);
  return socket;
}

describe('@spinajs/authn-http/socket: authn and the 3.0 authn-http policies on sockets (G5)', function () {
  this.timeout(60000);

  before(async () => {
    useFakes();
    await startApp();
    await switchHooksOn();
    await startSockets(200);
  });

  after(async () => {
    closeSockets();
    await stopSockets();
    await stopApp();
  });

  afterEach(closeSockets);

  it('exports the session source and the five 3.0 policies that work on sockets; the package root does not load it', () => {
    expect(Object.keys(socketApi).sort()).to.deep.equal(['Authenticated', 'MfaSatisfied', 'NoImpersonationPolicy', 'NoTokenAuthPolicy', 'NotLoggedPolicy', 'SessionSocketPrincipalSource']);
    expect(socketApi.NoTokenAuthPolicy).to.equal(v3.NoTokenAuthPolicy);
    expect(readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')).to.not.match(/\.\/socket\//);
  });

  describe('bearer tokens through the real AuthnService', () => {
    it('connects a valid API token as its identity: authn-http bearer extractor, AuthnService, token strategy', async () => {
      const { id, token } = await bearerFor();

      expect(resultOf(await command(await opened({ token }), 'authnsock.who'))).to.deep.equal({ type: 'user', id, source: 'authn' });
    });

    it('A02 refuses an unknown or revoked token with the one answer', async () => {
      expect(await refusalOf(socketTo({ token: `spt_${randomUUID()}` }))).to.deep.equal({ code: 'unauthenticated', message: 'authentication failed', retryable: false });
    });

    it('leaves a token that is not ours ( no authn.token.prefix ) unread: UNATTENDED', async () => {
      expect(resultOf(await command(await opened({ token: 'someone-elses-token' }), 'authnsock.who'))).to.deep.equal({ type: 'unattended', id: 'unattended', source: null });
    });

    it('SR-08 closes an open socket at the next revalidation once its token is revoked', async () => {
      const { token } = await bearerFor();
      const socket = await opened({ token });
      const notice = disconnectNotice(socket);

      tokens.delete(token);
      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    });
  });

  describe('the 3.0 authn-http policies as @SocketPolicy', () => {
    it('Authenticated passes a token principal and answers UNATTENDED unauthenticated', async () => {
      expect(resultOf(await command(await opened({ token: (await bearerFor()).token }), 'authnsock.authenticated'))).to.equal('ok');
      expect(errorOf(await command(await opened(), 'authnsock.authenticated'))).to.deep.include({ code: 'unauthenticated', details: { error: 'unauthenticated' } });
    });

    it('NotLoggedPolicy passes UNATTENDED and refuses an authenticated caller', async () => {
      expect(resultOf(await command(await opened(), 'authnsock.notLogged'))).to.equal('ok');
      expect(errorOf(await command(await opened({ token: (await bearerFor()).token }), 'authnsock.notLogged'))).to.deep.include({ code: 'forbidden', details: { error: 'already_authenticated' } });
    });

    it('NoTokenAuthPolicy refuses a token principal and passes a session principal', async () => {
      expect(errorOf(await command(await opened({ token: (await bearerFor()).token }), 'authnsock.noToken'))).to.deep.include({ code: 'forbidden', details: { error: 'session_required' } });
      const c = await loggedIn(await seedUser());
      expect(resultOf(await command(await opened({ cookie: c.cookie }), 'authnsock.noToken'))).to.equal('ok');
    });

    it('NoImpersonationPolicy passes a session and refuses an impersonation session', async () => {
      const own = await loggedIn(await seedUser());
      expect(resultOf(await command(await opened({ cookie: own.cookie }), 'authnsock.noImpersonation'))).to.equal('ok');

      const target = await seedUser();
      const admin = await loggedInAal2(await seedUser());
      expect((await admin.post('/auth/impersonate', { target: target.ref.id })).status).to.eq(200);
      expect(errorOf(await command(await opened({ cookie: admin.cookie }), 'authnsock.noImpersonation'))).to.deep.include({ code: 'forbidden', details: { error: 'impersonating' } });
    });

    it('MfaSatisfied passes an aal2 session and answers UNATTENDED unauthenticated', async () => {
      const c = await loggedInAal2(await seedUser());
      expect(resultOf(await command(await opened({ cookie: c.cookie }), 'authnsock.mfa'))).to.equal('ok');
      expect(errorOf(await command(await opened(), 'authnsock.mfa'))).to.deep.include({ code: 'unauthenticated', details: { error: 'unauthenticated' } });
    });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-socket.json`
Expected: FAIL to compile: `Module '"../../src/socket/index.js"' has no exported member 'Authenticated'` (and the four other policies).

- [ ] **Step 4: Re-export the socket-usable 3.0 policies**

Replace `packages/authn-http/src/socket/index.ts` with:

```ts
export { SessionSocketPrincipalSource } from './session-source.js';
// The 3.0 classes: until N8c the package root still exports the 2.x NotLoggedPolicy, NoTokenAuthPolicy and NoImpersonationPolicy.
// NoSession, FreshAuth and PendingMfaEnrolment read req.storage.AuthnSession, which no socket call carries.
export { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, NotLoggedPolicy } from '../policies/v3/principal.js';
export { MfaSatisfied } from '../policies/v3/mfa.js';
```

- [ ] **Step 5: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-socket.json`
Expected: 18 passing (8 session + 10 authn), 0 failing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/authn-http/tsconfig.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/authn-http/tsconfig.mjs.json && node node_modules/typescript-7/lib/tsc.js --noEmit -p packages/authn-http/tsconfig.cjs.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/authn-http/src/socket/index.ts packages/authn-http/test/v3-socket/authn.test.ts && \
git commit -m "test(authn-http): authn and the 3.0 authn-http policies on sockets, end to end"
```

---

### Task 7: Docs, full build, every affected suite

**Files:**
- Modify: `packages/http-socket/README.md` ("The command pipeline", "Authentication and access")
- Modify: `packages/http-socket/RELEASE_NOTES.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: README — pipeline**

In `packages/http-socket/README.md`, replace

```md
9. **Policies.** `@SocketPolicy` / `@SocketAccess` answer `unauthenticated` or `forbidden`.
10. **Arguments.** Extraction and ajv validation answer `invalid_argument`, with the validation errors in `details`.
11. **Handler.** It runs with an `AbortSignal`.
```

with

```md
9. **Policies.** `@SocketPolicy` / `@SocketAccess` answer `unauthenticated` or `forbidden`.
10. **Access fields.** `@SocketAccess(…, { fields: 'filter' })` limits the result, or each stream chunk, to the fields the decision lets the caller read.
11. **Arguments.** The `ArgInputFilter`s, then extraction and ajv validation, answer `invalid_argument`, with the validation errors or the refused fields in `details`.
12. **Handler.** It runs with an `AbortSignal`.
```

- [ ] **Step 2: README — authentication and access**

Replace

```md
- **Built-in source.** `AuthnCredentialSource` (order 50) authenticates bearer tokens, keys and signatures through `@spinajs/authn`. The client sends a token as `auth.token`, because browsers cannot set WebSocket headers. Cookies are never read by this source.
```

with

```md
- **Built-in source.** `AuthnCredentialSource` (order 50) authenticates bearer tokens, keys and signatures through `@spinajs/authn`. The client sends a token as `auth.token`, because browsers cannot set WebSocket headers. Cookies are never read by this source.
- **Session cookie.** `import '@spinajs/authn-http/socket'` registers `SessionSocketPrincipalSource` (order 40). It reads the signed session cookie of `@spinajs/authn-http` and resolves the session as http does: an active session wins over bearer credentials, `ActiveRole` becomes `ceiling.roles`, impersonation and banned identities behave as in http, and a pending (pre-MFA) session is no principal. Logout, revocation and every session id rotation (login, role switch, impersonation) close the socket at its next revalidation; the client reconnects with the new cookie. Prefer `transports: ['websocket']` with cookies: browsers always send `Origin` on a WebSocket upgrade.
```

Replace

```md
- **Revalidation.** Live connections re-check their principal every `http.socket.auth.revalidateMs` (60 s), and `ceiling.expiresAt` is always enforced. A revoked credential gets `unauthenticated`, and the server closes the connection with `sys.disconnect { reason: 'unauthenticated' }`.
```

with

```md
- **Revalidation.** Live connections re-check their principal every `http.socket.auth.revalidateMs` (60 s), and `ceiling.expiresAt` is always enforced. A revoked credential gets `unauthenticated`, and the server closes the connection with `sys.disconnect { reason: 'unauthenticated' }`.
- **Behind proxies.** `handshake.address` is the client address: the socket's peer, or behind trusted proxy hops (`authn.http.trustProxy`, else `http.trustProxy`, as authn-http's `ClientIp`) the `X-Forwarded-For` entry they vouch for. `handshake.peerAddress` is the raw peer. Without either setting the address is the peer, whatever `X-Forwarded-For` says.
```

Replace

```md
`SignedInPolicy` is a `BasePolicy` of your own. Policies receive an `ISocketPolicyRequest` (`body`, `params`, `storage`, `socketConnection` ...) in place of the express request.
```

with

```md
`SignedInPolicy` is a `BasePolicy` of your own. Policies receive an `ISocketPolicyRequest` (`body`, `params`, `storage`, `socketConnection` ...) in place of the express request.

`@SocketAccess` decides as authz-http's `@Access`. Besides `resource`, `also`, `domain` and `allowAnonymous` it takes:

- `subject: 'load'`: a conditional allow is checked again against the row the domain's `ResourceAdapter` loads; a missing row is denied with `unknown_resource`.
- `fields: 'filter'`: the result, or each chunk of a stream reply, keeps only the fields `decision.fields.read` allows, minus the domain's `fields.neverRead`.
- `unfilteredInput: reason`: the payload skips authz-http's input field filter, as `@UnfilteredInput` does.

A resource extractor that finds nothing answers `invalid_argument`. When a handler and its controller both carry `@SocketAccess`, the handler's decision is the one in `storage.AuthzDecision`. `@SocketAccess` permissions take part in authz's boot checks, so an unregistered permission fails the boot. With `@spinajs/authz-http` loaded, a payload loses the fields its decision does not let the caller write; in `reject` mode the command is answered `invalid_argument` with `details { error: 'fields_not_writable', fields }`. A command without `@SocketAccess` is not filtered.

The 3.0 authn-http policies `Authenticated`, `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy` and `MfaSatisfied`, exported by `@spinajs/authn-http/socket`, work as `@SocketPolicy`. Their refusals carry the stable code in `details.error` (`session_required`, `already_authenticated`, `impersonating` ...). `NoSession`, `FreshAuth` and `PendingMfaEnrolment` read the restored session, which a socket call does not carry: do not use them on sockets.
```

- [ ] **Step 3: Release notes**

In `packages/http-socket/RELEASE_NOTES.md`, replace

```md
- Bearer tokens (`auth.token` or `Authorization`), keys and signatures resolve through `@spinajs/authn` (`AuthnCredentialSource`). Cookies are never a socket credential.
```

with

```md
- Bearer tokens (`auth.token` or `Authorization`), keys and signatures resolve through `@spinajs/authn` (`AuthnCredentialSource`). Cookies are a socket credential only through the opt-in `SessionSocketPrincipalSource` of `@spinajs/authn-http/socket` (order 40); the origin guard refuses cross-site handshakes before any source runs.
```

Replace

```md
- `@SocketAccess(permission, { resource, also, domain, allowAnonymous })` is the socket form of `@Access`. The legacy rbac policies (`LoggedPolicy`, `RbacPolicy`, `TokenPolicy`) are not supported on sockets.
```

with

```md
- `@SocketAccess(permission, { resource, also, domain, allowAnonymous, subject, fields, unfilteredInput })` is the socket form of `@Access`. The legacy rbac policies (`LoggedPolicy`, `RbacPolicy`, `TokenPolicy`) are not supported on sockets.
```

Replace the line

```md
## New
```

with

```md
### authz-v3 follow-ups (G3–G6)

- `ISocketHandshake.address` is now the client address through trusted proxies: the socket's peer, or, when that peer is a trusted proxy hop (`authn.http.trustProxy`, else `http.trustProxy`, the rule of authn-http's `ClientIp`), the `X-Forwarded-For` entry the trusted hops vouch for. Without either setting it is the peer, as before (SR-03). The raw peer is the new required `ISocketHandshake.peerAddress`; a handshake built by hand must set both. `SocketServer` refuses to start with a malformed trust entry (`InvalidOption` naming the key).
- `ISocketAccess` has a required `scope: 'handler' | 'class'`, which `@SocketAccess` sets.
- A `@SocketAccess` resource extractor that returns `null` or `undefined` answers `invalid_argument` "the resource extractor of <command> found no resource". It used to fall back to the type-level resource.
- When a handler and its controller both carry `@SocketAccess`, only the handler's decision is left in `storage.AuthzDecision`, as authz-http keeps only the route's own. Before, the last policy to finish won.
- `@SocketAccess` permissions now feed authz's boot rule 7 (`SocketAccessContributor`): an unregistered permission fails the domain's boot (B02).

## New
```

Replace

```md
### Stream replies (W4)
```

with

```md
### authz-v3 follow-ups (G3–G6)

- **Input filters (G3).** Socket payloads pass through http's `ArgInputFilter`s, as an http body does. With `@spinajs/authz-http` loaded, its `AuthzInputFieldFilter` strips, or in `reject` mode refuses, the payload fields outside `decision.fields.write` and the domain's `fields.neverRead`, using the decision `@SocketAccess` left in the call store (B17). A command without `@SocketAccess` is not filtered; `unfilteredInput: reason` opts one out.
- **Error details.** An error that carries the stable code http puts in its body (own prop `error`) or the refused `fields` answers them in `details`, for every `codeMapping` mapping and `InvalidArgumentMapping`: `forbidden { error: 'session_required' }`, `invalid_argument { error: 'fields_not_writable', fields: ['owner'] }`.
- **`@SocketAccess` on authz-http's rules (G4).** `subject: 'load'` checks a conditional allow again against the row the domain's `ResourceAdapter` loads; a missing row is denied with `unknown_resource`. `fields: 'filter'` limits a result, or each stream chunk, to `decision.fields.read` minus `fields.neverRead` (`AccessFieldsStage`, order `STAGE_ORDER.Policies + 50`). The policy writes authz-http's `AuthzHttpRoute` mark, so a call another policy group admitted still loses `fields.neverRead`. `socketAccessOf(groups)` returns the `@SocketAccess` rule of one scope. Denials never carry a trace: sockets offer no explain.
- **Session cookie (G6).** `import '@spinajs/authn-http/socket'` registers `SessionSocketPrincipalSource`. It restores the signed session cookie of authn-http and resolves it with authn-http's `SessionPrincipalResolver`, so impersonation, banned identities and `ActiveRole` (`ceiling.roles`) behave as in http. A pending (pre-MFA) session is no principal (SR-07). Revalidation restores the session again: logout, revocation or an id rotation (login, role switch, impersonation) closes the socket, and the client reconnects with its new cookie. Each revalidation slides the session's expiry; `maxLifetime` still ends it.
- **authn-http policies (G5).** `Authenticated`, `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy` and `MfaSatisfied` (the 3.0 classes, re-exported by `@spinajs/authn-http/socket`) work as `@SocketPolicy`. `NoSession`, `FreshAuth` and `PendingMfaEnrolment` need the restored session in the call store, which sockets do not have.

### Stream replies (W4)
```

- [ ] **Step 4: Full build in both module systems**

Only while no other agent is mid-edit in the packages it builds.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json && node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.cjs.json && node scripts/generate-packages-for-modules.mjs && ls packages/authn-http/lib/mjs/socket/index.d.ts packages/authn-http/lib/cjs/socket/index.js packages/http-socket/lib/mjs/stages/access-fields.js packages/http-socket/lib/cjs/client-address.js`
Expected: exit 0 and the four files listed.

- [ ] **Step 5: Run every affected suite**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/*.test.ts 2>&1 | tail -5 && npx ts-mocha -p tsconfig.json --config .mocharc.authz.json 2>&1 | tail -3`
Expected: B1 + 29 passing (6 + 9 + 7 + 7), B2 passing, 0 failing (a `durable-e2e` flake that also fails at B1 belongs to the other agent).

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json 2>&1 | tail -3 && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json 2>&1 | tail -3 && npx ts-mocha -p tsconfig.json --config .mocharc.v3-socket.json 2>&1 | tail -3`
Expected: B4 passing, B3 passing, 18 passing; 0 failing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && npm run test --workspace=packages/http-socket-example && npm run test --workspace=packages/http-socket-client 2>&1 | tail -3`
Expected: both green (the example still connects with its demo source; the client is unchanged).

- [ ] **Step 6: Commit the docs**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/README.md packages/http-socket/RELEASE_NOTES.md && \
git commit -m "docs(http-socket): G3-G6 in the README and release notes"
```

Leave `package-lock.json` and every `lib/` unstaged.

---

## Self-review: coverage of the briefs

| Brief requirement | Task |
|---|---|
| G2: B09 socket part, unattended sockets fail closed on scoped models | 0 (verified done by C9; RFC W1-1 moot) |
| G3: the payload passes the same filters at the same point as an http body | already done by L5 in `PayloadArg`; 1 proves it with a test-only filter's refusal |
| G3: `AuthzInputFieldFilter` strips fields outside `decision.fields.write` with the `@SocketAccess` decision; `reject` ⇒ `invalid_argument` | 1 (strip, `neverRead`, untouched without `@SocketAccess`, refusal details) |
| G3: RFC W1-2 if the signature needs express | not needed (`filter(input, parameter, route?)`) |
| G4: anonymous rule, any-of order and reported denial, `env`, `domain` | unchanged parity, kept in 2 |
| G4: `subject: 'load'` | 2 |
| G4: 403 body and trace rules (B23, B41) | body unchanged (`AccessDeniedMapping`); no trace (Q1) |
| G4: delegate if L5 exposed its decision step, else mirror every difference | mirrored (2): extractor-finds-nothing, own decision, input mark, `unfilteredInput`, boot refs (B02) |
| G4: `fields: 'filter'` through the read field set | 3 (results, lists, stream chunks, class rule, no-decision case) |
| G5: client address by `ClientIp`'s trusted-proxy rule without an express request; spoofed header ignored, trusted one honoured | 4 |
| G5: real `AuthnService` with authn-http extractors; valid token connects, revoked refused "authentication failed", revocation ends the socket after `revalidateMs` (SR-08) | 6 (strategy per Q8) |
| G5: `@SocketPolicy(Authenticated)`, `@SocketPolicy(NoTokenAuthPolicy)`; RFC if they need more of the request | 6 (plus `NotLoggedPolicy`, `NoImpersonationPolicy`, `MfaSatisfied`); no RFC; session-reading ones per Q6 |
| G6 / W4 T9: cookie name and secret, `SessionIssuer.restore`, pending ⇒ none (SR-07), `ceiling.roles` from `ActiveRole`, principal through authn's own resolution, revalidation by restore | 5 |
| G6 tests: SR-07, SR-12 cross-origin with cookie refused before the source, revoked session ends the socket | 5 (plus forged cookie, bearer precedence, rotation) |
| W4 T9: `exports["./socket"]`, `typesVersions`, optional peer, tsconfig references, README and release-notes lines | 5, 7 |
| Reuse W1 pieces: `SocketPrincipalSource`, handshake view, guard tri-state, `access.ts`, args stage, stage order, exports snapshot, RELEASE_NOTES | 1–7 |
