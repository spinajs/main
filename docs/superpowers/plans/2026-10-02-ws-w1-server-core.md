# W1 — WebSocket server core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@spinajs/http-socket-common` (the isomorphic wire protocol) and rewrite `@spinajs/http-socket` as a v3 socket.io server with controllers and decorators, a staged command pipeline (spec §5.2 steps 1–4 and 6–10), error mapping, `SocketHub` rooms and push, handshake authentication through the authz-v3 authn contracts, authz-v3 access checks on commands, limits and `http.socket` config.

**Architecture:** A `SocketServer` attaches socket.io 4.8 to the node http server that a `SocketHttpHost` provides (by default the one inside `@spinajs/http`'s `HttpServer`). The handshake checks the origin and the protocol version, then asks DI-registered `SocketPrincipalSource`s (the socket form of authz-http's `PrincipalSource`) for an authz-v3 `Principal`. The built-in `AuthnCredentialSource` resolves one through `@spinajs/authn/contracts` (`CredentialExtractor`, `AuthnService`). Without one, the connection runs as `UNATTENDED` (plan C9's default). Every `cmd` goes through a `SocketDispatcher` that runs DI-registered `SocketCommandStage`s in `Order` (size → rate → in-flight → authentication → lookup → [W3 idempotency] → policies → arguments → ordering) as an onion chain. The whole chain runs inside the shared DI `AsyncLocalStorage` with the principal under `Principal`, the key authz-v3's `AuthzService.current()` reads. The call then races an `AbortSignal` (deadline, cancel, disconnect, shutdown). `@SocketAccess` decides through `AuthzService.check`, as authz-http's `@Access` does for routes. Errors become one `SocketError` shape through `@HandleSocketException` mappings, which are looked up along the prototype chain.

**Tech Stack:** TypeScript (repo `tsconfig.json`, decorators with `emitDecoratorMetadata`), socket.io 4.8 (`socket.io`, and `socket.io-client` in tests only), `@spinajs/di`, `@spinajs/configuration`, `@spinajs/http` (reused: `BasePolicy`, `resolveRoutePolicies`, `createPolicyGate`, `extractSchemaFromRuntimeType`, `ArgHydrator`, `HttpServer`), `@spinajs/authz` (contracts only: `AuthzService`, `AuthzDomains`, `Principal`, `UNATTENDED`, `principalKey`, `parsePermission`, `AccessDenied`, `Unauthenticated`, `Decision`), `@spinajs/authn/contracts` (`AuthnService`, `CredentialExtractor`, `SignedRequest`, `AuthnContext`, `IAuthnPrincipalStorage`), `@spinajs/validation` (ajv `DataValidator`), `@spinajs/log`, `@spinajs/reflection`, `@spinajs/telemetry-common` (`Metrics`), mocha + chai + chai-as-promised + sinon through `ts-mocha`.

Spec: `docs/superpowers/specs/2026-10-02-spinajs-websocket-design.md` (accepted 2026-10-02; §9 owner answers: socket.io stays, the breaking v3 is approved, the package names are approved).

authz-v3: `docs/plans/2026-10-01-authz-v3-design.md` and `docs/plans/2026-10-01-authz-v3-plan.md` (on this branch, from `feat/authz-v3`). Owner decision 2026-10-02: W1 is built on top of `feat/authz-v3`, uses its contracts directly, and absorbs the http-socket parts of authz-v3 lanes L5 and C9. See "Coordination with authz-v3" at the end, and "Gated follow-up tasks" for the work that waits for unmerged authz-v3 lanes.

## Global Constraints

Every task's requirements include this section.

- **Repo / branch.** Worktree `C:\Users\grzch\SourceCodes\Spinajs\websocket-layer`, branch `feat/websocket-layer`, rebased onto `feat/authz-v3` (merged there: F0a, F0b, F1a, F1, F2, F5, F6, F7, D1, P1, P2; **not** merged: F3 engine, F4 host, F7b and every wave-1 lane). Never touch another Spinajs checkout or worktree.
- **Shared worktree.** Another agent executes the W2 (client) plan in this same worktree. Stage only the exact paths a task lists (`git add <paths>`, never `git add -A` / `git add .`). Every commit command checks the branch in the same command: `test "$(git branch --show-current)" = feat/websocket-layer && git add … && git commit …`.
- **authz-v3 working rules apply** (authz-v3 plan §1): `package-lock.json` is never committed (the integrator commits it after the merge); `RELEASE_NOTES.md` belongs to X1, so W1 writes its notes to `packages/http-socket/RELEASE_NOTES.md` (Task 16); W1 edits the root `tsconfig.build.json` / `tsconfig.build.cjs.json` only to add the one `http-socket-common` line each (Task 1), and the integrator carries that line on merge.
- **authz-v3 contracts only.** W1 imports `@spinajs/authz` (contracts) and `@spinajs/authn/contracts`, never `@spinajs/authn`'s root entry, `authz-http`, `authn-http` or `users*`. It resolves `AuthzService`, `AuthzDomains` and `AuthnService` from DI by their abstract tokens; tests register fakes. Nothing in W1 may wait for an unmerged lane; that work is in "Gated follow-up tasks".
- **Transport:** socket.io **4.8** (`"socket.io": "^4.8.1"`, tests `"socket.io-client": "^4.8.1"`).
- **Package names (approved):** `@spinajs/http-socket-common` (new), `@spinajs/http-socket` (v3 rewrite). W2 builds `@spinajs/http-socket-client`. The spec's W4 auth package `@spinajs/rbac-http-socket` no longer fits authz-v3 and is owner question **Q1** (Coordination with authz-v3). W1 creates none of them.
- **Versioning** (authz-v3 convention on this branch): an existing package keeps its current version and X1 sets the 3.0 versions; a new package starts at `3.0.0-alpha.0`. So `@spinajs/http-socket` stays at `"version": "2.0.548"`, `@spinajs/http-socket-common` is `"3.0.0-alpha.0"`, existing internal deps are pinned to `"2.0.548"`, and `@spinajs/authz`, `@spinajs/authn`, `@spinajs/http-socket-common` to `"3.0.0-alpha.0"`. If `packages/di/package.json` carries another version when a task starts (feat/authz-v3 merged a later master release), use that version wherever this plan says `2.0.548`. "v3" names the API generation.
- **`http-socket-common` has zero runtime dependencies and is isomorphic.** No `node:*` imports, no `Buffer`, no DI.
- **`PROTOCOL_VERSION` = `1`.**
- **Wire events:** client→server `cmd` (ack-answered), either direction `evt`, server→client `chunk` | `end` | `fail`, client→server `credit` | `cancel`. System events (sent as `evt` frames): `sys.shutdown {retryAfterMs}` and `sys.disconnect {reason}`.
- **Error codes (exactly these 13):** `invalid_argument`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `failed_precondition`, `unimplemented`, `deadline_exceeded`, `cancelled`, `resource_exhausted`, `unavailable`, `version_mismatch`, `internal`.
- **Spec §5.3 mapping table:**

  | Exception (`@spinajs/exceptions`) | Code | Retryable |
  |---|---|---|
  | `InvalidArgument`, `BadRequest`, `JsonValidationFailed` (+ `ValidationFailed` from `@spinajs/validation`) | `invalid_argument` | no |
  | `AuthenticationFailed` | `unauthenticated` | no |
  | `Forbidden` | `forbidden` | no |
  | `ResourceNotFound` | `not_found` | no |
  | `ResourceDuplicated` | `conflict` | no |
  | `InvalidOperation` | `failed_precondition` | no |
  | `NotSupported`, `MethodNotImplemented` | `unimplemented` | no |
  | deadline / cancel | `deadline_exceeded` / `cancelled` | yes / no |
  | rate and in-flight limits / shutdown | `resource_exhausted` / `unavailable` | yes |
  | size limit | `resource_exhausted` | **no** (see Decision D1) |
  | anything else | `internal` | no; production hides the message, an `errorId` is logged and returned |

- **Config `http.socket` defaults** (spec §5.6). Values are verbatim where the spec gives one:
  - `path` `'/socket.io'`; `cors` `{ origins: [] }` (D15: authz-v3 rule A31, an empty list allows no cross-origin handshake and sends no CORS headers); `pingInterval` `25_000`; `pingTimeout` `20_000`
  - `auth` `{ required: false, revalidateMs: 60_000 }` (D13, D16)
  - `recovery.maxDisconnectionMs` `120_000` (2 min)
  - `maxPayloadBytes` `1024 * 1024` (1 MB)
  - `maxInFlightPerConnection` `32`
  - `rate` `{ perSecond: 50, burst: 100 }`
  - `idempotency` `{ service: 'MemoryIdempotencyStore', ttlMs: 600_000 }` (10 min)
  - `drainMs` `5_000` (5 s)
  - `adapter` `undefined`
  - `system.dirs.socketControllers` `[]`
- **Pipeline order (spec §5.2):** 1 size, 2 rate (token bucket per connection, `retryAfterMs`), 3 in flight (`> maxInFlightPerConnection`), then W1's authentication check (`STAGE_ORDER.Authentication = 350`, D16: expiry and revalidation → `unauthenticated`), 4 lookup (`unimplemented`), 5 idempotency (**W3**, not built here, slot `STAGE_ORDER.Idempotency = 500`), 6 policies (`unauthenticated` / `forbidden`, incl. `@SocketAccess`), 7 arguments (ajv, `invalid_argument` with `details`), 8 ordering (`'connection' | 'client'`), 9 handler with an `AbortSignal` (deadline → `deadline_exceeded`, client cancel → `cancelled`, disconnect / shutdown → `unavailable`), 10 reply. Stages 4–10 run inside the call's `AsyncLocalStorage` store (D14).
- **Stream replies are W4.** W1 only reserves the wire types (`Chunk`, `StreamEnd`, `StreamFail`, `StreamCredit`, `CancelFrame`, and `CommandStreamReply`). A handler that returns an async iterable is answered `unimplemented`.
- **Code style:** English identifiers and comments. Comment only a non-obvious "why". Follow the repo's prettier config (`printWidth 1500`, single quotes, trailing commas). Use ESM imports with `.js` suffixes in `src` and `test`.
- **Tests:** mocha + chai + chai-as-promised + sinon via `ts-mocha -p tsconfig.json`. Each test runs a real server on a random port (`listen(0)`) with a raw `socket.io-client`. The real client is W2.
- **DI registry keys are class NAMES.** Every test-only class (controllers, policies, DTOs, stages) gets a name that is unique across the whole test suite (prefix it with the test file's topic) and is `export`ed, so `noUnusedLocals` does not reject classes declared only for their decorators.

### Decisions this plan takes where the spec is silent or contradicts itself

- **D1. A size-limit refusal is not retryable.** Spec §5.3 says "limits … retryable yes" and §7 asks for `retryAfterMs`. Resending an oversized payload can never succeed, and a W2 durable client would retry it forever. Size therefore answers `resource_exhausted` with `retryable: false` and `details {size, limit}`. Rate answers `retryable: true` with `retryAfterMs` taken from the bucket. In-flight answers `retryable: true` with `retryAfterMs: 100` (`IN_FLIGHT_RETRY_AFTER_MS`).
- **D2. `CommandRequest.deadline` is RELATIVE milliseconds.** It is the time the client is still willing to wait, measured from send, so the client and server clocks never have to agree. The server aborts at `min(receivedAt + deadline, receivedAt + @Command timeoutMs)`.
- **D3. `@SocketPolicy`, not http's `@Policy`; `@SocketAccess`, not authz-http's `@Access`.** `@Policy` writes `@spinajs/http`'s controller descriptor. `FilesystemControllerSource` (`packages/http/src/controller-sources.ts:52`) treats any class carrying that descriptor as an http controller. `BaseController.resolve` (`packages/http/src/base-controller.ts:76`) then throws on its `unknown` route types. A socket controller in a `system.dirs.controllers` folder would therefore break http startup. `@SocketPolicy` keeps the same semantics: the same `BasePolicy` classes, AND inside a group, OR across groups, and controller scope AND route scope. It does so by reusing http's own `resolveRoutePolicies` and `createPolicyGate` (`packages/http/src/route-builder.ts:84,140`).
  - *Re-checked against authz-v3 (2026-10-02).* authz-v3 keeps http's `BasePolicy` gate and its group semantics. L5 task 4 places `@Access` in a policy group "identical to today's `@Permission`", `AccessOptions.also` joins that group (AND), and a separate `@Policy` stays an alternative (OR) (design §11.2, behaviour B23). So reusing the gate stays right.
  - `@Access` itself writes http's descriptor and `ACCESS_DESCRIPTOR` on an http route, and its `AccessPolicy` is still a stub (L5 not merged). So it cannot sit on a socket controller. W1 adds `@SocketAccess(permission, { resource, also, domain, allowAnonymous })`: one group of `SocketAccessPolicy` AND the `also` policies, deciding through the frozen `AuthzService.check` contract (Task 9A). Converging it with L5's `AccessPolicy` is gated task G4.
  - The legacy rbac policies (`LoggedPolicy`, `AuthorizedPolicy`, `RbacPolicy`, `TokenPolicy`) are not supported on sockets: authz-v3 deprecates or removes them, and they read `req.storage` keys (`User`, `Session`, `TokenAuth`) W1 no longer seeds.
- **D4. Step 8 (ordering) is built in W1** as an in-memory `OrderingStage` keyed `connection:<id>` / `client:<clientId>`. The spec lists it under both W1 (§8 "steps … 6–10") and W3 ("ordered commands"). W3 builds durability on top and may replace the stage.
- **D5. A missing or invalid `auth.clientId` refuses the handshake with `invalid_argument`.** Spec §4 lists only `unauthenticated | version_mismatch` as refusals. A missing `auth.protocol` refuses with `version_mismatch`. An origin outside `http.socket.cors.origins` refuses with `forbidden` (D15).
- **D6. Socket.io's `maxHttpBufferSize` is set to `2 × maxPayloadBytes`.** Socket.io closes the whole connection on an oversized frame. The headroom lets step 1 answer `resource_exhausted` up to twice the limit. Above that the transport drops the connection.
- **D7. W1's `dispose()` aborts running commands with `unavailable` at once and closes.** The drain (`sys.shutdown`, `drainMs`) is W3.
- **D8. `ValidationFailed` (`@spinajs/validation`) is mapped too.** It is what `DataValidator.validate` throws (`packages/validation/src/validator.ts:273`). It is not a subclass of `JsonValidationFailed`.
- **D9. Lifecycle hooks (`@OnConnect` / `@OnDisconnect`) run no policies.** Commands wait until every connect hook has finished, so a hook that joins rooms is visible to the first command.
- **D10. The error-mapping registry is module-level, not a DI map value.** `@HandleException` stores into the DI cache (`packages/http/src/decorators.ts:281`), and `DI.clearCache()` silently drops it (see the workaround in `packages/configuration-http/test/configuration.test.ts:23-32`).
- **D11. `SocketPrincipalSource` is the one handshake seam (plan C9's name).** authz-http's `PrincipalSource.authenticate(req: Request)` (`packages/authz-http/src/api.ts:11-15`) takes an express request after authn-http's `AuthnMiddleware` has written `req.storage.AuthnPrincipal`. A handshake has neither, so a thin socket seam is needed. It has the same shape and rule: `name`, `order`, `authenticate(handshake): Promise<Principal | null>`, ascending order, first non-null wins, throw to refuse. It adds `revalidate()` for long-lived connections (D16). It replaces the earlier `SocketAuthenticator` / `ISocketIdentity`: the identity record is `Principal.identity`, and no rbac `storage` keys are seeded.
- **D12. Built-in `AuthnCredentialSource` (order 50, the slot of authz-http's `AuthnPrincipalSource`)** uses only `@spinajs/authn/contracts`. It builds a `SignedRequest` from the handshake, asks the DI `CredentialExtractor`s in ascending `order`, then calls `AuthnService.authenticate(credentials, { ip, userAgent, now, purpose: 'request' })` and `principalOf(result)`, so authn's throttle and audit apply (A05, A21).
  - `auth.token` becomes `Authorization: Bearer <token>`: browsers cannot set WebSocket headers.
  - The `Cookie` header is never passed to extractors (SR-12, D15).
  - `ip` is the socket address and never `X-Forwarded-For` (SR-03). Trusted-proxy support waits for N8a's `ClientIp` (gated task G5).
  - Every failure answers one shape, `unauthenticated` "authentication failed" (A02). A throttled failure adds `retryAfterMs`. `mfa_required` is a failure: a pending login is no principal (SR-07).
  - The source is inert (returns null) while no `AuthnService` is registered: N1 has not merged.
- **D13. No principal ⇒ `UNATTENDED`, unless `http.socket.auth.required`.** This is plan C9's documented default and design §14.1: scoped ORM queries in socket handlers fail closed. It is not authz-http's `anonymous` fallback (`authz.principals.anonymous.enabled`), which is an http feature. `auth.required: true` refuses such a handshake with `unauthenticated` "authentication required" (spec §7 Auth row).
- **D14. The principal reaches handlers the way http's does: through the call's AsyncLocalStorage store, not `runAs`.** Every command, event and hook gets a fresh store `{ Principal, AuthnPrincipal, requestId, traceId, spanId, realIp, connectionId, clientId, socketCall }` on the DI-singleton `AsyncLocalStorage` (the instance `http/src/route-builder.ts:250` and `log/src/context.ts:29-31` use).
  - `Principal` is the key of F4's `IAuthzAsyncStorage` (authz-v3 plan F4 task 1; design §4.3 `req.storage.Principal`), so `AuthzService.current()` returns it once F4 lands (gated task G1).
  - `AuthnPrincipal` is `IAuthnPrincipalStorage.AuthnPrincipal`: the principal when a source resolved it, else `null`.
  - The whole stage chain from the first stage on runs inside the store, so policies, `ArgInputFilter` (G3), hydrators and the handler all see the principal.
  - `runAs` is not used per call: F4 audits every `runAs` (B09) and it means "act as someone else"; handlers still call it themselves.
- **D15. Origin guard (SR-12 for sockets).** A browser opens a WebSocket to any origin and sends the user's cookies with it (cross-site WebSocket hijacking), and CORS does not apply to the upgrade. Before any source runs, a handshake whose `Origin` is neither absent (non-browser clients) nor same-origin (`new URL(origin).host === Host`) nor listed exactly in `http.socket.cors.origins` is refused with `forbidden`. A non-empty list also becomes socket.io's `cors: { origin: list, credentials: true }` for the polling transport. There are no wildcards (A31: `*` never with credentials).
- **D16. Live connections re-check their principal (the socket form of SR-06/SR-08).** A socket outlives the credential it opened with. `AuthenticationStage` (Order 350) and the event path call `SocketPrincipalGuard.ensure(connection)`:
  - A principal whose `ceiling.expiresAt` has passed is refused at once.
  - Every `http.socket.auth.revalidateMs` (60 s; `0` turns it off) the guard asks the resolving source's `revalidate()`. The default re-authenticates the current handshake and expects the same `principalKey`. Concurrent calls share one check.
  - A failure answers `unauthenticated` and, after that reply is written (`setImmediate`), disconnects with `sys.disconnect { reason: 'unauthenticated' }`, so the connection stops receiving room pushes.
  - `UNATTENDED` connections are never re-checked.
- **D17. Release notes and lock file follow authz-v3 rule 7 and the shared-file table.** `RELEASE_NOTES.md` belongs to X1 and `package-lock.json` to the integrator. Task 16 writes `packages/http-socket/RELEASE_NOTES.md` and commits no lock file.

---

## File map

`packages/http-socket-common/` (new, Task 1)

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, dotfiles copied from `packages/log-common` | package scaffolding |
| `src/errors.ts` | `ErrorCode`, `ERROR_CODES`, `DEFAULT_RETRYABLE`, `SocketError`, `SocketException`, guards |
| `src/protocol.ts` | `PROTOCOL_VERSION`, `WIRE_EVENTS`, `SYSTEM_EVENTS`, envelopes, guards |
| `src/contract.ts` | `defineContract` and contract typing helpers |
| `src/index.ts` | re-exports |
| `test/common.test.ts` | protocol, errors, guards, contract typing |

`packages/http-socket/` (rewritten)

| File | Task | Responsibility |
|---|---|---|
| `package.json`, `tsconfig*.json` | 2 | v3 dependencies and references |
| `src/config/http-socket.ts` | 2 | shipped `http.socket` defaults |
| `src/interfaces.ts` | 2, 5, 6, 8 | config, handshake, auth state, call storage, descriptor, context types; abstract `SocketPrincipalSource`, `SocketHttpHost`, `SocketArg`, `SocketCommandStage`; `STAGE_ORDER` |
| `src/limits.ts` | 3 | `payloadSize`, `TokenBucket`, `assertPayloadSize`, `assertRate` |
| `src/errors.ts` | 4 | `@HandleSocketException`, mapping registry, default mappings (incl. authz-v3 `AccessDenied`), `SocketErrorMapper` |
| `src/origin.ts` | 5 | `isAllowedOrigin` (D15) |
| `src/connection.ts` | 5 | `SocketConnection` (principal, auth state), `toHandshake`, `parseCookies` |
| `src/hub.ts` | 5, 14 | `SocketHub` (connection registry; then rooms and push) |
| `src/host.ts` | 5 | `HttpServerHost` (default `SocketHttpHost`) |
| `src/server.ts` | 5, 5A, 8, 11, 15 | `SocketServer`: io options, origin guard, principal resolution, connection wiring, dispose |
| `src/authn-source.ts` | 5A | `AuthnCredentialSource`, `credentialRequest`, `AUTHENTICATION_FAILED` (D12) |
| `src/controller.ts` | 6 | `BaseSocketController` |
| `src/args.ts` | 6 | `PayloadArg`, `ConnectionArg`, `SignalArg`, `ReasonArg`, `FromDiArg`, `SocketArgumentResolver` |
| `src/decorators.ts` | 6 | `@SocketController`, `@Command`, `@OnEvent`, `@OnConnect`, `@OnDisconnect`, `@SocketPolicyGroup`, `@SocketPolicy`, `@SocketParameter`, `@Payload`, `@Connection`, `@Signal`, `@Reason`, `@FromDI` |
| `src/registry.ts` | 7 | `SocketHandlerRegistry` (lookup, policy resolution, duplicate checks) |
| `src/context.ts` | 8 | `SocketCommandContext` (abort controller, deadline timer) |
| `src/dispatcher.ts` | 8, 11, 13, 15 | `SocketDispatcher`: command/event/cancel wiring, call storage, stage chain inside the ALS, invoke, reply, hooks |
| `src/stages/{index,lookup,arguments}.ts` | 8 | built-in stages 4 and 7 |
| `src/policies.ts`, `src/stages/policies.ts` | 9 | policy request shim, `SocketPolicyGate`, stage 6 |
| `src/access.ts` | 9A | `@SocketAccess`, `SocketAccessPolicy`, `fromPayload` (D3) |
| `src/stages/limits.ts` | 10 | stages 1–3 |
| `src/principal-guard.ts`, `src/stages/authentication.ts` | 10A | `SocketPrincipalGuard`, `AuthenticationStage` (D16) |
| `src/queue.ts`, `src/stages/ordering.ts` | 12 | `SerialQueue`, stage 8 |
| `src/metrics.ts` | 15 | telemetry metrics |
| `src/index.ts` | every task | exports (+ re-export of `@spinajs/http-socket-common`) |
| `test/harness.ts` | 4, 5 | test configuration, test host and principal source, server/client helpers |
| `test/*.test.ts` | per task | see each task |
| `RELEASE_NOTES.md` | 16 | the break, for X1 to merge into the root notes (D17) |

Root: `tsconfig.build.json`, `tsconfig.build.cjs.json` (Task 1, one line each). No root `RELEASE_NOTES.md` and no `package-lock.json` (D17).

---

### Task 1: `@spinajs/http-socket-common`

W2 depends on this package. **If `packages/http-socket-common/src` already exists when this task starts** (W2 created it from this task's source), diff every file against the code below. If the files are identical, skip to Step 6. If they are not, stop and report.

**Files:**
- Create: `packages/http-socket-common/package.json`
- Create: `packages/http-socket-common/tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`
- Create (copied): `packages/http-socket-common/.eslintignore`, `.eslintrc.cjs`, `.gitignore`, `.npmignore`, `.prettierrc`, `.mocharc.json`
- Create: `packages/http-socket-common/src/errors.ts`, `src/protocol.ts`, `src/contract.ts`, `src/index.ts`
- Test: `packages/http-socket-common/test/common.test.ts`
- Modify: `tsconfig.build.json:12`, `tsconfig.build.cjs.json:12` (insert one line after each, in Step 7)

**Interfaces:**
- Consumes: nothing.
- Produces (exact exports, used by Tasks 2–16 and by W2):
  - `PROTOCOL_VERSION = 1`
  - `MAX_ID_LENGTH = 128`
  - `WIRE_EVENTS { command:'cmd', event:'evt', chunk:'chunk', end:'end', fail:'fail', credit:'credit', cancel:'cancel' }`, `WireEventName`
  - `SYSTEM_EVENTS { shutdown:'sys.shutdown', disconnect:'sys.disconnect' }`, `SystemEventName`
  - `Handshake`, `CommandRequest<P>`, `CommandResultReply<R>`, `CommandStreamReply`, `CommandErrorReply`, `CommandReply<R>`, `EventFrame<P>`, `Chunk<D>`, `StreamEnd`, `StreamFail`, `StreamCredit`, `CancelFrame`, `ShutdownNotice`, `DisconnectNotice`
  - `isCommandRequest(v): v is CommandRequest`, `isEventFrame(v): v is EventFrame`, `isCancelFrame(v): v is CancelFrame`
  - `ErrorCode`, `ERROR_CODES`, `DEFAULT_RETRYABLE`, `SocketError`, `isErrorCode`, `isSocketError`, `SocketExceptionOptions`, `class SocketException extends Error implements SocketError { code; retryable; details?; retryAfterMs?; errorId?; toWire(): SocketError; static fromWire(e): SocketException }`
  - `ContractShape`, `SocketContract<C>`, `defineContract<C>(): SocketContract<C>`, `CommandName<C>`, `CommandPayload<C,N>`, `CommandResult<C,N>`, `EventName<C>`, `EventPayload<C,N>`, `ClientEventName<C>`, `ClientEventPayload<C,N>`, `ContractOf<T>`

- [ ] **Step 1: Scaffold the package**

Create `packages/http-socket-common/package.json`:

```json
{
  "name": "@spinajs/http-socket-common",
  "version": "3.0.0-alpha.0",
  "description": "Wire protocol shared by the spinajs WebSocket server and client: envelopes, error codes, protocol version and contract typing helpers",
  "main": "lib/cjs/index.js",
  "module": "lib/mjs/index.js",
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    }
  },
  "type": "module",
  "sideEffects": false,
  "private": false,
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=16.11"
  },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "rimraf": "./node_modules/rimraf/bin.js",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "test": "ts-mocha -p tsconfig.json test/**/*.test.ts",
    "coverage": "nyc npm run test",
    "build-docs": "rimraf docs && typedoc --options typedoc.json src/",
    "format": "prettier --write \"src/**/*.ts\"",
    "lint": "eslint -c .eslintrc.cjs --ext .ts src --fix",
    "preversion": "npm run lint",
    "version": "npm run format && git add -A src"
  },
  "files": [
    "lib/**/*"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/spinajs/main.git"
  },
  "keywords": [
    "spinajs",
    "websocket",
    "socket.io"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {}
}
```

Create `packages/http-socket-common/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*", "test/**/*"]
}
```

Create `packages/http-socket-common/tsconfig.mjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*"]
}
```

Create `packages/http-socket-common/tsconfig.cjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"]
}
```

Copy the dotfiles:

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
for f in .eslintignore .eslintrc.cjs .gitignore .npmignore .prettierrc .mocharc.json; do cp packages/log-common/$f packages/http-socket-common/$f; done
```

- [ ] **Step 2: Install the workspace and build everything once**

The worktree has no `node_modules` yet. A fresh install also links the new workspace package.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && npm install`
Expected: exits 0. `ls node_modules/@spinajs/http-socket-common` shows `package.json`, because it is a symlink to the workspace folder.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json`
Expected: exits 0. This builds `lib/` of every package, and tests import the dependencies from there. If it fails, stop and report: master must build before this plan can go on.

- [ ] **Step 3: Write the failing test**

Create `packages/http-socket-common/test/common.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import {
  ClientEventName,
  ClientEventPayload,
  CommandName,
  CommandPayload,
  CommandResult,
  ContractOf,
  DEFAULT_RETRYABLE,
  ERROR_CODES,
  ErrorCode,
  EventName,
  EventPayload,
  MAX_ID_LENGTH,
  PROTOCOL_VERSION,
  SYSTEM_EVENTS,
  SocketException,
  WIRE_EVENTS,
  defineContract,
  isCancelFrame,
  isCommandRequest,
  isErrorCode,
  isEventFrame,
  isSocketError,
} from '../src/index.js';

type DocsContract = {
  commands: { 'docs.open': [{ id: string }, { title: string }] };
  events: { 'docs.committed': { rev: number } };
  clientEvents: { 'docs.cursor': { x: number } };
};

describe('http-socket-common', () => {
  describe('protocol constants', () => {
    it('speaks protocol version 1', () => {
      expect(PROTOCOL_VERSION).to.equal(1);
    });

    it('names the wire and system events', () => {
      expect(WIRE_EVENTS).to.deep.equal({ command: 'cmd', event: 'evt', chunk: 'chunk', end: 'end', fail: 'fail', credit: 'credit', cancel: 'cancel' });
      expect(SYSTEM_EVENTS).to.deep.equal({ shutdown: 'sys.shutdown', disconnect: 'sys.disconnect' });
    });
  });

  describe('error codes', () => {
    it('lists the 13 codes of the spec', () => {
      expect(ERROR_CODES).to.deep.equal(['invalid_argument', 'unauthenticated', 'forbidden', 'not_found', 'conflict', 'failed_precondition', 'unimplemented', 'deadline_exceeded', 'cancelled', 'resource_exhausted', 'unavailable', 'version_mismatch', 'internal']);
    });

    it('marks only deadline, limit and shutdown codes retryable by default', () => {
      expect(ERROR_CODES.filter((c) => DEFAULT_RETRYABLE[c])).to.deep.equal(['deadline_exceeded', 'resource_exhausted', 'unavailable']);
    });

    it('recognises error codes and wire errors', () => {
      expect(isErrorCode('forbidden')).to.be.true;
      expect(isErrorCode('teapot')).to.be.false;
      expect(isSocketError({ code: 'forbidden', message: 'no', retryable: false })).to.be.true;
      expect(isSocketError({ code: 'forbidden', message: 'no' })).to.be.false;
      expect(isSocketError(null)).to.be.false;
    });
  });

  describe('SocketException', () => {
    it('is an Error whose retryable flag defaults from its code', () => {
      const err = new SocketException('resource_exhausted', 'slow down', { retryAfterMs: 250 });
      expect(err).to.be.instanceOf(Error);
      expect(err.name).to.equal('SocketException');
      expect(err.retryable).to.be.true;
      expect(new SocketException('forbidden', 'no').retryable).to.be.false;
      expect(new SocketException('forbidden', 'no', { retryable: true }).retryable).to.be.true;
    });

    it('serialises to a wire error without undefined fields', () => {
      expect(new SocketException('forbidden', 'no').toWire()).to.deep.equal({ code: 'forbidden', message: 'no', retryable: false });
      expect(new SocketException('resource_exhausted', 'slow down', { retryAfterMs: 250, details: { limit: 1 }, errorId: 'e1' }).toWire()).to.deep.equal({
        code: 'resource_exhausted',
        message: 'slow down',
        retryable: true,
        retryAfterMs: 250,
        details: { limit: 1 },
        errorId: 'e1',
      });
    });

    it('round-trips through fromWire', () => {
      const wire = { code: 'unavailable' as ErrorCode, message: 'restarting', retryable: true, retryAfterMs: 1000 };
      const err = SocketException.fromWire(wire);
      expect(err).to.be.instanceOf(SocketException);
      expect(err.toWire()).to.deep.equal(wire);
    });
  });

  describe('envelope guards', () => {
    it('accepts well-formed command requests', () => {
      expect(isCommandRequest({ id: 'r1', name: 'docs.open', payload: { id: 'a' } })).to.be.true;
      expect(isCommandRequest({ id: 'r1', name: 'docs.open' })).to.be.true;
      expect(isCommandRequest({ id: 'r1', name: 'docs.open', deadline: 500, idempotencyKey: 'c:1', traceparent: '00-abc' })).to.be.true;
    });

    it('rejects malformed command requests', () => {
      expect(isCommandRequest(null)).to.be.false;
      expect(isCommandRequest({ name: 'x' })).to.be.false;
      expect(isCommandRequest({ id: '', name: 'x' })).to.be.false;
      expect(isCommandRequest({ id: 'x'.repeat(MAX_ID_LENGTH + 1), name: 'x' })).to.be.false;
      expect(isCommandRequest({ id: 'r1', name: '' })).to.be.false;
      expect(isCommandRequest({ id: 'r1', name: 'x', deadline: '5' })).to.be.false;
      expect(isCommandRequest({ id: 'r1', name: 'x', idempotencyKey: 5 })).to.be.false;
    });

    it('checks event and cancel frames', () => {
      expect(isEventFrame({ name: 'docs.cursor', payload: { x: 1 } })).to.be.true;
      expect(isEventFrame({ payload: 1 })).to.be.false;
      expect(isCancelFrame({ id: 'r1' })).to.be.true;
      expect(isCancelFrame({ id: 1 })).to.be.false;
    });
  });

  describe('contracts', () => {
    const contract = defineContract<DocsContract>();

    it('returns a runtime marker that carries no data', () => {
      expect(contract).to.deep.equal({ kind: 'socket-contract' });
    });

    it('derives checked names and payload types', () => {
      const command: CommandName<DocsContract> = 'docs.open';
      const payload: CommandPayload<DocsContract, 'docs.open'> = { id: 'a' };
      const result: CommandResult<DocsContract, 'docs.open'> = { title: 't' };
      const event: EventName<DocsContract> = 'docs.committed';
      const eventPayload: EventPayload<DocsContract, 'docs.committed'> = { rev: 1 };
      const clientEvent: ClientEventName<DocsContract> = 'docs.cursor';
      const clientPayload: ClientEventPayload<DocsContract, 'docs.cursor'> = { x: 1 };
      const inferred: ContractOf<typeof contract> = { commands: { 'docs.open': [{ id: 'a' }, { title: 't' }] }, events: { 'docs.committed': { rev: 1 } }, clientEvents: { 'docs.cursor': { x: 1 } } };
      // @ts-expect-error unknown command names must not type-check
      const unknown: CommandName<DocsContract> = 'docs.nope';
      expect([command, payload, result, event, eventPayload, clientEvent, clientPayload, inferred, unknown]).to.have.length(9);
    });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-common && npx ts-mocha -p tsconfig.json test/common.test.ts`
Expected: FAIL with `Cannot find module '../src/index.js'` (or the ts-node `TS2307` equivalent).

- [ ] **Step 5: Write the implementation**

Create `packages/http-socket-common/src/errors.ts`:

```ts
export type ErrorCode =
  | 'invalid_argument'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'failed_precondition'
  | 'unimplemented'
  | 'deadline_exceeded'
  | 'cancelled'
  | 'resource_exhausted'
  | 'unavailable'
  | 'version_mismatch'
  | 'internal';

export const ERROR_CODES: readonly ErrorCode[] = [
  'invalid_argument',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'failed_precondition',
  'unimplemented',
  'deadline_exceeded',
  'cancelled',
  'resource_exhausted',
  'unavailable',
  'version_mismatch',
  'internal',
];

/**
 * Retryability a code has unless the thrower says otherwise. A size-limit refusal is the one
 * `resource_exhausted` that is sent as not retryable: resending the same payload cannot succeed.
 */
export const DEFAULT_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  invalid_argument: false,
  unauthenticated: false,
  forbidden: false,
  not_found: false,
  conflict: false,
  failed_precondition: false,
  unimplemented: false,
  deadline_exceeded: true,
  cancelled: false,
  resource_exhausted: true,
  unavailable: true,
  version_mismatch: false,
  internal: false,
};

export interface SocketError {
  code: ErrorCode;
  message: string;
  /** Validation errors, conflicting keys, limits … */
  details?: unknown;
  retryable: boolean;
  retryAfterMs?: number;
  /** Matches the server log line of an `internal` error. */
  errorId?: string;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function isSocketError(value: unknown): value is SocketError {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const v = value as Record<string, unknown>;
  return isErrorCode(v.code) && typeof v.message === 'string' && typeof v.retryable === 'boolean';
}

export interface SocketExceptionOptions {
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
  errorId?: string;
  cause?: unknown;
}

/**
 * A throwable `SocketError`. Server handlers throw it to answer with a specific code; the client
 * rejects command promises with it.
 */
export class SocketException extends Error implements SocketError {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly details?: unknown;
  public readonly retryAfterMs?: number;
  public readonly errorId?: string;

  constructor(code: ErrorCode, message: string, options: SocketExceptionOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SocketException';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];

    if (options.details !== undefined) {
      this.details = options.details;
    }

    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }

    if (options.errorId !== undefined) {
      this.errorId = options.errorId;
    }
  }

  public toWire(): SocketError {
    const wire: SocketError = { code: this.code, message: this.message, retryable: this.retryable };

    if (this.details !== undefined) {
      wire.details = this.details;
    }

    if (this.retryAfterMs !== undefined) {
      wire.retryAfterMs = this.retryAfterMs;
    }

    if (this.errorId !== undefined) {
      wire.errorId = this.errorId;
    }

    return wire;
  }

  public static fromWire(error: SocketError): SocketException {
    return new SocketException(error.code, error.message, {
      details: error.details,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      errorId: error.errorId,
    });
  }
}
```

Create `packages/http-socket-common/src/protocol.ts`:

```ts
import { SocketError } from './errors.js';

export const PROTOCOL_VERSION = 1;

/** Longest accepted command / cancel id. */
export const MAX_ID_LENGTH = 128;

export const WIRE_EVENTS = {
  /** client → server, answered through the socket.io ack */
  command: 'cmd',
  /** either direction, fire-and-forget */
  event: 'evt',
  /** server → client stream frames (W4) */
  chunk: 'chunk',
  end: 'end',
  fail: 'fail',
  /** client → server */
  credit: 'credit',
  cancel: 'cancel',
} as const;

export type WireEventName = (typeof WIRE_EVENTS)[keyof typeof WIRE_EVENTS];

/** Names of server events sent as `evt` frames. */
export const SYSTEM_EVENTS = {
  shutdown: 'sys.shutdown',
  disconnect: 'sys.disconnect',
} as const;

export type SystemEventName = (typeof SYSTEM_EVENTS)[keyof typeof SYSTEM_EVENTS];

/**
 * `io(url, { auth })`. A refused handshake rejects with a `connect_error` whose `data` is a
 * `SocketError` (`version_mismatch`, `invalid_argument`, `unauthenticated`).
 */
export interface Handshake {
  protocol: number;
  clientId: string;
  token?: string;
  [key: string]: unknown;
}

export interface CommandRequest<P = unknown> {
  id: string;
  name: string;
  payload: P;
  idempotencyKey?: string;
  /**
   * Milliseconds the caller is still willing to wait, measured from when the request was sent.
   * Relative on purpose: client and server clocks never have to agree.
   */
  deadline?: number;
  traceparent?: string;
}

export interface CommandResultReply<R = unknown> {
  id: string;
  ok: true;
  /** `null` when the handler returned nothing. */
  result: R;
}

/** The result follows as `chunk` frames (W4). */
export interface CommandStreamReply {
  id: string;
  ok: true;
  stream: true;
}

export interface CommandErrorReply {
  id: string;
  ok: false;
  error: SocketError;
}

export type CommandReply<R = unknown> = CommandResultReply<R> | CommandStreamReply | CommandErrorReply;

export interface EventFrame<P = unknown> {
  name: string;
  payload: P;
}

export interface Chunk<D = unknown> {
  id: string;
  seq: number;
  data: D;
}

/** `seq` is the number of chunks sent. */
export interface StreamEnd {
  id: string;
  seq: number;
}

export interface StreamFail {
  id: string;
  error: SocketError;
}

export interface StreamCredit {
  id: string;
  credits: number;
}

/** Cancels a running command or stream with this request id. */
export interface CancelFrame {
  id: string;
}

export interface ShutdownNotice {
  retryAfterMs: number;
}

export interface DisconnectNotice {
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

export function isCommandRequest(value: unknown): value is CommandRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isId(value.id) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.idempotencyKey === undefined || typeof value.idempotencyKey === 'string') &&
    (value.deadline === undefined || (typeof value.deadline === 'number' && Number.isFinite(value.deadline))) &&
    (value.traceparent === undefined || typeof value.traceparent === 'string')
  );
}

export function isEventFrame(value: unknown): value is EventFrame {
  return isRecord(value) && typeof value.name === 'string' && value.name.length > 0;
}

export function isCancelFrame(value: unknown): value is CancelFrame {
  return isRecord(value) && isId(value.id);
}
```

Create `packages/http-socket-common/src/contract.ts`:

```ts
/**
 * One contract module is shared by the server and the client. Declare contracts with `type`,
 * not `interface`: only type aliases get the implicit index signature `Record<string, …>` needs.
 */
export interface ContractShape {
  /** command name → [payload, result] */
  commands: Record<string, readonly [unknown, unknown]>;
  /** server → client events: name → payload */
  events: Record<string, unknown>;
  /** client → server events: name → payload */
  clientEvents?: Record<string, unknown>;
}

export interface SocketContract<C extends ContractShape> {
  readonly kind: 'socket-contract';
  /** Type carrier only, never set at runtime. */
  readonly __contract?: C;
}

export function defineContract<C extends ContractShape>(): SocketContract<C> {
  return { kind: 'socket-contract' };
}

export type CommandName<C extends ContractShape> = Extract<keyof C['commands'], string>;
export type CommandPayload<C extends ContractShape, N extends CommandName<C>> = C['commands'][N][0];
export type CommandResult<C extends ContractShape, N extends CommandName<C>> = C['commands'][N][1];
export type EventName<C extends ContractShape> = Extract<keyof C['events'], string>;
export type EventPayload<C extends ContractShape, N extends EventName<C>> = C['events'][N];
export type ClientEventName<C extends ContractShape> = Extract<keyof NonNullable<C['clientEvents']>, string>;
export type ClientEventPayload<C extends ContractShape, N extends ClientEventName<C>> = NonNullable<C['clientEvents']>[N];
export type ContractOf<T> = T extends SocketContract<infer C> ? C : never;
```

Create `packages/http-socket-common/src/index.ts`:

```ts
export * from './errors.js';
export * from './protocol.js';
export * from './contract.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-common && npx ts-mocha -p tsconfig.json test/common.test.ts`
Expected: `13 passing`, 0 failing.

- [ ] **Step 7: Register the package in the root build and build both module flavours (consumers import `lib/`)**

In `tsconfig.build.json`, insert after line 12 (`    { "path": "packages/telemetry-common/tsconfig.mjs.json" },`):

```json
    { "path": "packages/http-socket-common/tsconfig.mjs.json" },
```

In `tsconfig.build.cjs.json`, insert after line 12 (`    { "path": "./packages/telemetry-common/tsconfig.cjs.json" },`):

```json
    { "path": "./packages/http-socket-common/tsconfig.cjs.json" },
```

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket-common/tsconfig.mjs.json packages/http-socket-common/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs`
Expected: exits 0. `packages/http-socket-common/lib/mjs/index.js`, `lib/mjs/index.d.ts`, `lib/cjs/index.js` and `lib/cjs/package.json` (`{"type":"commonjs"}`) exist.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json`
Expected: exits 0 (the whole repo now builds, including the new package).

- [ ] **Step 8: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-common/package.json packages/http-socket-common/tsconfig.json packages/http-socket-common/tsconfig.mjs.json packages/http-socket-common/tsconfig.cjs.json \
  packages/http-socket-common/.eslintignore packages/http-socket-common/.eslintrc.cjs packages/http-socket-common/.gitignore packages/http-socket-common/.npmignore packages/http-socket-common/.prettierrc packages/http-socket-common/.mocharc.json \
  packages/http-socket-common/src packages/http-socket-common/test tsconfig.build.json tsconfig.build.cjs.json && \
git commit -m "feat(http-socket-common): wire protocol, error codes and contract typing for the WebSocket layer"
```

---

### Task 2: `@spinajs/http-socket` v3 scaffold and `http.socket` defaults

**Files:**
- Delete: `packages/http-socket/src/middlewares.ts`
- Replace: `packages/http-socket/src/interfaces.ts`, `packages/http-socket/src/index.ts`
- Replace: `packages/http-socket/package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`
- Create: `packages/http-socket/src/config/http-socket.ts`
- Test: `packages/http-socket/test/config.test.ts`

**Interfaces:**
- Consumes: `@spinajs/http-socket-common` (Task 1); the package dependencies `@spinajs/authz` and `@spinajs/authn` (3.0.0-alpha.0, on this branch).
- Produces: `ISocketServerConfig` (with `cors: ISocketCorsConfig { origins: string[] }` and `auth: ISocketAuthConfig { required: boolean; revalidateMs: number }`), `ISocketRateConfig`, `ISocketIdempotencyConfig` (in `src/interfaces.ts`); the default export of `src/config/http-socket.ts` typed `ISocketConfigFile = { http: { socket: ISocketServerConfig }; system: { dirs: { socketControllers: string[] } } }`.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import socketConfig from '../src/config/http-socket.js';

describe('http-socket default configuration', () => {
  it('ships the binding defaults of the spec', () => {
    const socket = socketConfig.http.socket;
    expect(socket.path).to.equal('/socket.io');
    expect(socket.maxPayloadBytes).to.equal(1024 * 1024);
    expect(socket.maxInFlightPerConnection).to.equal(32);
    expect(socket.recovery).to.deep.equal({ maxDisconnectionMs: 120_000 });
    expect(socket.idempotency).to.deep.equal({ service: 'MemoryIdempotencyStore', ttlMs: 600_000 });
    expect(socket.drainMs).to.equal(5_000);
  });

  it('ships transport and rate defaults', () => {
    const socket = socketConfig.http.socket;
    expect(socket.pingInterval).to.equal(25_000);
    expect(socket.pingTimeout).to.equal(20_000);
    expect(socket.rate).to.deep.equal({ perSecond: 50, burst: 100 });
    expect(socket.adapter).to.be.undefined;
  });

  it('ships the authz-v3 defaults: no cross-origin handshake, unattended without credentials, revalidation every minute', () => {
    const socket = socketConfig.http.socket;
    expect(socket.cors).to.deep.equal({ origins: [] });
    expect(socket.auth).to.deep.equal({ required: false, revalidateMs: 60_000 });
  });

  it('adds no socket controller directories by default', () => {
    expect(socketConfig.system.dirs.socketControllers).to.deep.equal([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/config.test.ts`
Expected: FAIL with `Cannot find module '../src/config/http-socket.js'`.

- [ ] **Step 3: Replace the package manifest and tsconfigs**

Replace `packages/http-socket/package.json` with:

```json
{
  "name": "@spinajs/http-socket",
  "version": "2.0.548",
  "description": "WebSocket server for spinajs: socket controllers, commands, events, rooms, limits and error mapping over socket.io",
  "main": "lib/cjs/index.js",
  "module": "lib/mjs/index.js",
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    }
  },
  "type": "module",
  "private": false,
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=16.11"
  },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "rimraf": "./node_modules/rimraf/bin.js",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "test": "ts-mocha -p tsconfig.json test/**/*.test.ts",
    "coverage": "nyc npm run test",
    "build-docs": "rimraf docs && typedoc --options typedoc.json src/",
    "format": "prettier --write \"src/**/*.ts\"",
    "lint": "eslint -c .eslintrc.cjs --ext .ts src --fix",
    "preversion": "npm run lint",
    "version": "npm run format && git add -A src"
  },
  "files": [
    "lib/**/*"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/spinajs/main.git"
  },
  "keywords": [
    "spinajs",
    "http",
    "websocket",
    "socket.io"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme",
  "devDependencies": {
    "@types/express": "^5.0.1",
    "@types/node": "^22.14.1",
    "lodash": "^4.17.21",
    "socket.io-client": "^4.8.1"
  },
  "dependencies": {
    "@spinajs/authn": "3.0.0-alpha.0",
    "@spinajs/authz": "3.0.0-alpha.0",
    "@spinajs/configuration": "2.0.548",
    "@spinajs/di": "2.0.548",
    "@spinajs/exceptions": "2.0.548",
    "@spinajs/http": "2.0.548",
    "@spinajs/http-socket-common": "3.0.0-alpha.0",
    "@spinajs/log": "2.0.548",
    "@spinajs/reflection": "2.0.548",
    "@spinajs/telemetry-common": "2.0.548",
    "@spinajs/validation": "2.0.548",
    "socket.io": "^4.8.1"
  }
}
```

Replace `packages/http-socket/tsconfig.json` with:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*", "test/**/*"],
  "references": [
    { "path": "../authn/tsconfig.json" },
    { "path": "../authz/tsconfig.json" },
    { "path": "../di/tsconfig.json" },
    { "path": "../configuration/tsconfig.json" },
    { "path": "../exceptions/tsconfig.json" },
    { "path": "../http/tsconfig.json" },
    { "path": "../http-socket-common/tsconfig.json" },
    { "path": "../log/tsconfig.json" },
    { "path": "../reflection/tsconfig.json" },
    { "path": "../telemetry-common/tsconfig.json" },
    { "path": "../validation/tsconfig.json" }
  ]
}
```

Replace `packages/http-socket/tsconfig.mjs.json` with:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../authn/tsconfig.mjs.json" },
    { "path": "../authz/tsconfig.mjs.json" },
    { "path": "../di/tsconfig.mjs.json" },
    { "path": "../configuration/tsconfig.mjs.json" },
    { "path": "../exceptions/tsconfig.mjs.json" },
    { "path": "../http/tsconfig.mjs.json" },
    { "path": "../http-socket-common/tsconfig.mjs.json" },
    { "path": "../log/tsconfig.mjs.json" },
    { "path": "../reflection/tsconfig.mjs.json" },
    { "path": "../telemetry-common/tsconfig.mjs.json" },
    { "path": "../validation/tsconfig.mjs.json" }
  ]
}
```

Replace `packages/http-socket/tsconfig.cjs.json` with:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../authn/tsconfig.cjs.json" },
    { "path": "../authz/tsconfig.cjs.json" },
    { "path": "../di/tsconfig.cjs.json" },
    { "path": "../configuration/tsconfig.cjs.json" },
    { "path": "../exceptions/tsconfig.cjs.json" },
    { "path": "../http/tsconfig.cjs.json" },
    { "path": "../http-socket-common/tsconfig.cjs.json" },
    { "path": "../log/tsconfig.cjs.json" },
    { "path": "../reflection/tsconfig.cjs.json" },
    { "path": "../telemetry-common/tsconfig.cjs.json" },
    { "path": "../validation/tsconfig.cjs.json" }
  ]
}
```

- [ ] **Step 4: Remove v2 and write the v3 config**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
git rm packages/http-socket/src/middlewares.ts
```

Replace `packages/http-socket/src/interfaces.ts` with:

```ts
export interface ISocketRateConfig {
  perSecond: number;
  burst: number;
}

export interface ISocketIdempotencyConfig {
  /** DI name of the IdempotencyStore implementation (W3). */
  service: string;
  ttlMs: number;
}

export interface ISocketCorsConfig {
  /** Exact origins allowed to open a socket besides same-origin pages; no wildcards. Empty: none ( authz-v3 A31 ). */
  origins: string[];
}

export interface ISocketAuthConfig {
  /** Refuse a handshake no SocketPrincipalSource resolves, instead of running it as UNATTENDED. */
  required: boolean;
  /** How often a live connection's principal is re-checked with its source; 0 turns it off. */
  revalidateMs: number;
}

/** `http.socket` */
export interface ISocketServerConfig {
  path: string;
  cors: ISocketCorsConfig;
  auth: ISocketAuthConfig;
  pingInterval: number;
  pingTimeout: number;
  recovery: { maxDisconnectionMs: number };
  maxPayloadBytes: number;
  maxInFlightPerConnection: number;
  rate: ISocketRateConfig;
  idempotency: ISocketIdempotencyConfig;
  drainMs: number;
  /** socket.io adapter constructor for several instances; unset = in memory */
  adapter?: unknown;
}
```

Create `packages/http-socket/src/config/http-socket.ts`:

```ts
import type { ISocketServerConfig } from '../interfaces.js';

export interface ISocketConfigFile {
  http: { socket: ISocketServerConfig };
  system: { dirs: { socketControllers: string[] } };
}

const config: ISocketConfigFile = {
  http: {
    socket: {
      path: '/socket.io',
      cors: {
        origins: [],
      },
      auth: {
        required: false,
        revalidateMs: 60_000,
      },
      pingInterval: 25_000,
      pingTimeout: 20_000,
      recovery: {
        maxDisconnectionMs: 120_000,
      },
      maxPayloadBytes: 1024 * 1024,
      maxInFlightPerConnection: 32,
      rate: {
        perSecond: 50,
        burst: 100,
      },
      idempotency: {
        service: 'MemoryIdempotencyStore',
        ttlMs: 600_000,
      },
      drainMs: 5_000,
      adapter: undefined,
    },
  },
  system: {
    dirs: {
      // Keep socket controllers out of system.dirs.controllers: the http loader scans those.
      socketControllers: [],
    },
  },
};

export default config;
```

Replace `packages/http-socket/src/index.ts` with:

```ts
export * from '@spinajs/http-socket-common';
export * from './interfaces.js';
```

- [ ] **Step 5: Install the new dev dependency**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && npm install`
Expected: exits 0. `node_modules/socket.io-client/package.json` exists and its version starts with `4.8`. `package-lock.json` changes; leave it unstaged (D17).

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/config.test.ts`
Expected: `4 passing`.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket/tsconfig.mjs.json packages/http-socket/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs`
Expected: exits 0. The project references build `packages/authn/lib/{mjs,cjs}/contracts/index.js` and `packages/authz/lib/{mjs,cjs}/index.js`, which the tests of later tasks import.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
# src/middlewares.ts is already staged as deleted by the `git rm` in Step 4
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/package.json packages/http-socket/tsconfig.json packages/http-socket/tsconfig.mjs.json packages/http-socket/tsconfig.cjs.json \
  packages/http-socket/src/interfaces.ts packages/http-socket/src/index.ts packages/http-socket/src/config/http-socket.ts packages/http-socket/test/config.test.ts && \
git commit -m "feat(http-socket)!: start the v3 rewrite with the http.socket default configuration"
```

---

### Task 3: Limit primitives

**Files:**
- Create: `packages/http-socket/src/limits.ts`
- Modify: `packages/http-socket/src/index.ts` (append one export)
- Test: `packages/http-socket/test/limits.test.ts`

**Interfaces:**
- Consumes: `SocketException` (Task 1).
- Produces:
  - `payloadSize(value: unknown): number`
  - `class TokenBucket { constructor(perSecond: number, burst: number, now?: () => number); take(): boolean; retryAfterMs(): number }`
  - `assertPayloadSize(payload: unknown, maxBytes: number): void`, which throws `SocketException('resource_exhausted', …, {retryable:false, details:{size, limit}})`
  - `assertRate(bucket: TokenBucket): void`, which throws `SocketException('resource_exhausted', 'rate limit exceeded', {retryAfterMs})`

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/limits.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { SocketException } from '@spinajs/http-socket-common';
import { TokenBucket, assertPayloadSize, assertRate, payloadSize } from '../src/limits.js';

describe('socket limit primitives', () => {
  describe('payloadSize', () => {
    it('counts the UTF-8 bytes of the JSON form', () => {
      expect(payloadSize({ a: 1 })).to.equal(Buffer.byteLength('{"a":1}'));
      // two quotes + a two-byte character
      expect(payloadSize('ż')).to.equal(4);
    });

    it('counts binary parts by byte length, not by their JSON expansion', () => {
      expect(payloadSize({ bin: Buffer.alloc(1000) })).to.equal(1000 + Buffer.byteLength('{"bin":null}'));
      expect(payloadSize(new Uint8Array(10))).to.equal(10 + 4);
      expect(payloadSize(new ArrayBuffer(8))).to.equal(8 + 4);
    });

    it('treats an absent payload as empty', () => {
      expect(payloadSize(undefined)).to.equal(0);
    });
  });

  describe('TokenBucket', () => {
    let now = 0;
    const clock = () => now;

    beforeEach(() => {
      now = 0;
    });

    it('lets a burst through and then refuses', () => {
      const bucket = new TokenBucket(10, 2, clock);
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.false;
    });

    it('says how long until the next token', () => {
      const bucket = new TokenBucket(10, 1, clock);
      bucket.take();
      expect(bucket.retryAfterMs()).to.equal(100);
      now = 50;
      expect(bucket.retryAfterMs()).to.equal(50);
    });

    it('refills at the configured rate, up to the burst', () => {
      const bucket = new TokenBucket(10, 2, clock);
      bucket.take();
      bucket.take();
      now = 100;
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.false;
      now = 10_000;
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.true;
      expect(bucket.take()).to.be.false;
    });
  });

  describe('assertions', () => {
    it('refuses an oversized payload as a non-retryable resource_exhausted', () => {
      let caught: unknown;
      try {
        assertPayloadSize('x'.repeat(100), 10);
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(SocketException);
      expect((caught as SocketException).toWire()).to.deep.equal({
        code: 'resource_exhausted',
        message: 'payload of 102 bytes exceeds the limit of 10 bytes',
        retryable: false,
        details: { size: 102, limit: 10 },
      });
    });

    it('lets a payload exactly at the limit through', () => {
      expect(() => assertPayloadSize('x'.repeat(8), 10)).not.to.throw();
    });

    it('refuses an empty bucket with retryAfterMs', () => {
      let now = 0;
      const bucket = new TokenBucket(4, 1, () => now);
      bucket.take();
      let caught: unknown;
      try {
        assertRate(bucket);
      } catch (err) {
        caught = err;
      }
      expect((caught as SocketException).toWire()).to.deep.equal({ code: 'resource_exhausted', message: 'rate limit exceeded', retryable: true, retryAfterMs: 250 });
      now = 250;
      expect(() => assertRate(bucket)).not.to.throw();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/limits.test.ts`
Expected: FAIL with `Cannot find module '../src/limits.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/http-socket/src/limits.ts`:

```ts
import { SocketException } from '@spinajs/http-socket-common';

/**
 * Wire size of a command payload: the UTF-8 length of its JSON form plus the bytes of every
 * binary part (socket.io sends those as attachments, not as JSON).
 */
export function payloadSize(value: unknown): number {
  let binary = 0;

  const json = JSON.stringify(value, function (this: Record<string, unknown>, key: string, current: unknown) {
    // `current` has already been through toJSON (a Buffer arrives as {type, data}), so binary
    // parts are detected on the raw holder value.
    const raw = this[key];
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      binary += raw.byteLength;
      return null;
    }

    return current;
  });

  return binary + (json === undefined ? 0 : Buffer.byteLength(json, 'utf8'));
}

export class TokenBucket {
  protected tokens: number;
  protected last: number;

  constructor(
    protected readonly perSecond: number,
    protected readonly burst: number,
    protected readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  public take(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  public retryAfterMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * 1000) / this.perSecond);
  }

  protected refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) * this.perSecond) / 1000);
    this.last = t;
  }
}

export function assertPayloadSize(payload: unknown, maxBytes: number): void {
  const size = payloadSize(payload);

  if (size > maxBytes) {
    throw new SocketException('resource_exhausted', `payload of ${size} bytes exceeds the limit of ${maxBytes} bytes`, {
      retryable: false,
      details: { size, limit: maxBytes },
    });
  }
}

export function assertRate(bucket: TokenBucket): void {
  if (!bucket.take()) {
    throw new SocketException('resource_exhausted', 'rate limit exceeded', { retryAfterMs: bucket.retryAfterMs() });
  }
}
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './limits.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/limits.test.ts`
Expected: `9 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/limits.ts packages/http-socket/src/index.ts packages/http-socket/test/limits.test.ts && \
git commit -m "feat(http-socket): payload size, token bucket and limit assertions"
```

---

### Task 4: Error mapping

**Files:**
- Create: `packages/http-socket/src/errors.ts`
- Create: `packages/http-socket/test/harness.ts` (configuration part only; Task 5 replaces it with the full harness)
- Modify: `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/error-mapping.test.ts`

**Interfaces:**
- Consumes: `SocketException`, `SocketError`, `ErrorCode`, `DEFAULT_RETRYABLE` (Task 1).
- Produces:
  - `abstract class SocketErrorMapping { abstract map(error: Error): SocketError }`
  - `HandleSocketException(exception: Constructor<Error> | Constructor<Error>[])`, a class decorator for a `SocketErrorMapping` subclass
  - `resolveSocketErrorMapping(error: unknown): Constructor<SocketErrorMapping> | null`, which walks the prototype chain by class name
  - `codeMapping(code: ErrorCode): Constructor<SocketErrorMapping>`
  - the default mappings `InvalidArgumentMapping`, `ValidationFailedMapping`, `UnauthenticatedMapping`, `ForbiddenMapping`, `AccessDeniedMapping` (authz-v3 `AccessDenied` → `forbidden` with `details { permission, resource, reason }`; `Unauthenticated` maps through its `AuthenticationFailed` base), `NotFoundMapping`, `ConflictMapping`, `FailedPreconditionMapping`, `UnimplementedMapping`, `SocketExceptionMapping`
  - `@Injectable() class SocketErrorMapper { toWire(error: unknown, context: string): SocketError }`. It logs `internal` errors with an `errorId` and hides their message when `configuration.isProduction`.
  - test harness: `TestConfiguration`, `configure(overrides?: Record<string, unknown>): Promise<void>`

- [ ] **Step 1: Write the test harness (configuration part)**

Create `packages/http-socket/test/harness.ts`:

```ts
import 'mocha';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';
import socketConfig from '../src/config/http-socket.js';

chai.use(chaiAsPromised);

let overrides: Record<string, unknown> = {};

export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return _.merge(
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        configuration: { isProduction: false },
        http: { socket: _.cloneDeep(socketConfig.http.socket) },
      },
      overrides,
    );
  }
}

/** Fresh DI cache and configuration; `cfg` is merged over the test defaults. */
export async function configure(cfg: Record<string, unknown> = {}): Promise<void> {
  overrides = cfg;
  DI.clearCache();
  DI.register(TestConfiguration).as(Configuration);
  await DI.resolve(Configuration);
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/http-socket/test/error-mapping.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { AuthenticationFailed, BadRequest, Forbidden, InvalidArgument, InvalidOperation, JsonValidationFailed, MethodNotImplemented, NotSupported, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { DataValidator } from '@spinajs/validation';
import { AccessDenied, FALSE, Unauthenticated } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { ErrorCode, SocketException } from '@spinajs/http-socket-common';
import { AccessDeniedMapping, ForbiddenMapping, HandleSocketException, SocketErrorMapper, codeMapping, resolveSocketErrorMapping } from '../src/errors.js';
import { configure } from './harness.js';

export class ErrDocumentLocked extends Forbidden {}
export class ErrEditWindowClosed extends Forbidden {}

@HandleSocketException(ErrEditWindowClosed)
export class ErrEditWindowClosedMapping extends codeMapping('failed_precondition') {}

describe('socket error mapping', function () {
  this.timeout(15000);

  let mapper: SocketErrorMapper;

  beforeEach(async () => {
    await configure();
    mapper = DI.resolve(SocketErrorMapper);
  });

  afterEach(() => {
    sinon.restore();
  });

  const rows: Array<[Error, ErrorCode]> = [
    [new InvalidArgument('bad id'), 'invalid_argument'],
    [new BadRequest('bad request'), 'invalid_argument'],
    [new JsonValidationFailed('bad json'), 'invalid_argument'],
    [new AuthenticationFailed('who are you'), 'unauthenticated'],
    [new Unauthenticated('authentication required'), 'unauthenticated'],
    [new Forbidden('not yours'), 'forbidden'],
    [new ResourceNotFound('no such doc'), 'not_found'],
    [new ResourceDuplicated('doc exists'), 'conflict'],
    [new InvalidOperation('doc is archived'), 'failed_precondition'],
    [new NotSupported('no export'), 'unimplemented'],
    [new MethodNotImplemented('later'), 'unimplemented'],
  ];

  for (const [error, code] of rows) {
    it(`maps ${error.constructor.name} to ${code}, not retryable`, () => {
      expect(mapper.toWire(error, 'test')).to.deep.equal({ code, message: error.message, retryable: false });
    });
  }

  it('maps a domain subclass through the prototype chain', () => {
    expect(mapper.toWire(new ErrDocumentLocked('locked by bob'), 'test')).to.deep.equal({ code: 'forbidden', message: 'locked by bob', retryable: false });
  });

  it('prefers an exact registration over an inherited one', () => {
    expect(resolveSocketErrorMapping(new ErrEditWindowClosed('x'))).to.equal(ErrEditWindowClosedMapping);
    expect(resolveSocketErrorMapping(new ErrDocumentLocked('x'))).to.equal(ForbiddenMapping);
    expect(mapper.toWire(new ErrEditWindowClosed('too late'), 'test').code).to.equal('failed_precondition');
  });

  it('maps authz-v3 AccessDenied to forbidden with the permission, resource and reason of the http 403 body (B23)', () => {
    const decision: Decision = {
      allowed: false,
      permission: 'doc:read',
      resource: { type: 'doc', id: 'd1' },
      principal: { type: 'user', id: '1' },
      residual: FALSE,
      fields: { read: [], write: [] },
      roles: {},
      reason: { code: 'locked', model: 'm1', priority: 50, sortKey: 'k', detail: 'd' },
      domain: 'root',
    };

    expect(resolveSocketErrorMapping(new AccessDenied(decision))).to.equal(AccessDeniedMapping);
    expect(mapper.toWire(new AccessDenied(decision, 'no'), 'test')).to.deep.equal({
      code: 'forbidden',
      message: 'no',
      retryable: false,
      details: { permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, reason: { code: 'locked', model: 'm1', detail: 'd' } },
    });
  });

  it('puts the invalid field into details', () => {
    expect(mapper.toWire(new InvalidArgument('bad id', 'id'), 'test')).to.deep.equal({ code: 'invalid_argument', message: 'bad id', retryable: false, details: { field: 'id' } });
  });

  it('maps validation failures with their details', async () => {
    const validator = await DI.resolve(DataValidator);
    let failure: unknown;
    try {
      validator.validate({ type: 'object', required: ['title'], properties: { title: { type: 'string' } } }, {});
    } catch (err) {
      failure = err;
    }

    const wire = mapper.toWire(failure, 'test');
    expect(wire.code).to.equal('invalid_argument');
    expect(wire.retryable).to.be.false;
    expect(wire.details).to.be.an('array').that.is.not.empty;
    expect((wire.details as Array<{ rule: string }>)[0].rule).to.equal('required');
  });

  it('passes socket exceptions through with their own code and retry hints', () => {
    expect(mapper.toWire(new SocketException('deadline_exceeded', 'late'), 'test')).to.deep.equal({ code: 'deadline_exceeded', message: 'late', retryable: true });
    expect(mapper.toWire(new SocketException('cancelled', 'stop'), 'test')).to.deep.equal({ code: 'cancelled', message: 'stop', retryable: false });
    expect(mapper.toWire(new SocketException('resource_exhausted', 'slow down', { retryAfterMs: 100 }), 'test')).to.deep.equal({ code: 'resource_exhausted', message: 'slow down', retryable: true, retryAfterMs: 100 });
    expect(mapper.toWire(new SocketException('unavailable', 'restarting'), 'test')).to.deep.equal({ code: 'unavailable', message: 'restarting', retryable: true });
  });

  it('maps anything else to internal with an errorId it logs', () => {
    const log = sinon.spy((mapper as unknown as { Log: { error: (...args: unknown[]) => void } }).Log, 'error');
    const wire = mapper.toWire(new Error('kaput'), 'command docs.open');

    expect(wire.code).to.equal('internal');
    expect(wire.retryable).to.be.false;
    expect(wire.message).to.equal('kaput');
    expect(wire.errorId).to.match(/^[0-9a-f-]{36}$/);
    expect((wire.details as { stack?: string }).stack).to.contain('kaput');
    expect(log.calledOnce).to.be.true;
    expect(String(log.firstCall.args[1])).to.contain(wire.errorId!);
  });

  it('maps thrown non-errors to internal', () => {
    const wire = mapper.toWire('boom', 'test');
    expect(wire.code).to.equal('internal');
    expect(wire.message).to.equal('boom');
  });

  it('hides the internal message in production', async () => {
    await configure({ configuration: { isProduction: true } });
    const wire = DI.resolve(SocketErrorMapper).toWire(new Error('db password is hunter2'), 'test');

    expect(wire.errorId).to.be.a('string');
    expect(wire).to.deep.equal({ code: 'internal', message: 'Internal server error', retryable: false, errorId: wire.errorId });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/error-mapping.test.ts`
Expected: FAIL with `Cannot find module '../src/errors.js'`.

- [ ] **Step 4: Write the implementation**

Create `packages/http-socket/src/errors.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Constructor, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { AuthenticationFailed, BadRequest, Forbidden, InvalidArgument, InvalidOperation, JsonValidationFailed, MethodNotImplemented, NotSupported, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { ValidationFailed } from '@spinajs/validation';
import { AccessDenied } from '@spinajs/authz';
import type { DenyReason } from '@spinajs/authz';
import { DEFAULT_RETRYABLE, ErrorCode, SocketError, SocketException } from '@spinajs/http-socket-common';

export abstract class SocketErrorMapping {
  public abstract map(error: Error): SocketError;
}

// Module-level rather than a DI map value (as @HandleException does): DI.clearCache() drops
// cache entries, and the decorators that fill this map run only once per process.
const SOCKET_ERROR_MAP = new Map<string, Constructor<SocketErrorMapping>>();

/**
 * Registers the decorated mapping for one or more exception types. Lookup walks the prototype
 * chain, so a domain subclass of a mapped exception maps the same way unless it has its own entry.
 */
export function HandleSocketException(exception: Constructor<Error> | Constructor<Error>[]) {
  return (target: Constructor<SocketErrorMapping>) => {
    for (const e of Array.isArray(exception) ? exception : [exception]) {
      SOCKET_ERROR_MAP.set(e.name, target);
    }
  };
}

export function resolveSocketErrorMapping(error: unknown): Constructor<SocketErrorMapping> | null {
  for (let ctor = (error as { constructor?: unknown } | null | undefined)?.constructor; typeof ctor === 'function' && ctor !== Object; ctor = Object.getPrototypeOf(ctor)) {
    const name = (ctor as { name?: string }).name;
    if (name && SOCKET_ERROR_MAP.has(name)) {
      return SOCKET_ERROR_MAP.get(name)!;
    }
  }

  return null;
}

export function codeMapping(code: ErrorCode): Constructor<SocketErrorMapping> {
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

@HandleSocketException(ValidationFailed)
export class ValidationFailedMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    return { code: 'invalid_argument', message: error.message, retryable: false, details: (error as ValidationFailed).details };
  }
}

@HandleSocketException(AuthenticationFailed)
export class UnauthenticatedMapping extends codeMapping('unauthenticated') {}

@HandleSocketException(Forbidden)
export class ForbiddenMapping extends codeMapping('forbidden') {}

// priority and sortKey only order the deny reasons; authz-http leaves them out of its 403 body (B23)
function publicReason(reason: DenyReason): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reason)) {
    if (key !== 'priority' && key !== 'sortKey') {
      out[key] = value;
    }
  }
  return out;
}

/** The socket form of authz-http's 403 body. Never a trace: B41 forbids it in production, and sockets do not offer explain. */
@HandleSocketException(AccessDenied)
export class AccessDeniedMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    const decision = (error as AccessDenied).decision;
    return {
      code: 'forbidden',
      message: error.message,
      retryable: false,
      details: { permission: decision.permission, resource: decision.resource, ...(decision.reason ? { reason: publicReason(decision.reason) } : {}) },
    };
  }
}

@HandleSocketException(ResourceNotFound)
export class NotFoundMapping extends codeMapping('not_found') {}

@HandleSocketException(ResourceDuplicated)
export class ConflictMapping extends codeMapping('conflict') {}

@HandleSocketException(InvalidOperation)
export class FailedPreconditionMapping extends codeMapping('failed_precondition') {}

@HandleSocketException([NotSupported, MethodNotImplemented])
export class UnimplementedMapping extends codeMapping('unimplemented') {}

@HandleSocketException(SocketException)
export class SocketExceptionMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    return (error as SocketException).toWire();
  }
}

@Injectable()
export class SocketErrorMapper {
  @Logger('http-socket')
  protected Log: Log;

  @Config('configuration.isProduction', { defaultValue: false })
  protected IsProduction: boolean;

  /**
   * @param context - what failed, for the log line ( eg. `command docs.open` )
   */
  public toWire(error: unknown, context: string): SocketError {
    const mapping = resolveSocketErrorMapping(error);

    if (mapping && error instanceof Error) {
      try {
        return new mapping().map(error);
      } catch (mappingError) {
        return this.internal(mappingError, `${context} (error mapping ${mapping.name} failed)`);
      }
    }

    return this.internal(error, context);
  }

  protected internal(error: unknown, context: string): SocketError {
    const errorId = randomUUID();
    const err = error instanceof Error ? error : new Error(String(error));

    this.Log.error(err, `Socket ${context} failed, errorId: ${errorId}`);

    if (this.IsProduction) {
      return { code: 'internal', message: 'Internal server error', retryable: false, errorId };
    }

    return { code: 'internal', message: err.message, retryable: false, errorId, details: { name: err.name, stack: err.stack } };
  }
}
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './errors.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/error-mapping.test.ts`
Expected: `20 passing`.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/errors.ts packages/http-socket/src/index.ts packages/http-socket/test/harness.ts packages/http-socket/test/error-mapping.test.ts && \
git commit -m "feat(http-socket): @HandleSocketException error mapping with prototype-chain lookup and production hiding"
```

---
### Task 5: Connections, the HTTP host and the handshake

**Files:**
- Modify: `packages/http-socket/src/interfaces.ts` (add imports at the top; append declarations)
- Create: `packages/http-socket/src/origin.ts`, `src/connection.ts`, `src/hub.ts`, `src/host.ts`, `src/server.ts`
- Modify: `packages/http-socket/src/index.ts` (append)
- Replace: `packages/http-socket/test/harness.ts` (full harness)
- Test: `packages/http-socket/test/handshake.test.ts`

**Interfaces:**
- Consumes: `ISocketServerConfig` (Task 2), `SocketErrorMapper` (Task 4), `PROTOCOL_VERSION`, `MAX_ID_LENGTH`, `SocketException`, `SocketError`, `WIRE_EVENTS`, `SYSTEM_EVENTS`, `EventFrame`, `DisconnectNotice` (Task 1); from `@spinajs/authz`: `Principal`, `UNATTENDED`, `principalKey`, `Unauthenticated`.
- Produces:
  - `ISocketHandshake { auth; headers; cookies; address; url; query; secure; issuedAt }`
  - `abstract class SocketPrincipalSource { abstract readonly name: string; abstract readonly order: number; abstract authenticate(h: ISocketHandshake): Promise<Principal | null>; revalidate(h: ISocketHandshake, p: Principal): Promise<boolean> }`. Sources run in ascending `order` and the first non-null principal wins. Throw to refuse. The default `revalidate` authenticates again and compares `principalKey` (D11, D16).
  - `ISocketAuthState { principal: Principal; source: string | null; checkedAt: number }`, kept in `socket.data.auth`
  - `abstract class SocketHttpHost { abstract server(): Promise<http.Server | https.Server> }`; the default is `HttpServerHost`, which takes the server from `@spinajs/http`'s `HttpServer`
  - `isAllowedOrigin(headers, origins): boolean` (D15)
  - `class SocketConnection<D, U> { id; clientId; handshake; connectedAt; auth: ISocketAuthState; principal: Principal; authenticated: boolean; user: U | undefined /* principal.identity */; data: D; rooms; connected; signal; emit(name, payload); join(room); leave(room); disconnect(reason); close(reason) /* internal */ }`
  - `toHandshake(socket)`, `parseCookies(header)`
  - `SocketHub { attach(io); detach(); register(conn); unregister(id); connection(id); Connections }`; rooms are added in Task 14
  - `SocketServer { Io; resolve(); dispose() }`. Handshake order: origin (`forbidden`), protocol (`version_mismatch`), clientId (`invalid_argument`), principal sources (a throw is the refusal; none and `auth.required` → `unauthenticated` "authentication required"; none otherwise → `UNATTENDED`, D13). A refused handshake answers `connect_error` with `data: SocketError`.
  - harness: `ALICE`, `ALICE_PRINCIPAL`, `TestHttpHost`, `TestPrincipalSource` (owns only the tokens `'good'` → `ALICE_PRINCIPAL` and `'bad'` → `AuthenticationFailed('invalid token')`; returns null for everything else, so later test files can own other tokens), `configure`, `startServer(cfg?) → ITestServer {server, url, path, close()}`, `connect`, `connected`, `open`, `refusalOf`, `nextId`, `command`, `errorOf`, `resultOf`, `nextEvent`, `delay`, `waitFor`

- [ ] **Step 1: Replace the test harness with the full version**

Replace `packages/http-socket/test/harness.ts` with:

```ts
import 'mocha';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import { createServer, Server as NodeHttpServer } from 'http';
import { AddressInfo } from 'net';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/authz';
import '@spinajs/log';
import { CommandReply, CommandRequest, EventFrame, PROTOCOL_VERSION, SocketError, WIRE_EVENTS } from '@spinajs/http-socket-common';
import socketConfig from '../src/config/http-socket.js';
import { ISocketHandshake, SocketHttpHost, SocketPrincipalSource } from '../src/interfaces.js';
import { SocketServer } from '../src/server.js';

chai.use(chaiAsPromised);

export const ALICE = { id: 1, name: 'alice' };

export const ALICE_PRINCIPAL: Principal = Object.freeze({ type: 'user', id: '1', authenticated: true, source: 'test', attributes: Object.freeze({}), identity: ALICE });

/** A plain node http server, so socket tests do not need the express stack. */
export class TestHttpHost extends SocketHttpHost {
  public readonly Http: NodeHttpServer = createServer();

  public async server(): Promise<NodeHttpServer> {
    return this.Http;
  }
}

/** Owns only the tokens 'good' and 'bad'; any other handshake is left to the sources of other test files. */
export class TestPrincipalSource extends SocketPrincipalSource {
  public readonly name = 'test';
  public readonly order = 0;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    switch (handshake.auth.token) {
      case 'good':
        return ALICE_PRINCIPAL;
      case 'bad':
        throw new AuthenticationFailed('invalid token');
      default:
        return null;
    }
  }
}

DI.register(TestHttpHost).as(SocketHttpHost);
DI.register(TestPrincipalSource).as(SocketPrincipalSource);

let overrides: Record<string, unknown> = {};

export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return _.merge(
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        configuration: { isProduction: false },
        http: { socket: _.cloneDeep(socketConfig.http.socket) },
      },
      overrides,
    );
  }
}

/** Fresh DI cache and configuration; `cfg` is merged over the test defaults. */
export async function configure(cfg: Record<string, unknown> = {}): Promise<void> {
  overrides = cfg;
  DI.clearCache();
  DI.register(TestConfiguration).as(Configuration);
  await DI.resolve(Configuration);
}

export interface ITestServer {
  server: SocketServer;
  url: string;
  path: string;
  close(): Promise<void>;
}

export async function startServer(cfg: Record<string, unknown> = {}): Promise<ITestServer> {
  await configure(cfg);

  const host = DI.resolve(SocketHttpHost) as TestHttpHost;
  const server = await DI.resolve(SocketServer);
  await new Promise<void>((resolve) => host.Http.listen(0, '127.0.0.1', () => resolve()));
  const { port } = host.Http.address() as AddressInfo;

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    path: DI.get(Configuration).get<string>('http.socket.path'),
    close: async () => {
      await server.dispose();
      host.Http.closeAllConnections();
      await new Promise<void>((resolve) => host.Http.close(() => resolve()));
    },
  };
}

export interface IConnectOptions {
  auth?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export function connect(t: ITestServer, options: IConnectOptions = {}): ClientSocket {
  return io(t.url, {
    path: t.path,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { protocol: PROTOCOL_VERSION, clientId: 'client-1', ...options.auth },
    extraHeaders: options.headers,
  });
}

export function connected(socket: ClientSocket): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

export function open(t: ITestServer, options: IConnectOptions = {}): Promise<ClientSocket> {
  return connected(connect(t, options));
}

/** The SocketError of a refused handshake; fails when the handshake is accepted. The caller closes `socket`. */
export function refusalOf(socket: ClientSocket): Promise<SocketError> {
  return connected(socket).then(
    () => {
      throw new Error('the handshake was accepted');
    },
    (err: { data: SocketError }) => err.data,
  );
}

let sequence = 0;

export function nextId(): string {
  sequence += 1;
  return `req-${sequence}`;
}

export function command<R = unknown>(socket: ClientSocket, name: string, payload?: unknown, extra: Partial<CommandRequest> = {}): Promise<CommandReply<R>> {
  const request: CommandRequest = { id: nextId(), name, payload, ...extra };
  return socket.timeout(5000).emitWithAck(WIRE_EVENTS.command, request) as Promise<CommandReply<R>>;
}

export function errorOf(reply: CommandReply): SocketError {
  if (reply.ok) {
    throw new Error(`expected an error reply, got ${JSON.stringify(reply)}`);
  }
  return reply.error;
}

export function resultOf<R>(reply: CommandReply<R>): R {
  if (!reply.ok || !('result' in reply)) {
    throw new Error(`expected a result reply, got ${JSON.stringify(reply)}`);
  }
  return reply.result;
}

export function nextEvent<P = unknown>(socket: ClientSocket, name: string, timeoutMs = 2000): Promise<P> {
  return new Promise((resolve, reject) => {
    const listener = (frame: EventFrame<P>) => {
      if (frame.name !== name) {
        return;
      }
      clearTimeout(timer);
      socket.off(WIRE_EVENTS.event, listener);
      resolve(frame.payload);
    };
    const timer = setTimeout(() => {
      socket.off(WIRE_EVENTS.event, listener);
      reject(new Error(`no ${name} event within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.on(WIRE_EVENTS.event, listener);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) {
      throw new Error('condition not met in time');
    }
    await delay(10);
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/http-socket/test/handshake.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { UNATTENDED } from '@spinajs/authz';
import { PROTOCOL_VERSION } from '@spinajs/http-socket-common';
import { SocketHub } from '../src/hub.js';
import { ALICE, ALICE_PRINCIPAL, IConnectOptions, ITestServer, connect, open, refusalOf, startServer, waitFor } from './harness.js';

describe('socket handshake', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const track = (socket: ClientSocket): ClientSocket => {
    sockets.push(socket);
    return socket;
  };

  const refusal = (options: IConnectOptions) => refusalOf(track(connect(t, options)));

  beforeEach(async () => {
    t = await startServer();
  });

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('accepts a client speaking the current protocol and runs it as UNATTENDED without credentials', async () => {
    const socket = track(await open(t, { auth: { clientId: 'c-accept' } }));
    const connection = DI.resolve(SocketHub).connection(socket.id!)!;

    expect(connection.clientId).to.equal('c-accept');
    expect(connection.principal).to.equal(UNATTENDED);
    expect(connection.authenticated).to.be.false;
    expect(connection.user).to.be.undefined;
  });

  it('refuses another protocol version with version_mismatch', async () => {
    const error = await refusal({ auth: { protocol: 999 } });
    expect(error).to.include({ code: 'version_mismatch', retryable: false });
    expect(error.details).to.deep.equal({ server: PROTOCOL_VERSION });
  });

  it('refuses a handshake without a protocol version', async () => {
    const error = await refusal({ auth: { protocol: undefined } });
    expect(error.code).to.equal('version_mismatch');
  });

  it('refuses a handshake without a clientId', async () => {
    const error = await refusal({ auth: { clientId: '' } });
    expect(error).to.include({ code: 'invalid_argument', retryable: false });
  });

  it('refuses when a principal source throws', async () => {
    const error = await refusal({ auth: { token: 'bad' } });
    expect(error).to.deep.equal({ code: 'unauthenticated', message: 'invalid token', retryable: false });
  });

  it('keeps the principal a source returns, with its identity as the user', async () => {
    const socket = track(await open(t, { auth: { token: 'good' } }));
    const connection = DI.resolve(SocketHub).connection(socket.id!)!;

    expect(connection.principal).to.equal(ALICE_PRINCIPAL);
    expect(connection.authenticated).to.be.true;
    expect(connection.auth.source).to.equal('test');
    expect(connection.user).to.deep.equal(ALICE);
  });

  it('exposes handshake headers and cookies', async () => {
    const socket = track(await open(t, { headers: { cookie: 'sid=abc%20def; theme="dark"', 'x-app': 'editor' } }));
    const connection = DI.resolve(SocketHub).connection(socket.id!)!;

    expect({ ...connection.handshake.cookies }).to.deep.equal({ sid: 'abc def', theme: 'dark' });
    expect(connection.handshake.headers['x-app']).to.equal('editor');
  });

  it('drops the connection from the hub on disconnect', async () => {
    const socket = track(await open(t));
    const id = socket.id!;
    const hub = DI.resolve(SocketHub);

    expect(hub.connection(id)).to.exist;
    socket.disconnect();
    await waitFor(() => hub.connection(id) === undefined);
  });
});

describe('socket handshake: origin and required authentication', function () {
  this.timeout(15000);

  let t: ITestServer | undefined;
  let sockets: ClientSocket[] = [];

  const track = (socket: ClientSocket): ClientSocket => {
    sockets.push(socket);
    return socket;
  };

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t?.close();
    t = undefined;
  });

  it('refuses a handshake without credentials when http.socket.auth.required is set, and accepts one with', async () => {
    t = await startServer({ http: { socket: { auth: { required: true } } } });

    expect(await refusalOf(track(connect(t)))).to.deep.equal({ code: 'unauthenticated', message: 'authentication required', retryable: false });
    expect(track(await open(t, { auth: { token: 'good' } })).connected).to.be.true;
  });

  it('SR-12 refuses a cross-origin handshake before any principal source runs (empty origin list)', async () => {
    t = await startServer();

    const error = await refusalOf(track(connect(t, { auth: { token: 'bad' }, headers: { origin: 'https://evil.example' } })));
    expect(error).to.deep.equal({ code: 'forbidden', message: 'origin not allowed', retryable: false });
  });

  it('SR-12 accepts same-origin and exactly listed origins only; no wildcard', async () => {
    t = await startServer({ http: { socket: { cors: { origins: ['https://app.example', '*'] } } } });

    expect(track(await open(t, { headers: { origin: t.url } })).connected).to.be.true;
    expect(track(await open(t, { headers: { origin: 'https://app.example' } })).connected).to.be.true;
    expect((await refusalOf(track(connect(t, { headers: { origin: 'https://other.example' } })))).code).to.equal('forbidden');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/handshake.test.ts`
Expected: FAIL with `Cannot find module '../src/server.js'` (the harness imports it).

- [ ] **Step 4: Add the handshake types**

At the top of `packages/http-socket/src/interfaces.ts`, add:

```ts
import type { IncomingHttpHeaders, Server as HttpNodeServer } from 'http';
import type { Server as HttpsNodeServer } from 'https';
import { principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
```

Append to `packages/http-socket/src/interfaces.ts`:

```ts
/** What a `SocketPrincipalSource` sees of the socket.io handshake. */
export interface ISocketHandshake {
  /** `io(url, { auth })`: protocol, clientId, token and any app fields */
  readonly auth: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<IncomingHttpHeaders>;
  /** Unsigned raw cookie values; signed-cookie checks belong to the source. */
  readonly cookies: Readonly<Record<string, string>>;
  /** the socket's remote address; never taken from X-Forwarded-For */
  readonly address: string;
  readonly url: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly secure: boolean;
  readonly issuedAt: number;
}

/**
 * Resolves the authz-v3 principal of a connection from its handshake: the socket form of
 * authz-http's `PrincipalSource`, whose `authenticate(req)` needs an express request that
 * authn-http's middleware has already seen. Sources run in ascending `order` and the first
 * non-null principal wins. Return null when the handshake carries none of your credentials;
 * throw ( eg. `Unauthenticated` ) to refuse the connection.
 */
export abstract class SocketPrincipalSource {
  public abstract readonly name: string;

  public abstract readonly order: number;

  public abstract authenticate(handshake: ISocketHandshake): Promise<Principal | null>;

  /** Re-checks a live connection ( expiry, revocation ): by default the handshake must still authenticate as the same principal. */
  public async revalidate(handshake: ISocketHandshake, principal: Principal): Promise<boolean> {
    try {
      const again = await this.authenticate(handshake);
      return again !== null && principalKey(again) === principalKey(principal);
    } catch {
      return false;
    }
  }
}

/** Kept in `socket.data.auth`, which connection state recovery restores after a short drop. */
export interface ISocketAuthState {
  principal: Principal;
  /** name of the source that resolved the principal; null for UNATTENDED */
  source: string | null;
  /** ms epoch of the last successful check */
  checkedAt: number;
}

/** Supplies the node http(s) server socket.io attaches to. */
export abstract class SocketHttpHost {
  public abstract server(): Promise<HttpNodeServer | HttpsNodeServer>;
}
```

- [ ] **Step 5: Write the origin guard, the connection, hub, host and server**

Create `packages/http-socket/src/origin.ts`:

```ts
import type { IncomingHttpHeaders } from 'http';

/**
 * CORS does not cover a WebSocket upgrade, and a browser sends the user's cookies with a socket
 * opened from any site. So the handshake itself admits only clients without an Origin ( not a
 * browser ), same-origin pages and exactly listed origins ( SR-12, authz-v3 A31 ).
 */
export function isAllowedOrigin(headers: Readonly<IncomingHttpHeaders>, origins: readonly string[]): boolean {
  const origin = headers.origin;

  if (origin === undefined) {
    return true;
  }

  if (origin !== '*' && origins.includes(origin)) {
    return true;
  }

  try {
    return typeof headers.host === 'string' && new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}
```

Create `packages/http-socket/src/connection.ts`:

```ts
import { Socket } from 'socket.io';
import { UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DisconnectNotice, EventFrame, SYSTEM_EVENTS, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { ISocketAuthState, ISocketHandshake } from './interfaces.js';

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies = Object.create(null) as Record<string, string>;

  if (!header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }

    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();

    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    try {
      value = decodeURIComponent(value);
    } catch {
      // malformed escape: keep the raw value
    }

    if (!(name in cookies)) {
      cookies[name] = value;
    }
  }

  return cookies;
}

export function toHandshake(socket: Socket): ISocketHandshake {
  const h = socket.handshake;

  return {
    auth: { ...(h.auth as Record<string, unknown>) },
    headers: h.headers,
    cookies: parseCookies(h.headers.cookie),
    address: h.address,
    url: h.url,
    query: { ...h.query },
    secure: h.secure,
    issuedAt: h.issued,
  };
}

export class SocketConnection<D extends Record<string, unknown> = Record<string, unknown>, U = unknown> {
  public readonly id: string;
  public readonly clientId: string;
  public readonly handshake: ISocketHandshake;
  public readonly connectedAt: number;

  protected readonly lifetime = new AbortController();

  constructor(
    protected readonly socket: Socket,
    handshake: ISocketHandshake,
  ) {
    this.id = socket.id;
    this.clientId = String(handshake.auth.clientId);
    this.handshake = handshake;
    this.connectedAt = Date.now();

    if (!socket.data.auth) {
      const unattended: ISocketAuthState = { principal: UNATTENDED, source: null, checkedAt: this.connectedAt };
      socket.data.auth = unattended;
    }

    if (!socket.data.app) {
      socket.data.app = {};
    }
  }

  /** Principal, its source and the last check. Kept in `socket.data`, which connection state recovery restores. */
  public get auth(): ISocketAuthState {
    return this.socket.data.auth as ISocketAuthState;
  }

  /** The authz-v3 principal; UNATTENDED when no SocketPrincipalSource resolved one. */
  public get principal(): Principal {
    return this.auth.principal;
  }

  /** True when a SocketPrincipalSource resolved the principal. */
  public get authenticated(): boolean {
    return this.auth.source !== null;
  }

  /** The principal's identity record ( `Principal.identity`, eg. the User model ). */
  public get user(): U | undefined {
    return this.principal.identity as U | undefined;
  }

  /** App data bag. Kept in `socket.data`, which connection state recovery restores after a short drop. */
  public get data(): D {
    return this.socket.data.app as D;
  }

  public get rooms(): ReadonlySet<string> {
    const rooms = new Set(this.socket.rooms);
    rooms.delete(this.socket.id);
    return rooms;
  }

  public get connected(): boolean {
    return this.socket.connected;
  }

  /** Aborted when the connection closes. */
  public get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  public emit<P>(name: string, payload: P): void {
    const frame: EventFrame<P> = { name, payload };
    this.socket.emit(WIRE_EVENTS.event, frame);
  }

  public join(room: string | string[]): void {
    void this.socket.join(room);
  }

  public leave(room: string): void {
    void this.socket.leave(room);
  }

  /** Tells the client why, then closes. A server-side disconnect stops socket.io's auto-reconnect. */
  public disconnect(reason: string): void {
    const notice: DisconnectNotice = { reason };
    this.emit(SYSTEM_EVENTS.disconnect, notice);
    this.socket.disconnect(false);
  }

  /** @internal called by the server when the transport closes */
  public close(reason: unknown): void {
    if (!this.lifetime.signal.aborted) {
      this.lifetime.abort(reason);
    }
  }
}
```

Create `packages/http-socket/src/hub.ts`:

```ts
import { Server } from 'socket.io';
import { Injectable } from '@spinajs/di';
import { SocketConnection } from './connection.js';

@Injectable()
export class SocketHub {
  protected io: Server | null = null;
  protected connections = new Map<string, SocketConnection>();

  public attach(io: Server): void {
    this.io = io;
  }

  public detach(): void {
    this.io = null;
    this.connections.clear();
  }

  public register(connection: SocketConnection): void {
    this.connections.set(connection.id, connection);
  }

  public unregister(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /** A connection held by THIS instance; undefined for unknown ids or connections on other instances. */
  public connection(connectionId: string): SocketConnection | undefined {
    return this.connections.get(connectionId);
  }

  public get Connections(): ReadonlyMap<string, SocketConnection> {
    return this.connections;
  }
}
```

Create `packages/http-socket/src/host.ts`:

```ts
import { Server as HttpNodeServer } from 'http';
import { Server as HttpsNodeServer } from 'https';
import { DI, Injectable } from '@spinajs/di';
import { HttpServer } from '@spinajs/http';
import { SocketHttpHost } from './interfaces.js';

/** Default host: the http(s) server of `@spinajs/http`. Resolve SocketServer after HttpServer, before or after `start()`. */
@Injectable(SocketHttpHost)
export class HttpServerHost extends SocketHttpHost {
  public async server(): Promise<HttpNodeServer | HttpsNodeServer> {
    const http = await DI.resolve(HttpServer);
    return http.Server;
  }
}
```

Create `packages/http-socket/src/server.ts`:

```ts
import { Server, ServerOptions, Socket } from 'socket.io';
import { AsyncService, Autoinject, ClassInfo, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ListFromFiles } from '@spinajs/reflection';
import { UNATTENDED, Unauthenticated } from '@spinajs/authz';
import { MAX_ID_LENGTH, PROTOCOL_VERSION, SocketError, SocketException } from '@spinajs/http-socket-common';
import { ISocketAuthState, ISocketServerConfig, SocketHttpHost, SocketPrincipalSource } from './interfaces.js';
import { SocketConnection, toHandshake } from './connection.js';
import { SocketErrorMapper } from './errors.js';
import { SocketHub } from './hub.js';
import { isAllowedOrigin } from './origin.js';
import './host.js';

/** socket.io hands `data` to the client as the `connect_error` payload. */
function refusal(wire: SocketError): Error & { data: SocketError } {
  const err = new Error(wire.message) as Error & { data: SocketError };
  err.data = wire;
  return err;
}

@Injectable()
export class SocketServer extends AsyncService {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  @Autoinject()
  protected Host: SocketHttpHost;

  @Autoinject()
  protected Hub: SocketHub;

  @Autoinject()
  protected Errors: SocketErrorMapper;

  @Autoinject(SocketPrincipalSource)
  protected Sources: SocketPrincipalSource[];

  // Loading the files is what runs their @SocketController decorators.
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.socketControllers')
  protected ControllerFiles: Promise<Array<ClassInfo<unknown>>>;

  protected _io: Server | null = null;

  public get Io(): Server | null {
    return this._io;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    await this.ControllerFiles;

    const io = new Server(await this.Host.server(), this.ioOptions());
    io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (err: Error) => next(err),
      );
    });
    io.on('connection', (socket) => this.onConnection(socket));

    this.Hub.attach(io);
    this._io = io;
  }

  public async dispose(): Promise<void> {
    const io = this._io;
    if (!io) {
      return;
    }

    this._io = null;
    io.disconnectSockets(true);
    io.engine.close();
    this.Hub.detach();
  }

  protected ioOptions(): Partial<ServerOptions> {
    const o = this.Options;
    const options: Partial<ServerOptions> = {
      path: o.path,
      pingInterval: o.pingInterval,
      pingTimeout: o.pingTimeout,
      // socket.io closes the whole connection on an oversized frame; the headroom lets the size
      // stage answer resource_exhausted for payloads up to twice the limit instead.
      maxHttpBufferSize: o.maxPayloadBytes * 2,
    };

    if (o.cors.origins.length > 0) {
      options.cors = { origin: [...o.cors.origins], credentials: true };
    }

    if (o.adapter) {
      options.adapter = o.adapter as ServerOptions['adapter'];
    }

    if ((o.recovery?.maxDisconnectionMs ?? 0) > 0) {
      options.connectionStateRecovery = { maxDisconnectionDuration: o.recovery.maxDisconnectionMs, skipMiddlewares: true };
    }

    return options;
  }

  protected async authenticate(socket: Socket): Promise<void> {
    try {
      // first: no principal source may read the credentials of a hijacked cross-site socket
      if (!isAllowedOrigin(socket.handshake.headers, this.Options.cors.origins)) {
        throw new SocketException('forbidden', 'origin not allowed');
      }

      const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;

      if (auth.protocol !== PROTOCOL_VERSION) {
        throw new SocketException('version_mismatch', `server speaks protocol ${PROTOCOL_VERSION}, client sent ${String(auth.protocol)}`, { details: { server: PROTOCOL_VERSION } });
      }

      if (typeof auth.clientId !== 'string' || auth.clientId.length === 0 || auth.clientId.length > MAX_ID_LENGTH) {
        throw new SocketException('invalid_argument', 'handshake auth.clientId must be a non-empty string');
      }

      socket.data.auth = await this.identify(socket);
    } catch (err) {
      const wire = this.Errors.toWire(err, 'handshake');
      this.Log.debug(`Socket handshake refused: ${wire.code} ${wire.message}`);
      throw refusal(wire);
    }
  }

  protected async identify(socket: Socket): Promise<ISocketAuthState> {
    const handshake = toHandshake(socket);
    const sources = [...this.Sources].sort((a, b) => a.order - b.order);

    for (const source of sources) {
      const principal = await source.authenticate(handshake);
      if (principal) {
        return { principal, source: source.name, checkedAt: Date.now() };
      }
    }

    if (this.Options.auth.required) {
      throw new Unauthenticated('authentication required');
    }

    return { principal: UNATTENDED, source: null, checkedAt: Date.now() };
  }

  protected onConnection(socket: Socket): void {
    const connection = new SocketConnection(socket, toHandshake(socket));
    this.Hub.register(connection);

    socket.on('disconnect', (reason: string) => {
      connection.close(reason);
      this.Hub.unregister(connection.id);
    });
  }
}
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './origin.js';
export * from './connection.js';
export * from './hub.js';
export * from './host.js';
export * from './server.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/handshake.test.ts`
Expected: `11 passing`.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/error-mapping.test.ts test/limits.test.ts test/config.test.ts`
Expected: `33 passing` (the harness rewrite keeps `configure` working).

- [ ] **Step 7: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/interfaces.ts packages/http-socket/src/origin.ts packages/http-socket/src/connection.ts packages/http-socket/src/hub.ts packages/http-socket/src/host.ts packages/http-socket/src/server.ts packages/http-socket/src/index.ts \
  packages/http-socket/test/harness.ts packages/http-socket/test/handshake.test.ts && \
git commit -m "feat(http-socket): handshake with origin guard, protocol check and authz-v3 principal sources (unattended by default)"
```

---

### Task 5A: `AuthnCredentialSource` — handshake credentials through `@spinajs/authn` contracts

This task owns plan C9's "socket principal" item and the socket side of the authz-v3 security findings that apply to a handshake (SR-03, SR-07, SR-12; rule A02). See D12.

**Files:**
- Create: `packages/http-socket/src/authn-source.ts`
- Modify: `packages/http-socket/src/server.ts` (one import line)
- Modify: `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/authn-source.test.ts`

**Interfaces:**
- Consumes: `SocketPrincipalSource`, `ISocketHandshake` (Task 5); from `@spinajs/authn/contracts`: `AuthnService` (`authenticate(c, ctx): Promise<AuthenticationResult>`, `principalOf(result)`), `CredentialExtractor` (`order`, `extract(req: SignedRequest): Credentials | null`), `SignedRequest`, `AuthnContext`, `Credentials`, `AuthenticationResult`; from `@spinajs/authz`: `Unauthenticated`.
- Produces:
  - `AUTHENTICATION_FAILED = 'authentication failed'`
  - `credentialRequest(handshake: ISocketHandshake): SignedRequest` (headers lower-cased, no `cookie`, `auth.token` → `authorization: Bearer …` unless the header is set)
  - `@Injectable(SocketPrincipalSource) class AuthnCredentialSource { name = 'authn'; order = 50 }`. It is inert while `DI.check(AuthnService)` is false.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/authn-source.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthnService, CredentialExtractor } from '@spinajs/authn/contracts';
import type { AuthenticationResult, AuthenticationStrategy, AuthnContext, Credentials, SignedRequest } from '@spinajs/authn/contracts';
import { UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { SocketHub } from '../src/hub.js';
import { IConnectOptions, ITestServer, connect, open, refusalOf, startServer } from './harness.js';

const BOB: Principal = Object.freeze({ type: 'user', id: 'bob', authenticated: true, source: 'token', attributes: Object.freeze({}), identity: { name: 'bob' } });

const FAILED = { code: 'unauthenticated', message: 'authentication failed', retryable: false };

export class AuthnTestExtractor extends CredentialExtractor {
  public static seen: SignedRequest[] = [];

  public readonly order = 10;

  public extract(req: SignedRequest): Credentials | null {
    AuthnTestExtractor.seen.push(req);
    const value = req.headers.authorization;
    return value?.startsWith('Bearer authn-') ? { kind: 'bearer', token: value.slice('Bearer '.length) } : null;
  }
}

export class AuthnTestService extends AuthnService {
  public static contexts: AuthnContext[] = [];

  public async authenticate(credentials: Credentials, ctx: AuthnContext): Promise<AuthenticationResult> {
    AuthnTestService.contexts.push(ctx);

    switch ((credentials as { token: string }).token) {
      case 'authn-ok':
        return { status: 'success', identity: { type: 'user', id: 'bob' }, facts: { method: 'token', strategy: 'token', assurance: 'aal1', mfa: [] } };
      case 'authn-mfa':
        return { status: 'mfa_required', pending: { id: 'pending-1', state: 'pending' }, steps: ['totp'] };
      case 'authn-throttled':
        return { status: 'failure', reason: 'throttled', retryAfterSeconds: 3 };
      case 'authn-revoked':
        return { status: 'failure', reason: 'revoked' };
      default:
        return { status: 'failure', reason: 'invalid_credentials' };
    }
  }

  public async principalOf(): Promise<Principal> {
    return BOB;
  }

  public async completeMfa(): Promise<AuthenticationResult> {
    throw new Error('not used by socket handshakes');
  }

  public async reauthenticate(): Promise<boolean> {
    throw new Error('not used by socket handshakes');
  }

  public strategies(): readonly AuthenticationStrategy[] {
    return [];
  }
}

describe('AuthnCredentialSource', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const track = (socket: ClientSocket): ClientSocket => {
    sockets.push(socket);
    return socket;
  };

  const principalOf = async (options: IConnectOptions): Promise<Principal> => {
    const socket = track(await open(t, options));
    return DI.resolve(SocketHub).connection(socket.id!)!.principal;
  };

  const refusal = (options: IConnectOptions) => refusalOf(track(connect(t, options)));

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  describe('with an AuthnService', () => {
    before(() => {
      DI.register(AuthnTestService).as(AuthnService);
      DI.register(AuthnTestExtractor).as(CredentialExtractor);
    });

    after(() => {
      DI.unregister(AuthnTestService);
      DI.unregister(AuthnTestExtractor);
    });

    beforeEach(async () => {
      t = await startServer();
    });

    it('resolves a token sent in auth.token through AuthnService.authenticate and principalOf', async () => {
      expect(await principalOf({ auth: { token: 'authn-ok' } })).to.equal(BOB);
      expect(AuthnTestService.contexts[AuthnTestService.contexts.length - 1].purpose).to.equal('request');
    });

    it('reads the Authorization header too', async () => {
      expect(await principalOf({ headers: { authorization: 'Bearer authn-ok' } })).to.equal(BOB);
    });

    it('A02 refuses every failure with one answer', async () => {
      expect(await refusal({ auth: { token: 'authn-wrong' } })).to.deep.equal(FAILED);
      expect(await refusal({ auth: { token: 'authn-revoked' } })).to.deep.equal(FAILED);
    });

    it('A06 a throttled handshake carries retryAfterMs', async () => {
      expect(await refusal({ auth: { token: 'authn-throttled' } })).to.deep.equal({ ...FAILED, retryAfterMs: 3000 });
    });

    it('SR-07 a login still pending MFA yields no principal', async () => {
      expect(await refusal({ auth: { token: 'authn-mfa' } })).to.deep.equal(FAILED);
    });

    it('SR-03 the client address is the socket address, never X-Forwarded-For', async () => {
      await principalOf({ auth: { token: 'authn-ok' }, headers: { 'x-forwarded-for': '6.6.6.6' } });
      const ctx = AuthnTestService.contexts[AuthnTestService.contexts.length - 1];

      expect(ctx.ip).to.match(/127\.0\.0\.1$/);
    });

    it('SR-12 cookies never reach the credential extractors', async () => {
      await principalOf({ auth: { token: 'authn-ok' }, headers: { cookie: 'ssid=stolen' } });
      const request = AuthnTestExtractor.seen[AuthnTestExtractor.seen.length - 1];

      expect(request.headers).not.to.have.property('cookie');
      expect(request.headers.authorization).to.equal('Bearer authn-ok');
    });

    it('leaves a handshake without credentials UNATTENDED', async () => {
      expect(await principalOf({})).to.equal(UNATTENDED);
    });
  });

  describe('without an AuthnService', () => {
    beforeEach(async () => {
      t = await startServer();
    });

    it('is inert: the token stays unread and the connection runs as UNATTENDED', async () => {
      expect(await principalOf({ auth: { token: 'authn-ok' } })).to.equal(UNATTENDED);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/authn-source.test.ts`
Expected: 7 failing and 2 passing. No source reads authn tokens yet, so `authn-ok` connections run as `UNATTENDED` and the refusal tests fail with `the handshake was accepted`. The two `UNATTENDED` tests pass.

- [ ] **Step 3: Write the implementation**

Create `packages/http-socket/src/authn-source.ts`:

```ts
import { DI, Injectable } from '@spinajs/di';
import { AuthnService, CredentialExtractor } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, SignedRequest } from '@spinajs/authn/contracts';
import { Unauthenticated } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketHandshake, SocketPrincipalSource } from './interfaces.js';

/** One answer for every failed attempt, as authn-http gives ( A02 ); the reason goes to authn's audit only. */
export const AUTHENTICATION_FAILED = 'authentication failed';

/**
 * The handshake as authn's `SignedRequest`. Browsers cannot set WebSocket headers, so a token in
 * `auth.token` becomes `Authorization: Bearer`. The Cookie header is left out: a browser sends
 * cookies with a socket opened from any site, so they are no credential here ( SR-12 ).
 */
export function credentialRequest(handshake: ISocketHandshake): SignedRequest {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(handshake.headers)) {
    const key = name.toLowerCase();
    if (key === 'cookie' || value === undefined) {
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  const token = handshake.auth.token;
  if (typeof token === 'string' && token.length > 0 && headers.authorization === undefined) {
    headers.authorization = `Bearer ${token}`;
  }

  return { method: 'GET', targetUri: handshake.url, headers };
}

/**
 * Bearer, key and signature credentials through `@spinajs/authn` ( throttled and audited by
 * AuthnService ), at order 50 like authz-http's AuthnPrincipalSource. Inert until an
 * AuthnService is registered.
 */
@Injectable(SocketPrincipalSource)
export class AuthnCredentialSource extends SocketPrincipalSource {
  public readonly name = 'authn';
  public readonly order = 50;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    if (!DI.check(AuthnService)) {
      return null;
    }

    const credentials = await this.extract(credentialRequest(handshake));
    if (!credentials) {
      return null;
    }

    const authn = (await DI.resolve(AuthnService)) as AuthnService;
    const userAgent = handshake.headers['user-agent'];
    const ctx: AuthnContext = { ip: handshake.address, userAgent: typeof userAgent === 'string' ? userAgent : undefined, now: new Date(), purpose: 'request' };
    const result = await authn.authenticate(credentials, ctx);

    if (result.status === 'success') {
      return authn.principalOf(result);
    }

    // mfa_required falls through: a login pending MFA is no principal ( SR-07 )
    if (result.status === 'failure' && result.retryAfterSeconds !== undefined) {
      throw new SocketException('unauthenticated', AUTHENTICATION_FAILED, { retryAfterMs: result.retryAfterSeconds * 1000 });
    }

    throw new Unauthenticated(AUTHENTICATION_FAILED);
  }

  protected async extract(request: SignedRequest): Promise<Credentials | null> {
    const extractors = [...((await DI.resolve(Array.ofType(CredentialExtractor))) as CredentialExtractor[])].sort((a, b) => a.order - b.order);

    for (const extractor of extractors) {
      const credentials = extractor.extract(request);
      if (credentials) {
        return credentials;
      }
    }

    return null;
  }
}
```

In `packages/http-socket/src/server.ts`, replace:

```ts
import './host.js';
```

with:

```ts
import './host.js';
import './authn-source.js';
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './authn-source.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/authn-source.test.ts test/handshake.test.ts`
Expected: `20 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/authn-source.ts packages/http-socket/src/server.ts packages/http-socket/src/index.ts packages/http-socket/test/authn-source.test.ts && \
git commit -m "feat(http-socket): AuthnCredentialSource resolves handshake credentials through the authn contracts"
```

---

### Task 6: Controller model — decorators, descriptor and argument extraction

**Files:**
- Modify: `packages/http-socket/src/interfaces.ts` (add imports at the top; append declarations)
- Create: `packages/http-socket/src/controller.ts`, `src/args.ts`, `src/decorators.ts`
- Modify: `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/controller-model.test.ts`

**Interfaces:**
- Consumes: `SocketConnection` (Task 5), `configure` (harness), http's `BasePolicy`, `IPolicyGroup`, `IResolvedRoutePolicies`, `ArgHydrator`, `extractSchemaFromRuntimeType`, `Hydrator`.
- Produces:
  - `SOCKET_CONTROLLER_DESCRIPTOR: symbol`
  - `SocketHandlerKind = 'unknown'|'command'|'event'|'connect'|'disconnect'`
  - `ICommandOptions { schema?: object; timeoutMs?: number; idempotent?: boolean; ordered?: 'connection'|'client' }`; `IEventOptions { schema?: object }`
  - `ISocketParameter { Index; Type: Class<SocketArg>; RuntimeType; Schema: object|null; Options? }`
  - `ISocketHandlerDescriptor { Kind; Method; Name; Options: ICommandOptions; Parameters: Map<number, ISocketParameter>; Policies: IPolicyGroup[] }`
  - `ISocketControllerDescriptor { Prefix: string|null; Policies: IPolicyGroup[]; Handlers: Map<string|symbol, ISocketHandlerDescriptor> }`
  - `IRegisteredHandler { fullName; controller: BaseSocketController; descriptor: ISocketHandlerDescriptor; policies: IResolvedRoutePolicies }`
  - `ISocketCallStorage extends IAuthnPrincipalStorage { Principal: Principal; AuthzDecision?: Decision; [key: string]: unknown }`: the call's AsyncLocalStorage store (D14)
  - `ISocketCallContext { kind; connection; handler?; payload; signal; reason?; storage: ISocketCallStorage }`
  - `abstract class SocketArg { abstract extract(ctx: ISocketCallContext, param: ISocketParameter): Promise<unknown> }`
  - `abstract class BaseSocketController extends AsyncService { [member: string]: any; get Descriptor(): ISocketControllerDescriptor | undefined }`
  - decorators `SocketController(prefix?)` (also registers the class in DI as `BaseSocketController`), `Command(name?, options?)`, `OnEvent(name?, options?)`, `OnConnect()`, `OnDisconnect()`, `SocketPolicyGroup(group: IPolicyGroup)` (one group with its own per-member options; Task 9A builds `@SocketAccess` on it), `SocketPolicy(policy|policy[], ...options)`, `SocketParameter(type, schema?, options?)`, `Payload(schema?)`, `Connection()`, `Signal()`, `Reason()`, `FromDI(...options)`
  - `PayloadArg`, `ConnectionArg`, `SignalArg`, `ReasonArg`, `FromDiArg`, `SocketArgumentResolver { resolve(ctx: ISocketCallContext): Promise<unknown[]> }`

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/controller-model.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ArgHydrator, BasePolicy, Hydrator } from '@spinajs/http';
import { DataValidator, Schema, ValidationFailed } from '@spinajs/validation';
import { UNATTENDED } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, FromDI, OnConnect, OnDisconnect, OnEvent, Payload, Reason, Signal, SocketController, SocketPolicy } from '../src/decorators.js';
import { ConnectionArg, FromDiArg, PayloadArg, ReasonArg, SignalArg, SocketArgumentResolver } from '../src/args.js';
import { IRegisteredHandler, ISocketCallContext, ISocketControllerDescriptor, SOCKET_CONTROLLER_DESCRIPTOR } from '../src/interfaces.js';
import { SocketConnection } from '../src/connection.js';
import { configure } from './harness.js';

export class ModelAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

@Schema({ type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1 } } })
export class ModelCreateDoc {
  public title: string;

  constructor(data: Partial<ModelCreateDoc> = {}) {
    Object.assign(this, data);
  }
}

export class ModelShoutHydrator extends ArgHydrator {
  public async hydrate(input: { text: string }): Promise<ModelShout> {
    return new ModelShout(String(input.text).toUpperCase());
  }
}

@Hydrator(ModelShoutHydrator)
export class ModelShout {
  constructor(public text: string) {}
}

@SocketController('model')
@SocketPolicy(ModelAllow)
export class ModelSocket extends BaseSocketController {
  @Command('create', { timeoutMs: 1000, ordered: 'connection', idempotent: true })
  public async create(@Payload() doc: ModelCreateDoc, @Connection() conn: SocketConnection, @Signal() signal: AbortSignal) {
    return { doc, conn, signal };
  }

  @Command('strict', { schema: { type: 'object', required: ['x'] } })
  public async strict(@Payload() body: ModelCreateDoc) {
    return body;
  }

  @Command('shout')
  public async shout(@Payload() shout: ModelShout) {
    return shout;
  }

  @Command()
  @SocketPolicy([ModelAllow, ModelAllow])
  public async plain(@FromDI() validator: DataValidator) {
    return validator;
  }

  @OnEvent('cursor')
  public async cursor(@Payload() at: unknown) {
    return at;
  }

  @OnConnect()
  public async joined(@Connection() conn: SocketConnection) {
    return conn;
  }

  @OnDisconnect()
  public async left(@Reason() reason: string) {
    return reason;
  }
}

export class ModelParent extends BaseSocketController {
  @Command('shared')
  public async shared() {
    return 'parent';
  }
}

@SocketController('model-kid')
export class ModelKid extends ModelParent {
  @Command('own')
  public async own() {
    return 'kid';
  }
}

export class ModelProbe extends BaseSocketController {
  public probe(): void {}
}

const descriptorOf = (type: { prototype: object }): ISocketControllerDescriptor => Reflect.getMetadata(SOCKET_CONTROLLER_DESCRIPTOR, type.prototype) as ISocketControllerDescriptor;

describe('socket controller model', function () {
  this.timeout(15000);

  describe('descriptor', () => {
    it('collects the prefix and controller-wide policies', () => {
      const d = descriptorOf(ModelSocket);
      expect(d.Prefix).to.equal('model');
      expect(d.Policies).to.have.length(1);
      expect(d.Policies[0][0].Type).to.equal(ModelAllow);
    });

    it('describes a command with its options and parameters', () => {
      const h = descriptorOf(ModelSocket).Handlers.get('create')!;
      expect(h.Kind).to.equal('command');
      expect(h.Name).to.equal('create');
      expect(h.Options).to.deep.equal({ timeoutMs: 1000, ordered: 'connection', idempotent: true });
      expect([0, 1, 2].map((i) => h.Parameters.get(i)!.Type)).to.deep.equal([PayloadArg, ConnectionArg, SignalArg]);
      expect(h.Parameters.get(0)!.RuntimeType).to.equal(ModelCreateDoc);
    });

    it('names a handler after its method by default and keeps policy groups', () => {
      const h = descriptorOf(ModelSocket).Handlers.get('plain')!;
      expect(h.Name).to.equal('plain');
      expect(h.Policies).to.have.length(1);
      expect(h.Policies[0]).to.have.length(2);
      expect(h.Parameters.get(0)!.Type).to.equal(FromDiArg);
      expect(h.Parameters.get(0)!.RuntimeType).to.equal(DataValidator);
    });

    it('marks events and lifecycle hooks', () => {
      const d = descriptorOf(ModelSocket);
      expect(d.Handlers.get('cursor')!.Kind).to.equal('event');
      expect(d.Handlers.get('joined')!.Kind).to.equal('connect');
      expect(d.Handlers.get('left')!.Kind).to.equal('disconnect');
      expect(d.Handlers.get('left')!.Parameters.get(0)!.Type).to.equal(ReasonArg);
    });

    it('refuses two handler kinds on one method', () => {
      const member = Object.getOwnPropertyDescriptor(ModelProbe.prototype, 'probe')!;
      OnEvent()(ModelProbe.prototype, 'probe', member);
      expect(() => Command()(ModelProbe.prototype, 'probe', member)).to.throw(/already a socket event handler/);
    });

    it('keeps parent and subclass descriptors apart', () => {
      const parent = descriptorOf(ModelParent);
      const kid = descriptorOf(ModelKid);
      expect([...parent.Handlers.keys()]).to.deep.equal(['shared']);
      expect(parent.Prefix).to.be.null;
      expect([...kid.Handlers.keys()]).to.have.members(['shared', 'own']);
      expect(kid.Prefix).to.equal('model-kid');
      expect(kid.Handlers.get('shared')).not.to.equal(parent.Handlers.get('shared'));
    });

    it('registers decorated controllers in DI', () => {
      const types = DI.getRegisteredTypes(BaseSocketController);
      expect(types).to.include(ModelSocket);
      expect(types).to.include(ModelKid);
      expect(types).not.to.include(ModelParent);
    });
  });

  describe('argument extraction', () => {
    const connection = { id: 'conn-1', clientId: 'client-1' } as unknown as SocketConnection;
    let resolver: SocketArgumentResolver;

    const handlerOf = async (method: string): Promise<IRegisteredHandler> => {
      const controller = await DI.resolve(ModelSocket);
      return { fullName: `model.${method}`, controller, descriptor: controller.Descriptor!.Handlers.get(method)!, policies: { Controller: [], Route: [] } };
    };

    const call = (handler: IRegisteredHandler, payload: unknown, extra: Partial<ISocketCallContext> = {}): ISocketCallContext => ({
      kind: handler.descriptor.Kind,
      connection,
      handler,
      payload,
      signal: new AbortController().signal,
      storage: { Principal: UNATTENDED },
      ...extra,
    });

    beforeEach(async () => {
      await configure();
      resolver = await DI.resolve(SocketArgumentResolver);
    });

    it('validates and hydrates the payload against the DTO schema, and passes connection and signal', async () => {
      const signal = new AbortController().signal;
      const args = await resolver.resolve(call(await handlerOf('create'), { title: 'a' }, { signal }));
      expect(args[0]).to.be.instanceOf(ModelCreateDoc);
      expect((args[0] as ModelCreateDoc).title).to.equal('a');
      expect(args[1]).to.equal(connection);
      expect(args[2]).to.equal(signal);
    });

    it('rejects a payload that breaks the DTO schema', async () => {
      await expect(resolver.resolve(call(await handlerOf('create'), { title: '' }))).to.be.rejectedWith(ValidationFailed);
    });

    it('rejects a missing payload when a schema applies', async () => {
      await expect(resolver.resolve(call(await handlerOf('create'), undefined))).to.be.rejectedWith(InvalidArgument, /payload is required/);
    });

    it('prefers the command schema over the DTO schema', async () => {
      await expect(resolver.resolve(call(await handlerOf('strict'), { title: 'a' }))).to.be.rejectedWith(ValidationFailed);
    });

    it('uses a registered hydrator', async () => {
      const args = await resolver.resolve(call(await handlerOf('shout'), { text: 'hi' }));
      expect(args[0]).to.be.instanceOf(ModelShout);
      expect((args[0] as ModelShout).text).to.equal('HI');
    });

    it('injects services and the disconnect reason', async () => {
      const [validator] = await resolver.resolve(call(await handlerOf('plain'), undefined));
      expect(validator).to.be.instanceOf(DataValidator);
      expect(await resolver.resolve(call(await handlerOf('left'), undefined, { reason: 'transport close' }))).to.deep.equal(['transport close']);
    });

    it('passes an untyped payload through unchanged', async () => {
      const at = { x: 1 };
      const [arg] = await resolver.resolve(call(await handlerOf('cursor'), at));
      expect(arg).to.equal(at);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/controller-model.test.ts`
Expected: FAIL with `Cannot find module '../src/controller.js'`.

- [ ] **Step 3: Add the controller-model types**

At the top of `packages/http-socket/src/interfaces.ts`, add (under the Task 5 imports):

```ts
import type { Class } from '@spinajs/di';
import type { IPolicyGroup, IResolvedRoutePolicies } from '@spinajs/http';
import type { Decision, IAuthnPrincipalStorage } from '@spinajs/authz';
import type { SocketConnection } from './connection.js';
import type { BaseSocketController } from './controller.js';
```

Append to `packages/http-socket/src/interfaces.ts`:

```ts
export const SOCKET_CONTROLLER_DESCRIPTOR = Symbol('SOCKET_CONTROLLER_DESCRIPTOR');

export type SocketHandlerKind = 'unknown' | 'command' | 'event' | 'connect' | 'disconnect';

export interface ICommandOptions {
  /** ajv schema for the payload; wins over the `@Payload` schema and the DTO's `@Schema` */
  schema?: object;
  /** server-side deadline; the earlier of this and the client's `deadline` applies */
  timeoutMs?: number;
  /** W3: replay by `(clientId, idempotencyKey)` */
  idempotent?: boolean;
  /** serial queue per connection, or per clientId across reconnects */
  ordered?: 'connection' | 'client';
}

export interface IEventOptions {
  schema?: object;
}

export interface ISocketParameter {
  Index: number;
  /** extractor resolved from DI */
  Type: Class<SocketArg>;
  /** design:paramtypes entry */
  RuntimeType: unknown;
  Schema: object | null;
  Options?: unknown;
}

export interface ISocketHandlerDescriptor {
  /** 'unknown' until a handler decorator runs; registration refuses it */
  Kind: SocketHandlerKind;
  Method: string | symbol;
  /** name without the controller prefix */
  Name: string;
  Options: ICommandOptions;
  Parameters: Map<number, ISocketParameter>;
  /** one group per @SocketPolicy call: AND inside a group, OR across groups */
  Policies: IPolicyGroup[];
}

export interface ISocketControllerDescriptor {
  Prefix: string | null;
  Policies: IPolicyGroup[];
  Handlers: Map<string | symbol, ISocketHandlerDescriptor>;
}

export interface IRegisteredHandler {
  /** prefix + '.' + name */
  readonly fullName: string;
  readonly controller: BaseSocketController;
  readonly descriptor: ISocketHandlerDescriptor;
  readonly policies: IResolvedRoutePolicies;
}

/**
 * The AsyncLocalStorage store of one call ( D14 ). `Principal` is the key authz-v3's
 * `AuthzService.current()` reads ( F4 `IAuthzAsyncStorage`, as http's `req.storage.Principal` );
 * `AuthnPrincipal` is authn's hand-off key: the principal when a source resolved it, else null.
 */
export interface ISocketCallStorage extends IAuthnPrincipalStorage {
  Principal: Principal;
  /** written by SocketAccessPolicy, as authz-http's AccessPolicy writes req.storage.AuthzDecision */
  AuthzDecision?: Decision;
  [key: string]: unknown;
}

/** What argument extractors, policies and hooks see of one call. */
export interface ISocketCallContext {
  readonly kind: SocketHandlerKind;
  readonly connection: SocketConnection;
  handler?: IRegisteredHandler;
  readonly payload: unknown;
  readonly signal: AbortSignal;
  /** disconnect reason, for @OnDisconnect hooks */
  readonly reason?: string;
  /** ambient AsyncLocalStorage store of the call */
  readonly storage: ISocketCallStorage;
}

/** Extracts one handler argument. Implementations are resolved from DI by class. */
export abstract class SocketArg {
  public abstract extract(ctx: ISocketCallContext, param: ISocketParameter): Promise<unknown>;
}
```

- [ ] **Step 4: Write the controller base, the argument extractors and the decorators**

Create `packages/http-socket/src/controller.ts`:

```ts
import { AsyncService } from '@spinajs/di';
import { ISocketControllerDescriptor, SOCKET_CONTROLLER_DESCRIPTOR } from './interfaces.js';

export abstract class BaseSocketController extends AsyncService {
  [member: string]: any;

  public get Descriptor(): ISocketControllerDescriptor | undefined {
    return Reflect.getMetadata(SOCKET_CONTROLLER_DESCRIPTOR, this) as ISocketControllerDescriptor | undefined;
  }
}
```

Create `packages/http-socket/src/args.ts`:

```ts
import { Autoinject, Class, DI, Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ArgHydrator, IRouteParameter, extractSchemaFromRuntimeType } from '@spinajs/http';
import { DataValidator } from '@spinajs/validation';
import { ISocketCallContext, ISocketParameter, SocketArg } from './interfaces.js';

const PLAIN_TYPES = new Set<unknown>([Object, Array, String, Number, Boolean]);

interface IHydratorMetadata {
  hydrator: Class<ArgHydrator>;
  options: unknown[] | null;
}

/**
 * The payload, validated against the command `schema`, else the `@Payload(schema)`, else the DTO's
 * `@Schema`, then hydrated as http hydrates a body ( `@Hydrator`, else `new Dto(payload)` ).
 */
@Injectable()
export class PayloadArg extends SocketArg {
  @Autoinject()
  protected Validator: DataValidator;

  public async extract(ctx: ISocketCallContext, param: ISocketParameter): Promise<unknown> {
    const payload = ctx.payload;
    const schema = ctx.handler?.descriptor.Options.schema ?? param.Schema ?? this.schemaOfType(param.RuntimeType);

    if (schema) {
      // DataValidator.validate(schema, undefined) would validate the schema object itself
      if (payload === undefined || payload === null) {
        throw new InvalidArgument('payload is required');
      }

      this.Validator.validate(schema, payload as object);
    }

    return this.hydrate(payload, param);
  }

  protected schemaOfType(type: unknown): object | null {
    if (typeof type !== 'function' || PLAIN_TYPES.has(type)) {
      return null;
    }

    return (extractSchemaFromRuntimeType(type, this.Validator) as object | undefined) ?? null;
  }

  protected async hydrate(payload: unknown, param: ISocketParameter): Promise<unknown> {
    const type = param.RuntimeType;

    if (payload === undefined || payload === null || typeof type !== 'function' || PLAIN_TYPES.has(type)) {
      return payload;
    }

    const meta = Reflect.getMetadata('custom:arg_hydrator', type) as IHydratorMetadata | undefined;
    if (meta) {
      const hydrator = await DI.resolve<ArgHydrator>(meta.hydrator, meta.options ?? undefined);
      return hydrator.hydrate(payload, param as unknown as IRouteParameter);
    }

    return new (type as new (data: unknown) => unknown)(payload);
  }
}

@Injectable()
export class ConnectionArg extends SocketArg {
  public async extract(ctx: ISocketCallContext): Promise<unknown> {
    return ctx.connection;
  }
}

@Injectable()
export class SignalArg extends SocketArg {
  public async extract(ctx: ISocketCallContext): Promise<unknown> {
    return ctx.signal;
  }
}

@Injectable()
export class ReasonArg extends SocketArg {
  public async extract(ctx: ISocketCallContext): Promise<unknown> {
    return ctx.reason ?? null;
  }
}

@Injectable()
export class FromDiArg extends SocketArg {
  public async extract(_ctx: ISocketCallContext, param: ISocketParameter): Promise<unknown> {
    return DI.resolve(param.RuntimeType as Class<unknown>, param.Options as unknown[] | undefined);
  }
}

@Injectable()
export class SocketArgumentResolver {
  public async resolve(ctx: ISocketCallContext): Promise<unknown[]> {
    const handler = ctx.handler;
    if (!handler) {
      throw new InvalidArgument('socket handler arguments cannot be resolved before the handler is known');
    }

    const params = [...handler.descriptor.Parameters.values()];
    const args = new Array<unknown>(params.reduce((max, p) => Math.max(max, p.Index + 1), 0));

    for (const param of params) {
      const extractor = (await DI.resolve(param.Type)) as SocketArg;
      args[param.Index] = await extractor.extract(ctx, param);
    }

    return args;
  }
}
```

Create `packages/http-socket/src/decorators.ts`:

```ts
import { Class, DI, getInheritedDescriptor } from '@spinajs/di';
import { BasePolicy, IPolicyGroup } from '@spinajs/http';
import { BaseSocketController } from './controller.js';
import { ConnectionArg, FromDiArg, PayloadArg, ReasonArg, SignalArg } from './args.js';
import { ICommandOptions, IEventOptions, ISocketControllerDescriptor, ISocketHandlerDescriptor, ISocketParameter, SOCKET_CONTROLLER_DESCRIPTOR, SocketArg, SocketHandlerKind } from './interfaces.js';

type SocketDecorator = (target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => void;

function createDefaultDescriptor(): ISocketControllerDescriptor {
  return { Prefix: null, Policies: [], Handlers: new Map<string | symbol, ISocketHandlerDescriptor>() };
}

// The inheritance collapse rebuilds arrays and Maps but shares their elements; copy them so a
// subclass that redeclares a handler cannot rewrite its parent's ( as http's detachInheritedRoutes ).
function detachInheritedHandlers(descriptor: ISocketControllerDescriptor): void {
  descriptor.Policies = descriptor.Policies.map((group) => [...group]);

  for (const [member, handler] of descriptor.Handlers) {
    descriptor.Handlers.set(member, {
      ...handler,
      Options: { ...handler.Options },
      Policies: handler.Policies.map((group) => [...group]),
      Parameters: new Map([...handler.Parameters].map(([index, parameter]): [number, ISocketParameter] => [index, { ...parameter }])),
    });
  }
}

function SocketDescriptor(callback: (descriptor: ISocketControllerDescriptor, target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => void): SocketDecorator {
  return (target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => {
    const owner = target.prototype ?? target;
    const isFirstDecorator = !Reflect.getOwnMetadata(SOCKET_CONTROLLER_DESCRIPTOR, owner);
    const descriptor = getInheritedDescriptor<ISocketControllerDescriptor>(owner, SOCKET_CONTROLLER_DESCRIPTOR, createDefaultDescriptor);

    if (isFirstDecorator) {
      detachInheritedHandlers(descriptor);
    }

    callback(descriptor, target, propertyKey, indexOrDescriptor);
  };
}

function handlerOf(descriptor: ISocketControllerDescriptor, member: string | symbol): ISocketHandlerDescriptor {
  let handler = descriptor.Handlers.get(member);

  if (!handler) {
    handler = { Kind: 'unknown', Method: member, Name: String(member), Options: {}, Parameters: new Map(), Policies: [] };
    descriptor.Handlers.set(member, handler);
  }

  return handler;
}

function Handler(kind: Exclude<SocketHandlerKind, 'unknown'>, name: string | undefined, options: ICommandOptions): SocketDecorator {
  return SocketDescriptor((descriptor, target, propertyKey) => {
    if (propertyKey === undefined) {
      throw new Error(`socket ${kind} decorators can be used only on methods`);
    }

    const handler = handlerOf(descriptor, propertyKey);

    if (handler.Kind !== 'unknown' && handler.Kind !== kind) {
      throw new Error(`${target.constructor.name}::${String(propertyKey)} is already a socket ${handler.Kind} handler`);
    }

    handler.Kind = kind;
    handler.Name = name ?? String(propertyKey);
    handler.Options = { ...options };
  });
}

/**
 * Marks a socket controller. Command and event names get the prefix ( `docs` + `open` = `docs.open` ).
 * Keep socket controllers out of `system.dirs.controllers`; list their folders in `system.dirs.socketControllers`.
 */
export function SocketController(prefix?: string) {
  const describe = SocketDescriptor((descriptor) => {
    descriptor.Prefix = prefix ? prefix : null;
  });

  return (target: Class<BaseSocketController>) => {
    describe(target);
    DI.register(target).as(BaseSocketController);
  };
}

/** Request/response command, answered through the socket.io ack. */
export function Command(name?: string, options: ICommandOptions = {}) {
  return Handler('command', name, options);
}

/** Fire-and-forget event from the client. */
export function OnEvent(name?: string, options: IEventOptions = {}) {
  return Handler('event', name, options);
}

export function OnConnect() {
  return Handler('connect', undefined, {});
}

export function OnDisconnect() {
  return Handler('disconnect', undefined, {});
}

/** Adds one policy group ( AND inside ) at class or method scope; each member carries its own constructor options. */
export function SocketPolicyGroup(group: IPolicyGroup) {
  return SocketDescriptor((descriptor, _target, propertyKey) => {
    if (group.length === 0) {
      return;
    }

    if (propertyKey === undefined) {
      descriptor.Policies.push(group);
    } else {
      handlerOf(descriptor, propertyKey).Policies.push(group);
    }
  });
}

/**
 * Same semantics as http's `@Policy`, with the same `BasePolicy` classes: every call forms one
 * group ( AND inside ), groups are alternatives ( OR ), controller and method scopes are combined
 * with AND. Policies receive an `ISocketPolicyRequest` in place of the express request.
 */
export function SocketPolicy(policy: Class<BasePolicy> | string | (Class<BasePolicy> | string)[], ...options: unknown[]) {
  return SocketPolicyGroup((Array.isArray(policy) ? policy : [policy]).map((p) => ({ Type: p, Options: options })) as IPolicyGroup);
}

/** Declares a handler argument filled by the `SocketArg` extractor `type`; the base of all argument decorators. */
export function SocketParameter(type: Class<SocketArg>, schema: object | null = null, options?: unknown) {
  return SocketDescriptor((descriptor, target, propertyKey, index) => {
    if (propertyKey === undefined || typeof index !== 'number') {
      throw new Error('socket parameter decorators can be used only on method parameters');
    }

    const types = Reflect.getMetadata('design:paramtypes', target.prototype ?? target, propertyKey) as unknown[] | undefined;
    handlerOf(descriptor, propertyKey).Parameters.set(index, { Index: index, Type: type, RuntimeType: types?.[index], Schema: schema, Options: options });
  });
}

export function Payload(schema?: object) {
  return SocketParameter(PayloadArg, schema ?? null);
}

export function Connection() {
  return SocketParameter(ConnectionArg);
}

export function Signal() {
  return SocketParameter(SignalArg);
}

export function Reason() {
  return SocketParameter(ReasonArg);
}

export function FromDI(...options: unknown[]) {
  return SocketParameter(FromDiArg, null, options.length > 0 ? options : undefined);
}
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './controller.js';
export * from './args.js';
export * from './decorators.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/controller-model.test.ts`
Expected: `14 passing`.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket/tsconfig.mjs.json`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/interfaces.ts packages/http-socket/src/controller.ts packages/http-socket/src/args.ts packages/http-socket/src/decorators.ts packages/http-socket/src/index.ts packages/http-socket/test/controller-model.test.ts && \
git commit -m "feat(http-socket): socket controller decorators, descriptor and payload validation/hydration"
```

---

### Task 7: Handler registry

**Files:**
- Create: `packages/http-socket/src/registry.ts`
- Modify: `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/registry.test.ts`

**Interfaces:**
- Consumes: `BaseSocketController`, descriptor types, `IRegisteredHandler` (Task 6); http's `resolveRoutePolicies`.
- Produces: `@Injectable() class SocketHandlerRegistry`, with:
  - `build(): Promise<void>`: resolves every DI type registered as `BaseSocketController` and throws `InvalidOperation` on duplicate names or on a method with an `unknown` kind
  - `command(name): IRegisteredHandler | undefined`
  - `event(name): IRegisteredHandler | undefined`
  - `hooks(kind: 'connect'|'disconnect'): readonly IRegisteredHandler[]`
  - `Commands: ReadonlyMap<string, IRegisteredHandler>`

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/registry.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { BaseSocketController } from '../src/controller.js';
import { Command, OnConnect, OnDisconnect, OnEvent, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketHandlerRegistry } from '../src/registry.js';
import { configure } from './harness.js';

export class RegAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

@SocketController('reg')
@SocketPolicy(RegAllow)
export class RegistrySocket extends BaseSocketController {
  @Command('add')
  public async add(@Payload() n: number) {
    return n + 1;
  }

  @OnEvent('ping')
  public async ping(): Promise<void> {}

  @OnConnect()
  public async hello(): Promise<void> {}

  @OnDisconnect()
  public async bye(): Promise<void> {}
}

export class RegDupOne extends BaseSocketController {
  @Command('reg-dup.same')
  public async one(): Promise<void> {}
}

export class RegDupTwo extends BaseSocketController {
  @Command('reg-dup.same')
  public async two(): Promise<void> {}
}

export class RegOrphan extends BaseSocketController {
  public async orphan(@Payload() _payload: unknown): Promise<void> {}
}

describe('socket handler registry', function () {
  this.timeout(15000);

  let registry: SocketHandlerRegistry;

  beforeEach(async () => {
    await configure();
    registry = DI.resolve(SocketHandlerRegistry);
    await registry.build();
  });

  it('registers commands under the controller prefix', () => {
    const handler = registry.command('reg.add')!;
    expect(handler.fullName).to.equal('reg.add');
    expect(handler.controller).to.be.instanceOf(RegistrySocket);
    expect(registry.command('add')).to.be.undefined;
  });

  it('resolves the policies once, at registration', () => {
    const handler = registry.command('reg.add')!;
    expect(handler.policies.Controller).to.have.length(1);
    expect(handler.policies.Controller[0][0]).to.be.instanceOf(RegAllow);
    expect(handler.policies.Route).to.deep.equal([]);
  });

  it('keeps events apart from commands', () => {
    expect(registry.event('reg.ping')).to.exist;
    expect(registry.command('reg.ping')).to.be.undefined;
  });

  it('collects lifecycle hooks', () => {
    expect(registry.hooks('connect').map((h) => h.fullName)).to.include('reg.hello');
    expect(registry.hooks('disconnect').map((h) => h.fullName)).to.include('reg.bye');
  });

  it('refuses two handlers with one name', async () => {
    DI.register(RegDupOne).as(BaseSocketController);
    DI.register(RegDupTwo).as(BaseSocketController);
    try {
      await expect(registry.build()).to.be.rejectedWith(/reg-dup\.same is declared twice/);
    } finally {
      DI.unregister(RegDupOne);
      DI.unregister(RegDupTwo);
    }
  });

  it('refuses parameter decorators without a handler decorator', async () => {
    DI.register(RegOrphan).as(BaseSocketController);
    try {
      await expect(registry.build()).to.be.rejectedWith(/RegOrphan::orphan has socket parameter or policy decorators but no/);
    } finally {
      DI.unregister(RegOrphan);
    }
  });

  it('rebuilds from scratch', async () => {
    await registry.build();
    expect(registry.command('reg.add')).to.exist;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/registry.test.ts`
Expected: FAIL with `Cannot find module '../src/registry.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/http-socket/src/registry.ts`:

```ts
import { Autoinject, Class, Container, DI, IContainer, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { IControllerDescriptor, IRoute, resolveRoutePolicies } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { BaseSocketController } from './controller.js';
import { IRegisteredHandler, ISocketControllerDescriptor, ISocketHandlerDescriptor } from './interfaces.js';

@Injectable()
export class SocketHandlerRegistry {
  @Logger('http-socket')
  protected Log: Log;

  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(Configuration)
  protected Cfg: Configuration;

  protected commands = new Map<string, IRegisteredHandler>();
  protected events = new Map<string, IRegisteredHandler>();
  protected connectHooks: IRegisteredHandler[] = [];
  protected disconnectHooks: IRegisteredHandler[] = [];

  public get Commands(): ReadonlyMap<string, IRegisteredHandler> {
    return this.commands;
  }

  public async build(): Promise<void> {
    this.commands.clear();
    this.events.clear();
    this.connectHooks = [];
    this.disconnectHooks = [];

    const types = (DI.getRegisteredTypes(BaseSocketController) ?? []) as Array<Class<BaseSocketController>>;

    for (const type of types) {
      const controller = (await DI.resolve(type)) as BaseSocketController;
      const descriptor = controller.Descriptor;

      if (!descriptor) {
        this.Log.warn(`Socket controller ${type.name} has no socket decorators, skipped`);
        continue;
      }

      for (const [, handler] of descriptor.Handlers) {
        await this.add(type.name, controller, descriptor, handler);
      }
    }
  }

  public command(name: string): IRegisteredHandler | undefined {
    return this.commands.get(name);
  }

  public event(name: string): IRegisteredHandler | undefined {
    return this.events.get(name);
  }

  public hooks(kind: 'connect' | 'disconnect'): readonly IRegisteredHandler[] {
    return kind === 'connect' ? this.connectHooks : this.disconnectHooks;
  }

  protected async add(controllerName: string, controller: BaseSocketController, descriptor: ISocketControllerDescriptor, handler: ISocketHandlerDescriptor): Promise<void> {
    if (handler.Kind === 'unknown') {
      throw new InvalidOperation(`${controllerName}::${String(handler.Method)} has socket parameter or policy decorators but no @Command, @OnEvent, @OnConnect or @OnDisconnect`);
    }

    const fullName = descriptor.Prefix ? `${descriptor.Prefix}.${handler.Name}` : handler.Name;

    // http's resolver reads only Policies and Method, so the socket descriptors pass structurally
    const policies = await resolveRoutePolicies(
      { Policies: descriptor.Policies } as unknown as IControllerDescriptor,
      { Policies: handler.Policies, Method: handler.Method } as unknown as IRoute,
      this.Container,
      this.Cfg,
      this.Log,
      controllerName,
      fullName,
    );

    const registered: IRegisteredHandler = { fullName, controller, descriptor: handler, policies };

    switch (handler.Kind) {
      case 'command':
        this.unique(this.commands, registered, controllerName);
        break;
      case 'event':
        this.unique(this.events, registered, controllerName);
        break;
      case 'connect':
        this.connectHooks.push(registered);
        break;
      case 'disconnect':
        this.disconnectHooks.push(registered);
        break;
    }

    this.Log.trace(`Registered socket ${handler.Kind} ${fullName} -> ${controllerName}::${String(handler.Method)}`);
  }

  protected unique(map: Map<string, IRegisteredHandler>, registered: IRegisteredHandler, controllerName: string): void {
    const existing = map.get(registered.fullName);

    if (existing) {
      throw new InvalidOperation(
        `Socket ${registered.descriptor.Kind} ${registered.fullName} is declared twice: ${existing.controller.constructor.name}::${String(existing.descriptor.Method)} and ${controllerName}::${String(registered.descriptor.Method)}`,
      );
    }

    map.set(registered.fullName, registered);
  }
}
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './registry.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/registry.test.ts`
Expected: `7 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/registry.ts packages/http-socket/src/index.ts packages/http-socket/test/registry.test.ts && \
git commit -m "feat(http-socket): handler registry with prefixed names, policy resolution and duplicate checks"
```

---

### Task 8: Dispatcher and the command pipeline skeleton (stages 4, 7, 9, 10)

**Files:**
- Modify: `packages/http-socket/src/interfaces.ts` (add imports at the top; append declarations)
- Create: `packages/http-socket/src/context.ts`, `src/dispatcher.ts`, `src/stages/index.ts`, `src/stages/lookup.ts`, `src/stages/arguments.ts`
- Replace: `packages/http-socket/src/server.ts`
- Modify: `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `SocketHandlerRegistry` (Task 7), `SocketArgumentResolver` (Task 6), `SocketErrorMapper` (Task 4), `TokenBucket` (Task 3), `SocketConnection` and the harness (Task 5).
- Produces:
  - `IConnectionRuntime { connection; bucket: TokenBucket; inFlight: number; running: Map<string, ISocketCommandContext>; ready: Promise<void> }`
  - `ISocketCommandContext extends ISocketCallContext { kind: 'command'; request: CommandRequest; runtime; receivedAt; args?; abort(reason: SocketException); armDeadline(ms?: number) }`
  - `abstract class SocketCommandStage { abstract get Order(): number; abstract execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> }`: the W3 extension point. Register one with `@Injectable(SocketCommandStage)`.
  - `STAGE_ORDER = { Size:100, Rate:200, InFlight:300, Authentication:350, Lookup:400, Idempotency:500, Policies:600, Arguments:700, Ordering:800 }` (`Authentication` is filled by Task 10A)
  - `class SocketCommandContext implements ISocketCommandContext { dispose() }`
  - `@Injectable() class SocketDispatcher extends AsyncService { attach(conn, socket): IConnectionRuntime; detach(conn, reason); execute(ctx): Promise<CommandReply> }`, plus protected `callStorage`, `next`, `invoke` and `toReply` (W4 overrides `toReply` for streams)
  - `LookupStage` (sets `ctx.handler`, else `unimplemented`), `ArgumentsStage` (sets `ctx.args`)
  - The ALS store of a command is an `ISocketCallStorage` `{ Principal: connection.principal, AuthnPrincipal: connection.authenticated ? connection.principal : null, requestId, traceId, spanId, realIp, connectionId, clientId, socketCall }`. The whole stage chain runs inside `AsyncLocalStorage.run(store)` (D14).

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/pipeline.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { UNATTENDED } from '@spinajs/authz';
import { WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, Payload, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { ISocketCallStorage } from '../src/interfaces.js';
import { ALICE, ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';

export class PipeNote {
  public text: string;

  constructor(data: Partial<PipeNote>) {
    Object.assign(this, data);
  }
}

@SocketController('pipe')
export class PipelineSocket extends BaseSocketController {
  @Command('echo')
  public async echo(@Payload() payload: unknown) {
    return payload;
  }

  @Command('nothing')
  public async nothing(): Promise<void> {}

  @Command('validated', { schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } } } })
  public async validated(@Payload() p: { n: number }) {
    return p.n * 2;
  }

  @Command('forbid')
  public async forbid(): Promise<void> {
    throw new Forbidden('not yours');
  }

  @Command('boom')
  public async boom(): Promise<void> {
    throw new Error('kaput');
  }

  @Command('who')
  public async who(@Connection() conn: SocketConnection) {
    return { clientId: conn.clientId, user: conn.user ?? null };
  }

  @Command('note')
  public async note(@Payload() note: PipeNote) {
    return note instanceof PipeNote ? note.text : 'not hydrated';
  }

  @Command('stream')
  public async *stream() {
    yield 1;
  }

  @Command('store')
  public async store() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).getStore();
    return { requestId: store?.requestId ?? null, connectionId: store?.connectionId ?? null };
  }

  @Command('principal')
  public async principal() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    return { id: store?.Principal.id ?? null, unattended: store?.Principal === UNATTENDED, authn: store?.AuthnPrincipal?.id ?? null };
  }
}

describe('socket command pipeline', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    socket = await open(t, { auth: { token: 'good', clientId: 'pipe-client' } });
  });

  afterEach(async () => {
    socket.close();
    await t.close();
  });

  it('answers a command with its result and echoes the request id', async () => {
    const reply = await command(socket, 'pipe.echo', { a: 1 }, { id: 'echo-1' });
    expect(reply).to.deep.equal({ id: 'echo-1', ok: true, result: { a: 1 } });
  });

  it('sends null for a handler that returns nothing', async () => {
    expect(resultOf(await command(socket, 'pipe.nothing'))).to.be.null;
  });

  it('answers an unknown command with unimplemented', async () => {
    expect(errorOf(await command(socket, 'pipe.nope'))).to.deep.equal({ code: 'unimplemented', message: 'unknown command pipe.nope', retryable: false });
  });

  it('validates the payload and returns the validation details', async () => {
    const error = errorOf(await command(socket, 'pipe.validated', { n: 0 }));
    expect(error.code).to.equal('invalid_argument');
    expect((error.details as Array<{ rule: string }>)[0].rule).to.equal('minimum');
    expect(resultOf(await command(socket, 'pipe.validated', { n: 2 }))).to.equal(4);
  });

  it('maps a thrown spinajs exception', async () => {
    expect(errorOf(await command(socket, 'pipe.forbid'))).to.deep.equal({ code: 'forbidden', message: 'not yours', retryable: false });
  });

  it('maps an unexpected error to internal with an errorId', async () => {
    const error = errorOf(await command(socket, 'pipe.boom'));
    expect(error.code).to.equal('internal');
    expect(error.message).to.equal('kaput');
    expect(error.errorId).to.be.a('string');
  });

  it('passes the connection and its identity', async () => {
    expect(resultOf(await command(socket, 'pipe.who'))).to.deep.equal({ clientId: 'pipe-client', user: ALICE });
  });

  it('hydrates a DTO payload', async () => {
    expect(resultOf(await command(socket, 'pipe.note', { text: 'hello' }))).to.equal('hello');
  });

  it('answers a stream-returning handler with unimplemented until W4', async () => {
    const error = errorOf(await command(socket, 'pipe.stream'));
    expect(error.code).to.equal('unimplemented');
    expect(error.message).to.match(/stream replies/);
  });

  it('runs the handler inside the call storage', async () => {
    expect(resultOf(await command(socket, 'pipe.store', undefined, { id: 'store-1' }))).to.deep.equal({ requestId: 'store-1', connectionId: socket.id });
  });

  it('puts the connection principal into the call storage under Principal and AuthnPrincipal (D14)', async () => {
    expect(resultOf(await command(socket, 'pipe.principal'))).to.deep.equal({ id: '1', unattended: false, authn: '1' });
  });

  it('runs a connection without credentials as UNATTENDED, with no AuthnPrincipal', async () => {
    const anonymous = await open(t, { auth: { clientId: 'pipe-anon' } });
    try {
      expect(resultOf(await command(anonymous, 'pipe.principal'))).to.deep.equal({ id: 'unattended', unattended: true, authn: null });
    } finally {
      anonymous.close();
    }
  });

  it('answers a malformed request with invalid_argument', async () => {
    const reply = await socket.timeout(2000).emitWithAck(WIRE_EVENTS.command, { name: 'pipe.echo' });
    expect(reply).to.deep.equal({ id: '', ok: false, error: { code: 'invalid_argument', message: 'malformed command request', retryable: false } });
  });

  it('carries binary payload parts both ways', async () => {
    const result = resultOf(await command<{ bin: ArrayBuffer }>(socket, 'pipe.echo', { bin: new Uint8Array([1, 2, 3]) }));
    expect(Array.from(new Uint8Array(result.bin))).to.deep.equal([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/pipeline.test.ts`
Expected: FAIL. Every test times out (`operation has timed out`), because nothing answers `cmd` yet.

- [ ] **Step 3: Add the command-context types**

At the top of `packages/http-socket/src/interfaces.ts`, add (under the existing imports):

```ts
import type { CommandRequest, SocketException } from '@spinajs/http-socket-common';
import type { TokenBucket } from './limits.js';
```

Append to `packages/http-socket/src/interfaces.ts`:

```ts
/** Per-connection pipeline state. */
export interface IConnectionRuntime {
  readonly connection: SocketConnection;
  readonly bucket: TokenBucket;
  inFlight: number;
  /** running commands by request id, for cancel / disconnect / shutdown */
  readonly running: Map<string, ISocketCommandContext>;
  /** settles when the connect hooks are done; commands wait for it */
  ready: Promise<void>;
}

export interface ISocketCommandContext extends ISocketCallContext {
  readonly kind: 'command';
  readonly request: CommandRequest;
  readonly runtime: IConnectionRuntime;
  readonly receivedAt: number;
  /** set by the arguments stage */
  args?: unknown[];
  /** fires `signal`; the dispatcher replies with `reason` at once */
  abort(reason: SocketException): void;
  /** keeps the earliest of all armed deadlines, counted from `receivedAt` */
  armDeadline(ms: number | undefined): void;
}

/**
 * One step of the command pipeline. Stages run in ascending `Order` as an onion: call `next()` to
 * continue, return without calling it to answer early ( eg. an idempotent replay ), throw to fail.
 * Register with `@Injectable(SocketCommandStage)`.
 */
export abstract class SocketCommandStage {
  public abstract get Order(): number;

  public abstract execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown>;
}

/** Spec §5.2 order. 350 is W1's principal re-check ( Task 10A, D16 ); 500 is reserved for W3's idempotency stage. */
export const STAGE_ORDER = {
  Size: 100,
  Rate: 200,
  InFlight: 300,
  Authentication: 350,
  Lookup: 400,
  Idempotency: 500,
  Policies: 600,
  Arguments: 700,
  Ordering: 800,
} as const;
```

- [ ] **Step 4: Write the context, the dispatcher and the two stages**

Create `packages/http-socket/src/context.ts`:

```ts
import { CommandRequest, SocketException } from '@spinajs/http-socket-common';
import { IConnectionRuntime, IRegisteredHandler, ISocketCallStorage, ISocketCommandContext } from './interfaces.js';
import { SocketConnection } from './connection.js';

export class SocketCommandContext implements ISocketCommandContext {
  public readonly kind = 'command' as const;
  public readonly receivedAt = Date.now();
  public handler?: IRegisteredHandler;
  public args?: unknown[];

  protected readonly controller = new AbortController();
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected deadlineAt = Number.POSITIVE_INFINITY;

  constructor(
    public readonly runtime: IConnectionRuntime,
    public readonly request: CommandRequest,
    public readonly storage: ISocketCallStorage,
  ) {}

  public get connection(): SocketConnection {
    return this.runtime.connection;
  }

  public get payload(): unknown {
    return this.request.payload;
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public abort(reason: SocketException): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  public armDeadline(ms: number | undefined): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
      return;
    }

    const at = this.receivedAt + ms;
    if (at >= this.deadlineAt) {
      return;
    }

    this.deadlineAt = at;
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => this.abort(new SocketException('deadline_exceeded', `command ${this.request.name} exceeded its deadline of ${ms} ms`)), Math.max(0, at - Date.now()));
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
```

Create `packages/http-socket/src/dispatcher.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Socket } from 'socket.io';
import { AsyncService, Autoinject, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger, newTraceContext } from '@spinajs/log';
import { CommandReply, CommandRequest, SocketException, WIRE_EVENTS, isCommandRequest } from '@spinajs/http-socket-common';
import { IConnectionRuntime, ISocketCallStorage, ISocketServerConfig, SocketCommandStage } from './interfaces.js';
import { SocketConnection } from './connection.js';
import { SocketCommandContext } from './context.js';
import { SocketErrorMapper } from './errors.js';
import { TokenBucket } from './limits.js';
import './stages/index.js';

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function';
}

@Injectable()
export class SocketDispatcher extends AsyncService {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  @Autoinject()
  protected Errors: SocketErrorMapper;

  @Autoinject()
  protected Als: AsyncLocalStorage<ISocketCallStorage>;

  protected Stages: SocketCommandStage[] = [];

  protected runtimes = new Map<string, IConnectionRuntime>();

  public async resolve(): Promise<void> {
    await super.resolve();
    const stages = (await DI.resolve(Array.ofType(SocketCommandStage))) as SocketCommandStage[];
    this.Stages = [...stages].sort((a, b) => a.Order - b.Order);
  }

  public attach(connection: SocketConnection, socket: Socket): IConnectionRuntime {
    const runtime: IConnectionRuntime = {
      connection,
      bucket: new TokenBucket(this.Options.rate.perSecond, this.Options.rate.burst),
      inFlight: 0,
      running: new Map(),
      ready: Promise.resolve(),
    };

    this.runtimes.set(connection.id, runtime);
    socket.on(WIRE_EVENTS.command, (request: unknown, ack: unknown) => this.onCommand(runtime, request, ack));

    return runtime;
  }

  public detach(connection: SocketConnection, _reason: string): void {
    this.runtimes.delete(connection.id);
  }

  /** Runs one command through the stages and the handler; never rejects. */
  public async execute(ctx: SocketCommandContext): Promise<CommandReply> {
    const runtime = ctx.runtime;
    runtime.running.set(ctx.request.id, ctx);

    let reply: CommandReply;

    try {
      await runtime.ready;

      // D14: stages, hydrators and the handler all see the principal ( AuthzService.current() once F4 lands )
      const chain = this.Als.run(ctx.storage, () => this.next(ctx, 0));
      // An abort answers at once; the chain keeps running ( and holds its in-flight slot ) until the handler settles.
      chain.catch(() => undefined);
      const abort = aborted(ctx.signal);
      abort.catch(() => undefined);

      const result = await Promise.race([chain, abort]);
      reply = await this.toReply(ctx, result);
    } catch (err) {
      reply = { id: ctx.request.id, ok: false, error: this.Errors.toWire(err, `command ${ctx.request.name}`) };
    } finally {
      ctx.dispose();
      if (runtime.running.get(ctx.request.id) === ctx) {
        runtime.running.delete(ctx.request.id);
      }
    }

    return reply;
  }

  protected onCommand(runtime: IConnectionRuntime, raw: unknown, ack: unknown): void {
    if (typeof ack !== 'function') {
      this.Log.warn(`Socket command without an ack callback from connection ${runtime.connection.id}, ignored`);
      return;
    }

    const reply = ack as (reply: CommandReply) => void;

    if (!isCommandRequest(raw)) {
      const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : '';
      reply({ id, ok: false, error: new SocketException('invalid_argument', 'malformed command request').toWire() });
      return;
    }

    void this.execute(this.createContext(runtime, raw)).then(reply);
  }

  protected createContext(runtime: IConnectionRuntime, request: CommandRequest): SocketCommandContext {
    return new SocketCommandContext(runtime, request, this.callStorage(runtime.connection, request.name, request.id, request.traceparent));
  }

  /** The ambient AsyncLocalStorage store of one call; log lines and policies read it. */
  protected callStorage(connection: SocketConnection, call: string, requestId: string = randomUUID(), traceparent?: string): ISocketCallStorage {
    const trace = newTraceContext(traceparent);

    return {
      Principal: connection.principal,
      AuthnPrincipal: connection.authenticated ? connection.principal : null,
      requestId,
      traceId: trace.traceId,
      spanId: trace.spanId,
      realIp: connection.handshake.address,
      connectionId: connection.id,
      clientId: connection.clientId,
      socketCall: call,
    };
  }

  protected next(ctx: SocketCommandContext, index: number): Promise<unknown> {
    const stage = this.Stages[index];

    if (!stage) {
      return this.invoke(ctx);
    }

    return stage.execute(ctx, () => this.next(ctx, index + 1));
  }

  protected async invoke(ctx: SocketCommandContext): Promise<unknown> {
    if (ctx.signal.aborted) {
      throw ctx.signal.reason;
    }

    const handler = ctx.handler;
    const args = ctx.args;

    if (!handler || !args) {
      throw new SocketException('internal', 'command reached its handler without lookup or arguments; a built-in stage is missing');
    }

    return handler.controller[handler.descriptor.Method as string](...args);
  }

  /** W4 replaces the stream branch with real stream replies. */
  protected async toReply(ctx: SocketCommandContext, result: unknown): Promise<CommandReply> {
    if (isAsyncIterable(result)) {
      try {
        await (result as AsyncGenerator<unknown>).return?.(undefined);
      } catch {
        // a failing generator cleanup does not change the answer
      }
      throw new SocketException('unimplemented', `command ${ctx.request.name} returned a stream; stream replies are not supported by this server version`);
    }

    return { id: ctx.request.id, ok: true, result: result === undefined ? null : result };
  }
}
```

Create `packages/http-socket/src/stages/lookup.ts`:

```ts
import { Autoinject, Injectable } from '@spinajs/di';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketHandlerRegistry } from '../registry.js';

@Injectable(SocketCommandStage)
export class LookupStage extends SocketCommandStage {
  @Autoinject()
  protected Registry: SocketHandlerRegistry;

  public get Order(): number {
    return STAGE_ORDER.Lookup;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const handler = this.Registry.command(ctx.request.name);

    if (!handler) {
      throw new SocketException('unimplemented', `unknown command ${ctx.request.name}`);
    }

    ctx.handler = handler;
    return next();
  }
}
```

Create `packages/http-socket/src/stages/arguments.ts`:

```ts
import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketArgumentResolver } from '../args.js';

@Injectable(SocketCommandStage)
export class ArgumentsStage extends SocketCommandStage {
  @Autoinject()
  protected Arguments: SocketArgumentResolver;

  public get Order(): number {
    return STAGE_ORDER.Arguments;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    ctx.args = await this.Arguments.resolve(ctx);
    return next();
  }
}
```

Create `packages/http-socket/src/stages/index.ts`:

```ts
export * from './lookup.js';
export * from './arguments.js';
```

Replace `packages/http-socket/src/server.ts` with:

```ts
import { Server, ServerOptions, Socket } from 'socket.io';
import { AsyncService, Autoinject, ClassInfo, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ListFromFiles } from '@spinajs/reflection';
import { UNATTENDED, Unauthenticated } from '@spinajs/authz';
import { MAX_ID_LENGTH, PROTOCOL_VERSION, SocketError, SocketException } from '@spinajs/http-socket-common';
import { ISocketAuthState, ISocketServerConfig, SocketHttpHost, SocketPrincipalSource } from './interfaces.js';
import { SocketConnection, toHandshake } from './connection.js';
import { SocketDispatcher } from './dispatcher.js';
import { SocketErrorMapper } from './errors.js';
import { SocketHub } from './hub.js';
import { isAllowedOrigin } from './origin.js';
import { SocketHandlerRegistry } from './registry.js';
import './host.js';
import './authn-source.js';

/** socket.io hands `data` to the client as the `connect_error` payload. */
function refusal(wire: SocketError): Error & { data: SocketError } {
  const err = new Error(wire.message) as Error & { data: SocketError };
  err.data = wire;
  return err;
}

@Injectable()
export class SocketServer extends AsyncService {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  @Autoinject()
  protected Host: SocketHttpHost;

  @Autoinject()
  protected Hub: SocketHub;

  @Autoinject()
  protected Errors: SocketErrorMapper;

  @Autoinject()
  protected Registry: SocketHandlerRegistry;

  @Autoinject()
  protected Dispatcher: SocketDispatcher;

  @Autoinject(SocketPrincipalSource)
  protected Sources: SocketPrincipalSource[];

  // Loading the files is what runs their @SocketController decorators.
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.socketControllers')
  protected ControllerFiles: Promise<Array<ClassInfo<unknown>>>;

  protected _io: Server | null = null;

  public get Io(): Server | null {
    return this._io;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    await this.ControllerFiles;
    await this.Registry.build();

    const io = new Server(await this.Host.server(), this.ioOptions());
    io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (err: Error) => next(err),
      );
    });
    io.on('connection', (socket) => this.onConnection(socket));

    this.Hub.attach(io);
    this._io = io;
  }

  public async dispose(): Promise<void> {
    const io = this._io;
    if (!io) {
      return;
    }

    this._io = null;
    io.disconnectSockets(true);
    io.engine.close();
    this.Hub.detach();
  }

  protected ioOptions(): Partial<ServerOptions> {
    const o = this.Options;
    const options: Partial<ServerOptions> = {
      path: o.path,
      pingInterval: o.pingInterval,
      pingTimeout: o.pingTimeout,
      // socket.io closes the whole connection on an oversized frame; the headroom lets the size
      // stage answer resource_exhausted for payloads up to twice the limit instead.
      maxHttpBufferSize: o.maxPayloadBytes * 2,
    };

    if (o.cors.origins.length > 0) {
      options.cors = { origin: [...o.cors.origins], credentials: true };
    }

    if (o.adapter) {
      options.adapter = o.adapter as ServerOptions['adapter'];
    }

    if ((o.recovery?.maxDisconnectionMs ?? 0) > 0) {
      options.connectionStateRecovery = { maxDisconnectionDuration: o.recovery.maxDisconnectionMs, skipMiddlewares: true };
    }

    return options;
  }

  protected async authenticate(socket: Socket): Promise<void> {
    try {
      // first: no principal source may read the credentials of a hijacked cross-site socket
      if (!isAllowedOrigin(socket.handshake.headers, this.Options.cors.origins)) {
        throw new SocketException('forbidden', 'origin not allowed');
      }

      const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;

      if (auth.protocol !== PROTOCOL_VERSION) {
        throw new SocketException('version_mismatch', `server speaks protocol ${PROTOCOL_VERSION}, client sent ${String(auth.protocol)}`, { details: { server: PROTOCOL_VERSION } });
      }

      if (typeof auth.clientId !== 'string' || auth.clientId.length === 0 || auth.clientId.length > MAX_ID_LENGTH) {
        throw new SocketException('invalid_argument', 'handshake auth.clientId must be a non-empty string');
      }

      socket.data.auth = await this.identify(socket);
    } catch (err) {
      const wire = this.Errors.toWire(err, 'handshake');
      this.Log.debug(`Socket handshake refused: ${wire.code} ${wire.message}`);
      throw refusal(wire);
    }
  }

  protected async identify(socket: Socket): Promise<ISocketAuthState> {
    const handshake = toHandshake(socket);
    const sources = [...this.Sources].sort((a, b) => a.order - b.order);

    for (const source of sources) {
      const principal = await source.authenticate(handshake);
      if (principal) {
        return { principal, source: source.name, checkedAt: Date.now() };
      }
    }

    if (this.Options.auth.required) {
      throw new Unauthenticated('authentication required');
    }

    return { principal: UNATTENDED, source: null, checkedAt: Date.now() };
  }

  protected onConnection(socket: Socket): void {
    const connection = new SocketConnection(socket, toHandshake(socket));
    this.Hub.register(connection);
    this.Dispatcher.attach(connection, socket);

    socket.on('disconnect', (reason: string) => {
      connection.close(reason);
      this.Dispatcher.detach(connection, reason);
      this.Hub.unregister(connection.id);
    });
  }
}
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './context.js';
export * from './stages/index.js';
export * from './dispatcher.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/pipeline.test.ts`
Expected: `14 passing`.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && npm run test --workspace=packages/http-socket`
Expected: every test file passes (`88 passing`).

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/interfaces.ts packages/http-socket/src/context.ts packages/http-socket/src/dispatcher.ts packages/http-socket/src/stages packages/http-socket/src/server.ts packages/http-socket/src/index.ts packages/http-socket/test/pipeline.test.ts && \
git commit -m "feat(http-socket): command dispatcher with a pluggable stage chain, lookup and argument stages"
```

---
### Task 9: Policies (stage 6)

**Files:**
- Create: `packages/http-socket/src/policies.ts`, `packages/http-socket/src/stages/policies.ts`
- Modify: `packages/http-socket/src/stages/index.ts`, `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/policies.test.ts`

**Interfaces:**
- Consumes: `IRegisteredHandler.policies` (Task 7), `ISocketCallContext` (Task 6), `STAGE_ORDER`, `SocketCommandStage` (Task 8); http's `createPolicyGate`.
- Produces:
  - `ISocketPolicyRequest { method: 'SOCKET'; originalUrl; url; headers; cookies; ip; body; params; query; storage; socketConnection }`: what every `BasePolicy.execute(req, …)` receives on sockets
  - `policyRequest(ctx): ISocketPolicyRequest`
  - `@Injectable() class SocketPolicyGate { check(ctx: ISocketCallContext): Promise<void> }`, used by commands here and by events in Task 13
  - `PoliciesStage` (`STAGE_ORDER.Policies`)

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/policies.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import { ISocketCallStorage } from '../src/interfaces.js';
import { ISocketPolicyRequest } from '../src/policies.js';
import { ALICE, ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';

export const policySeen: Array<Record<string, unknown>> = [];

export class PolDeny extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('denied by PolDeny');
  }
}

export class PolAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

export class PolRequireUser extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    if (!(req as ISocketPolicyRequest).storage.Principal.authenticated) {
      throw new AuthenticationFailed('login required');
    }
  }
}

export class PolInspect extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    const r = req as ISocketPolicyRequest;
    // policies run inside the call's AsyncLocalStorage store ( D14 ), as AuthzService.current() will need
    const ambient = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    policySeen.push({ body: r.body, params: r.params, user: r.storage.Principal.identity ?? null, ambient: ambient?.Principal.id ?? null, method: r.method, url: r.originalUrl, clientId: r.socketConnection.clientId });
  }
}

export class PolDisabled extends BasePolicy {
  public isEnabled(): boolean {
    return false;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('never runs');
  }
}

@SocketController('pol')
@SocketPolicy(PolRequireUser)
export class PolicySocket extends BaseSocketController {
  @Command('open')
  public async open() {
    return 'opened';
  }

  @Command('deny')
  @SocketPolicy(PolDeny)
  public async deny() {
    return 'unreachable';
  }

  @Command('both')
  @SocketPolicy([PolAllow, PolDeny])
  public async both() {
    return 'unreachable';
  }

  @Command('either')
  @SocketPolicy(PolDeny)
  @SocketPolicy(PolAllow)
  public async either() {
    return 'one path is enough';
  }

  @Command('inspect')
  @SocketPolicy(PolInspect)
  public async inspect() {
    return 'inspected';
  }

  @Command('disabled')
  @SocketPolicy(PolDisabled)
  public async disabled() {
    return 'not guarded';
  }

  @Command('strict', { schema: { type: 'object', required: ['x'] } })
  @SocketPolicy(PolDeny)
  public async strict(@Payload() _payload: unknown) {
    return 'unreachable';
  }
}

describe('socket command policies', function () {
  this.timeout(15000);

  let t: ITestServer;
  let anonymous: ClientSocket;
  let alice: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    anonymous = await open(t, { auth: { clientId: 'pol-anon' } });
    alice = await open(t, { auth: { clientId: 'pol-client', token: 'good' } });
  });

  afterEach(async () => {
    anonymous.close();
    alice.close();
    await t.close();
  });

  it('answers unauthenticated when a controller policy needs a user', async () => {
    expect(errorOf(await command(anonymous, 'pol.open'))).to.deep.equal({ code: 'unauthenticated', message: 'login required', retryable: false });
  });

  it('runs the command when every policy holds', async () => {
    expect(resultOf(await command(alice, 'pol.open'))).to.equal('opened');
  });

  it('answers forbidden from a method policy', async () => {
    expect(errorOf(await command(alice, 'pol.deny'))).to.deep.equal({ code: 'forbidden', message: 'denied by PolDeny', retryable: false });
  });

  it('requires every policy of one group (AND)', async () => {
    expect(errorOf(await command(alice, 'pol.both')).code).to.equal('forbidden');
  });

  it('accepts any one of several groups (OR)', async () => {
    expect(resultOf(await command(alice, 'pol.either'))).to.equal('one path is enough');
  });

  it('hands policies a request built from the call', async () => {
    await command(alice, 'pol.inspect', { doc: 7 });
    expect(policySeen[policySeen.length - 1]).to.deep.equal({ body: { doc: 7 }, params: { doc: 7 }, user: ALICE, ambient: '1', method: 'SOCKET', url: 'pol.inspect', clientId: 'pol-client' });
  });

  it('skips a policy that is not enabled for the command', async () => {
    expect(resultOf(await command(alice, 'pol.disabled'))).to.equal('not guarded');
  });

  it('checks policies before validating arguments', async () => {
    expect(errorOf(await command(alice, 'pol.strict', {})).code).to.equal('forbidden');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/policies.test.ts`
Expected: FAIL with `Cannot find module '../src/policies.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/http-socket/src/policies.ts`:

```ts
import { Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { IController, IRoute, createPolicyGate } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { SocketException } from '@spinajs/http-socket-common';
import { IRegisteredHandler, ISocketCallContext, ISocketCallStorage, ISocketHandshake } from './interfaces.js';
import { SocketConnection } from './connection.js';

/**
 * What a `BasePolicy` receives in place of the express request. Policies that read only
 * `req.storage` ( authz-v3's `Principal` / `AuthnPrincipal` keys ) and resource extractors that
 * read `req.body` / `req.params` work unchanged.
 */
export interface ISocketPolicyRequest {
  readonly method: 'SOCKET';
  /** full command / event name */
  readonly originalUrl: string;
  readonly url: string;
  readonly headers: ISocketHandshake['headers'];
  readonly cookies: ISocketHandshake['cookies'];
  readonly ip: string;
  readonly body: unknown;
  /** the payload's own fields when it is an object */
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  /** the call storage; what a policy writes here the handler sees in its AsyncLocalStorage store */
  readonly storage: ISocketCallStorage;
  readonly socketConnection: SocketConnection;
}

export function policyRequest(ctx: ISocketCallContext): ISocketPolicyRequest {
  const name = ctx.handler?.fullName ?? '';
  const payload = ctx.payload;
  const fields = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const handshake = ctx.connection.handshake;

  return {
    method: 'SOCKET',
    originalUrl: name,
    url: name,
    headers: handshake.headers,
    cookies: handshake.cookies,
    ip: handshake.address,
    body: payload,
    params: fields,
    query: {},
    storage: ctx.storage,
    socketConnection: ctx.connection,
  };
}

type PolicyGateFn = (req: unknown, res: unknown, next: (...args: unknown[]) => void) => void;

/** Runs http's own policy gate, so socket and http policies combine exactly alike. */
@Injectable()
export class SocketPolicyGate {
  @Logger('http-socket')
  protected Log: Log;

  protected gates = new WeakMap<IRegisteredHandler, PolicyGateFn>();

  public async check(ctx: ISocketCallContext): Promise<void> {
    const handler = ctx.handler;
    if (!handler) {
      throw new SocketException('internal', 'policy check before handler lookup');
    }

    const gate = this.gateOf(handler);
    const request = policyRequest(ctx);

    await new Promise<void>((resolve, reject) => {
      // http's gate calls next() to pass and next(err) to refuse; a policy that rejects with
      // undefined must still refuse, so the argument count decides, not the value.
      gate(request, {}, (...args: unknown[]) => (args.length === 0 ? resolve() : reject(args[0] ?? new Forbidden('access denied by policy'))));
    });
  }

  protected gateOf(handler: IRegisteredHandler): PolicyGateFn {
    let gate = this.gates.get(handler);

    if (!gate) {
      const route = {
        Method: handler.descriptor.Method,
        Path: handler.fullName,
        Type: 'socket',
        InternalType: 'socket',
        Policies: handler.descriptor.Policies,
        Middlewares: [],
        Parameters: new Map(),
        Options: handler.descriptor.Options,
        Schema: handler.descriptor.Options.schema ?? null,
      } as unknown as IRoute;

      gate = createPolicyGate(handler.policies, route, handler.controller as unknown as IController, this.Log) as unknown as PolicyGateFn;
      this.gates.set(handler, gate);
    }

    return gate;
  }
}
```

Create `packages/http-socket/src/stages/policies.ts`:

```ts
import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketPolicyGate } from '../policies.js';

@Injectable(SocketCommandStage)
export class PoliciesStage extends SocketCommandStage {
  @Autoinject()
  protected Gate: SocketPolicyGate;

  public get Order(): number {
    return STAGE_ORDER.Policies;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    await this.Gate.check(ctx);
    return next();
  }
}
```

Append to `packages/http-socket/src/stages/index.ts`:

```ts
export * from './policies.js';
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './policies.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/policies.test.ts`
Expected: `8 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/policies.ts packages/http-socket/src/stages/policies.ts packages/http-socket/src/stages/index.ts packages/http-socket/src/index.ts packages/http-socket/test/policies.test.ts && \
git commit -m "feat(http-socket): @SocketPolicy gate reusing http policy groups on commands"
```

---

### Task 9A: `@SocketAccess` — authz-v3 access checks on commands and events

The socket form of authz-http's `@Access` (design §11.2, behaviour B23; D3). It decides through the frozen `AuthzService` contract, so it works today against any registered `AuthzService` and against F4's host once that merges. Field filters (`fields: 'filter'`), `subject: 'load'` and the convergence with L5's `AccessPolicy` are gated task G4.

**Files:**
- Create: `packages/http-socket/src/access.ts`
- Modify: `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/access.test.ts`

**Interfaces:**
- Consumes: `SocketPolicyGroup` (Task 6), `ISocketPolicyRequest` (Task 9), `ISocketCallStorage.Principal` / `AuthzDecision` (Task 6), `AccessDeniedMapping` (Task 4); from `@spinajs/authz`: `AuthzService.check(input: CheckInput): Promise<Decision>`, `AuthzDomains.service(name): AuthzService`, `parsePermission`, `AccessDenied`, `Unauthenticated`, `Permission`, `ResourceRef`, `ResourceType`, `Decision`.
- Produces:
  - `type SocketResourceExtractor = (call: ISocketPolicyRequest) => ResourceRef | object | Promise<ResourceRef | object>`
  - `interface ISocketAccessOptions { resource?: SocketResourceExtractor; also?: readonly Class<BasePolicy>[]; domain?: string; allowAnonymous?: boolean }`, `interface ISocketAccess extends ISocketAccessOptions { permissions: readonly Permission[] }`
  - `fromPayload(path: string, type: ResourceType): SocketResourceExtractor` (dotted path; a missing id throws `InvalidArgument('payload.<path> is required')`)
  - `@NewInstance() class SocketAccessPolicy extends BasePolicy` (constructor `(access: ISocketAccess)`)
  - `SocketAccess(permission: Permission | readonly Permission[], options?: ISocketAccessOptions)`: a class or method decorator that adds one group `[SocketAccessPolicy(access), ...also]`
  - Behaviour:
    - an unauthenticated principal (`UNATTENDED`, anonymous) without `allowAnonymous` → `unauthenticated`, and the engine is not asked
    - several permissions → any of them
    - no extractor → `{ type: parsePermission(permission).resource }`
    - allowed → `storage.AuthzDecision = decision`
    - denied → `AccessDenied(first denial)` → `forbidden` with `details { permission, resource, reason }`
    - `domain` other than `'root'` → `AuthzDomains.service(domain)`

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/access.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import { AuthzDomains, AuthzService, FALSE, TRUE, resourceKey } from '@spinajs/authz';
import type { AccessSummary, AuthorizationModel, AuthzAdmin, CheckInput, Decision, Permission, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess, fromPayload } from '../src/access.js';
import { ISocketCallStorage } from '../src/interfaces.js';
import { ALICE_PRINCIPAL, ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';

function unused(member: string): never {
  throw new Error(`AccTestAuthz.${member} is not used by socket tests`);
}

/** `${principal id}|${permission}|${resourceKey(resource)}` */
export const accAllowed = new Set<string>();
export const accChecks: Array<{ domain: string; input: CheckInput }> = [];

/** A scripted AuthzService: the F4 host and the F3 engine have not merged. */
export class AccTestAuthz extends AuthzService {
  public domain = 'root';

  public async check(input: CheckInput): Promise<Decision> {
    accChecks.push({ domain: this.domain, input });
    const resource = input.resource as ResourceRef;
    const allowed = accAllowed.has(`${input.principal.id}|${input.permission}|${resourceKey(resource)}`);

    return {
      allowed,
      permission: input.permission,
      resource,
      principal: { type: input.principal.type, id: input.principal.id },
      residual: allowed ? TRUE : FALSE,
      fields: { read: [], write: [] },
      roles: {},
      domain: this.domain,
      ...(allowed ? {} : { reason: { code: 'no_access', model: 'm1', priority: 400, sortKey: 'm1' } }),
    };
  }

  public current(): Principal {
    return unused('current');
  }

  public runAs<T>(): Promise<T> {
    return unused('runAs');
  }

  public can(): Promise<boolean> {
    return unused('can');
  }

  public assert(): Promise<Decision> {
    return unused('assert');
  }

  public checkMany(): Promise<ReadonlyMap<Permission, Decision>> {
    return unused('checkMany');
  }

  public filter(): Promise<ResourceFilter> {
    return unused('filter');
  }

  public filterNow(): ResourceFilter | undefined {
    return unused('filterNow');
  }

  public explain(): Promise<Decision> {
    return unused('explain');
  }

  public summary(): Promise<AccessSummary> {
    return unused('summary');
  }

  public covers(): Promise<boolean> {
    return unused('covers');
  }

  public preload(): Promise<void> {
    return unused('preload');
  }

  public invalidate(): void {
    unused('invalidate');
  }

  public models(): readonly AuthorizationModel[] {
    return unused('models');
  }

  public admin(): AuthzAdmin {
    return unused('admin');
  }
}

export class AccTestDomains extends AuthzDomains {
  public service(name: string): AuthzService {
    const service = new AccTestAuthz();
    service.domain = name;
    return service;
  }

  public create(): IContainer {
    return unused('create');
  }

  public container(): IContainer {
    return unused('container');
  }

  public names(): readonly string[] {
    return ['root', 'tenant'];
  }
}

export class AccDeny extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('denied by AccDeny');
  }
}

export class AccAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

const DOC = fromPayload('id', 'doc');

@SocketController('acc')
export class AccessSocket extends BaseSocketController {
  @Command('read')
  @SocketAccess('doc:read', { resource: DOC })
  public async read() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    return store?.AuthzDecision?.permission ?? null;
  }

  @Command('any')
  @SocketAccess(['doc:read', 'doc:write'], { resource: DOC })
  public async any() {
    return 'ok';
  }

  @Command('list')
  @SocketAccess('doc:list')
  public async list() {
    return 'listed';
  }

  @Command('open')
  @SocketAccess('doc:list', { allowAnonymous: true })
  public async open() {
    return 'unreachable for UNATTENDED';
  }

  @Command('also')
  @SocketAccess('doc:read', { resource: DOC, also: [AccDeny] })
  public async also() {
    return 'unreachable';
  }

  @Command('either')
  @SocketAccess('doc:read', { resource: DOC })
  @SocketPolicy(AccAllow)
  public async either() {
    return 'one path is enough';
  }

  @Command('tenant')
  @SocketAccess('doc:read', { resource: DOC, domain: 'tenant' })
  public async tenant() {
    return 'tenant';
  }

  @Command('nested')
  @SocketAccess('doc:read', { resource: fromPayload('doc.id', 'doc') })
  public async nested() {
    return 'nested';
  }
}

describe('@SocketAccess', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;
  let anonymous: ClientSocket;

  const lastCheck = () => accChecks[accChecks.length - 1];

  before(() => {
    DI.register(AccTestAuthz).as(AuthzService);
    DI.register(AccTestDomains).as(AuthzDomains);
  });

  after(() => {
    DI.unregister(AccTestAuthz);
    DI.unregister(AccTestDomains);
  });

  beforeEach(async () => {
    accAllowed.clear();
    accChecks.length = 0;
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'acc-alice', token: 'good' } });
    anonymous = await open(t, { auth: { clientId: 'acc-anon' } });
  });

  afterEach(async () => {
    alice.close();
    anonymous.close();
    await t.close();
  });

  it('allows through AuthzService.check with the connection principal and the extracted resource, and leaves the decision in the call storage', async () => {
    accAllowed.add('1|doc:read|doc:d1');

    expect(resultOf(await command(alice, 'acc.read', { id: 'd1' }))).to.equal('doc:read');
    expect(lastCheck().input.principal).to.equal(ALICE_PRINCIPAL);
    expect(lastCheck().input.resource).to.deep.equal({ type: 'doc', id: 'd1' });
    expect(lastCheck().domain).to.equal('root');
  });

  it('answers a denial with forbidden and the permission, resource and reason, without priority or sortKey (B23)', async () => {
    const error = errorOf(await command(alice, 'acc.read', { id: 'd2' }));

    expect(error).to.include({ code: 'forbidden', retryable: false });
    expect(error.details).to.deep.equal({ permission: 'doc:read', resource: { type: 'doc', id: 'd2' }, reason: { code: 'no_access', model: 'm1' } });
  });

  it('answers unauthenticated for an UNATTENDED connection without asking the engine', async () => {
    expect(errorOf(await command(anonymous, 'acc.list')).code).to.equal('unauthenticated');
    expect(accChecks).to.have.length(0);
  });

  it('allowAnonymous lets an unauthenticated principal reach the engine, which decides (B09: unattended is denied)', async () => {
    expect(errorOf(await command(anonymous, 'acc.open')).code).to.equal('forbidden');
    expect(lastCheck().input.principal.type).to.equal('unattended');
  });

  it('checks several permissions as any of them', async () => {
    accAllowed.add('1|doc:write|doc:d1');
    expect(resultOf(await command(alice, 'acc.any', { id: 'd1' }))).to.equal('ok');
  });

  it("defaults the resource to the type-level ref of the permission's resource", async () => {
    accAllowed.add('1|doc:list|doc');

    expect(resultOf(await command(alice, 'acc.list'))).to.equal('listed');
    expect(lastCheck().input.resource).to.deep.equal({ type: 'doc' });
  });

  it('B23 the also policies join the access group (AND)', async () => {
    accAllowed.add('1|doc:read|doc:d1');
    expect(errorOf(await command(alice, 'acc.also', { id: 'd1' }))).to.include({ code: 'forbidden', message: 'denied by AccDeny' });
  });

  it('B23 a separate @SocketPolicy group stays an alternative (OR)', async () => {
    expect(resultOf(await command(alice, 'acc.either', { id: 'd9' }))).to.equal('one path is enough');
  });

  it('asks the AuthzService of the named domain', async () => {
    accAllowed.add('1|doc:read|doc:d1');

    expect(resultOf(await command(alice, 'acc.tenant', { id: 'd1' }))).to.equal('tenant');
    expect(lastCheck().domain).to.equal('tenant');
  });

  it('fromPayload reads a dotted path and refuses a call without it', async () => {
    accAllowed.add('1|doc:read|doc:d3');

    expect(resultOf(await command(alice, 'acc.nested', { doc: { id: 'd3' } }))).to.equal('nested');
    expect(errorOf(await command(alice, 'acc.nested', {}))).to.include({ code: 'invalid_argument', message: 'payload.doc.id is required' });
  });

  it('refuses a malformed permission when the decorator runs', () => {
    expect(() => SocketAccess('not a permission')).to.throw();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/access.test.ts`
Expected: FAIL with `Cannot find module '../src/access.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/http-socket/src/access.ts`:

```ts
import { Class, DI, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import { AccessDenied, AuthzDomains, AuthzService, Unauthenticated, parsePermission } from '@spinajs/authz';
import type { Decision, Permission, ResourceRef, ResourceType } from '@spinajs/authz';
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
}

export interface ISocketAccess extends ISocketAccessOptions {
  permissions: readonly Permission[];
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

/**
 * Decides one `@SocketAccess` group as authz-http's AccessPolicy decides `@Access` ( design
 * §11.2 ): unauthenticated ⇒ Unauthenticated, several permissions ⇒ any of them, the allowing
 * decision stays in the call storage, a denial throws AccessDenied.
 */
@NewInstance()
export class SocketAccessPolicy extends BasePolicy {
  constructor(protected readonly access: ISocketAccess) {
    super();
  }

  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    const call = req as ISocketPolicyRequest;
    const principal = call.storage.Principal;

    if (!principal.authenticated && !this.access.allowAnonymous) {
      throw new Unauthenticated(`${call.originalUrl} needs an authenticated principal`);
    }

    const authz = await this.service();
    const extracted = this.access.resource ? await this.access.resource(call) : undefined;
    let denied: Decision | undefined;

    for (const permission of this.access.permissions) {
      const decision = await authz.check({ principal, permission, resource: extracted ?? { type: parsePermission(permission).resource } });

      if (decision.allowed) {
        call.storage.AuthzDecision = decision;
        return;
      }

      denied ??= decision;
    }

    throw new AccessDenied(denied!);
  }

  protected async service(): Promise<AuthzService> {
    const domain = this.access.domain ?? 'root';

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

  const access: ISocketAccess = { ...options, permissions };
  return SocketPolicyGroup([{ Type: SocketAccessPolicy, Options: [access] }, ...(options.also ?? []).map((Type) => ({ Type, Options: [] }))]);
}
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './access.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/access.test.ts test/policies.test.ts`
Expected: `19 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/access.ts packages/http-socket/src/index.ts packages/http-socket/test/access.test.ts && \
git commit -m "feat(http-socket): @SocketAccess decides commands through the authz-v3 AuthzService contract"
```

---

### Task 10: Limit stages (stages 1–3)

**Files:**
- Create: `packages/http-socket/src/stages/limits.ts`
- Modify: `packages/http-socket/src/stages/index.ts` (append)
- Test: `packages/http-socket/test/limits-pipeline.test.ts`

**Interfaces:**
- Consumes: `assertPayloadSize`, `assertRate` (Task 3), `IConnectionRuntime.bucket` / `inFlight` (Task 8), `STAGE_ORDER`.
- Produces: `SizeStage`, `RateStage`, `InFlightStage`, and `IN_FLIGHT_RETRY_AFTER_MS = 100`. An in-flight slot is held until the handler settles, even after an abort has already answered.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/limits-pipeline.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer } from './harness.js';

let release: () => void = () => undefined;
let gate: Promise<void> = Promise.resolve();

@SocketController('lim')
export class LimitSocket extends BaseSocketController {
  @Command('echo')
  public async echo(@Payload() payload: unknown) {
    return payload;
  }

  @Command('hold')
  public async hold() {
    await gate;
    return 'released';
  }
}

describe('socket pipeline limits', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  afterEach(async () => {
    socket.close();
    await t.close();
  });

  it('answers an oversized payload with a non-retryable resource_exhausted', async () => {
    t = await startServer({ http: { socket: { maxPayloadBytes: 1024 } } });
    socket = await open(t);

    const error = errorOf(await command(socket, 'lim.echo', 'x'.repeat(1500)));
    expect(error).to.include({ code: 'resource_exhausted', retryable: false });
    expect(error.details).to.deep.equal({ size: 1502, limit: 1024 });
    expect(resultOf(await command(socket, 'lim.echo', 'small'))).to.equal('small');
  });

  it('answers a burst over the rate with resource_exhausted and retryAfterMs', async () => {
    t = await startServer({ http: { socket: { rate: { perSecond: 1, burst: 2 } } } });
    socket = await open(t);

    const replies = await Promise.all([1, 2, 3].map((n) => command(socket, 'lim.echo', n)));
    expect(replies.filter((r) => r.ok)).to.have.length(2);

    const error = errorOf(replies[2]);
    expect(error).to.include({ code: 'resource_exhausted', retryable: true });
    expect(error.retryAfterMs).to.be.greaterThan(0).and.at.most(1000);
  });

  it('answers commands over the in-flight limit with resource_exhausted and retryAfterMs', async () => {
    t = await startServer({ http: { socket: { maxInFlightPerConnection: 2 } } });
    socket = await open(t);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = command(socket, 'lim.hold');
    const second = command(socket, 'lim.hold');
    await delay(50);

    expect(errorOf(await command(socket, 'lim.hold'))).to.deep.equal({ code: 'resource_exhausted', message: 'more than 2 commands in flight on this connection', retryable: true, retryAfterMs: 100 });

    release();
    expect(resultOf(await first)).to.equal('released');
    expect(resultOf(await second)).to.equal('released');
    expect(resultOf(await command(socket, 'lim.hold'))).to.equal('released');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/limits-pipeline.test.ts`
Expected: 3 failing. The size test gets a result instead of an error (`expected an error reply`), the rate test sees 3 ok replies, and the in-flight test's third command waits for the gate until the 5 s ack timeout (`operation has timed out`).

- [ ] **Step 3: Write the implementation**

Create `packages/http-socket/src/stages/limits.ts`:

```ts
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketCommandContext, ISocketServerConfig, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { assertPayloadSize, assertRate } from '../limits.js';

export const IN_FLIGHT_RETRY_AFTER_MS = 100;

@Injectable(SocketCommandStage)
export class SizeStage extends SocketCommandStage {
  @Config('http.socket')
  protected Options: ISocketServerConfig;

  public get Order(): number {
    return STAGE_ORDER.Size;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    assertPayloadSize(ctx.payload, this.Options.maxPayloadBytes);
    return next();
  }
}

@Injectable(SocketCommandStage)
export class RateStage extends SocketCommandStage {
  public get Order(): number {
    return STAGE_ORDER.Rate;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    assertRate(ctx.runtime.bucket);
    return next();
  }
}

@Injectable(SocketCommandStage)
export class InFlightStage extends SocketCommandStage {
  @Config('http.socket')
  protected Options: ISocketServerConfig;

  public get Order(): number {
    return STAGE_ORDER.InFlight;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const max = this.Options.maxInFlightPerConnection;

    if (ctx.runtime.inFlight >= max) {
      throw new SocketException('resource_exhausted', `more than ${max} commands in flight on this connection`, { retryAfterMs: IN_FLIGHT_RETRY_AFTER_MS });
    }

    // The slot is held until the handler settles, even after an abort answered the client:
    // otherwise cancel-and-resend would run unbounded handlers.
    ctx.runtime.inFlight++;
    try {
      return await next();
    } finally {
      ctx.runtime.inFlight--;
    }
  }
}
```

Append to `packages/http-socket/src/stages/index.ts`:

```ts
export * from './limits.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/limits-pipeline.test.ts`
Expected: `3 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/stages/limits.ts packages/http-socket/src/stages/index.ts packages/http-socket/test/limits-pipeline.test.ts && \
git commit -m "feat(http-socket): size, rate and in-flight limit stages"
```

---

### Task 10A: Authentication stage — expiry and revalidation of live connections

A socket outlives the credential it opened with. This task makes revocation and expiry take effect on open connections (D16), the socket form of SR-06 and SR-08.

**Files:**
- Create: `packages/http-socket/src/principal-guard.ts`, `packages/http-socket/src/stages/authentication.ts`
- Modify: `packages/http-socket/src/stages/index.ts`, `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/revalidation.test.ts`

**Interfaces:**
- Consumes: `SocketPrincipalSource.revalidate`, `ISocketAuthState`, `SocketConnection.auth` / `handshake` / `connected` / `disconnect` (Task 5), `STAGE_ORDER.Authentication`, `SocketCommandStage` (Task 8), `ISocketAuthConfig` (Task 2); `Unauthenticated` from `@spinajs/authz`.
- Produces:
  - `@Injectable() class SocketPrincipalGuard { ensure(connection: SocketConnection): Promise<void> }`. It throws `Unauthenticated('credentials expired')` or `Unauthenticated('credentials are no longer valid')`, then disconnects with reason `'unauthenticated'` after the current reply. Task 13 calls it for events as well.
  - `AuthenticationStage` (`STAGE_ORDER.Authentication` = 350)

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/revalidation.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/authz';
import { SYSTEM_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { ISocketHandshake, SocketPrincipalSource } from '../src/interfaces.js';
import { ITestServer, command, delay, errorOf, nextEvent, open, resultOf, startServer, waitFor } from './harness.js';

export const revalRevoked = new Set<string>();
export let revalChecks = 0;

/** Owns the tokens starting with 'reval-'. */
export class RevalSource extends SocketPrincipalSource {
  public readonly name = 'reval';
  public readonly order = 1;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('reval-')) {
      return null;
    }

    revalChecks++;
    if (revalRevoked.has(token)) {
      throw new AuthenticationFailed('revoked');
    }

    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {}, ...(token === 'reval-expiring' ? { ceiling: { expiresAt: new Date(Date.now() + 400) } } : {}) };
  }
}

DI.register(RevalSource).as(SocketPrincipalSource);

@SocketController('reval')
export class RevalSocket extends BaseSocketController {
  @Command('ping')
  public async ping() {
    return 'pong';
  }
}

describe('socket principal revalidation', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  const start = async (revalidateMs: number, token?: string) => {
    t = await startServer({ http: { socket: { auth: { revalidateMs } } } });
    socket = await open(t, { auth: token ? { clientId: 'reval-client', token } : { clientId: 'reval-client' } });
  };

  afterEach(async () => {
    socket.close();
    await t.close();
  });

  it('SR-08 a credential revoked while the socket is open stops working after revalidateMs, and the socket is closed', async () => {
    await start(50, 'reval-a');
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    revalRevoked.add('reval-a');
    await delay(80);
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);

    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials are no longer valid', retryable: false });
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    await waitFor(() => !socket.connected);
  });

  it('refuses a principal whose ceiling expired without asking its source', async () => {
    await start(60_000, 'reval-expiring');
    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');

    await delay(500);
    const before = revalChecks;

    expect(errorOf(await command(socket, 'reval.ping'))).to.deep.equal({ code: 'unauthenticated', message: 'credentials expired', retryable: false });
    expect(revalChecks).to.equal(before);
  });

  it('revalidates once for concurrent commands and then waits revalidateMs again', async () => {
    await start(200, 'reval-b');
    await delay(250);
    const before = revalChecks;

    const replies = await Promise.all([1, 2, 3].map(() => command(socket, 'reval.ping')));
    expect(replies.every((r) => r.ok)).to.be.true;
    expect(revalChecks - before).to.equal(1);

    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
    expect(revalChecks - before).to.equal(1);
  });

  it('never revalidates with revalidateMs 0', async () => {
    await start(0, 'reval-c');
    revalRevoked.add('reval-c');
    await delay(30);

    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
  });

  it('leaves UNATTENDED connections alone', async () => {
    await start(10);
    await delay(30);

    expect(resultOf(await command(socket, 'reval.ping'))).to.equal('pong');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/revalidation.test.ts`
Expected: 3 failing and 2 passing. The revoked and the expired commands still answer `pong` (`expected an error reply`), and the concurrency test counts no check (`expected 0 to equal 1`). The `revalidateMs 0` and `UNATTENDED` tests pass, because nothing revalidates yet.

- [ ] **Step 3: Write the implementation**

Create `packages/http-socket/src/principal-guard.ts`:

```ts
import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Unauthenticated } from '@spinajs/authz';
import { ISocketAuthConfig, SocketPrincipalSource } from './interfaces.js';
import { SocketConnection } from './connection.js';

/** Re-checks the principal of a live connection ( D16 ). */
@Injectable()
export class SocketPrincipalGuard {
  @Config('http.socket.auth')
  protected Options: ISocketAuthConfig;

  @Autoinject(SocketPrincipalSource)
  protected Sources: SocketPrincipalSource[];

  protected pending = new WeakMap<SocketConnection, Promise<boolean>>();

  public async ensure(connection: SocketConnection): Promise<void> {
    const auth = connection.auth;

    if (auth.source === null) {
      return;
    }

    const expiresAt = auth.principal.ceiling?.expiresAt;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      this.refuse(connection, 'credentials expired');
    }

    if (this.Options.revalidateMs <= 0 || Date.now() - auth.checkedAt < this.Options.revalidateMs) {
      return;
    }

    let check = this.pending.get(connection);
    if (!check) {
      check = this.revalidate(connection).finally(() => this.pending.delete(connection));
      this.pending.set(connection, check);
    }

    if (!(await check)) {
      this.refuse(connection, 'credentials are no longer valid');
    }
  }

  protected async revalidate(connection: SocketConnection): Promise<boolean> {
    const source = this.Sources.find((s) => s.name === connection.auth.source);
    if (!source) {
      return false;
    }

    const valid = await source.revalidate(connection.handshake, connection.principal);
    if (valid) {
      connection.auth.checkedAt = Date.now();
    }

    return valid;
  }

  protected refuse(connection: SocketConnection, message: string): never {
    // setImmediate: the reply carrying this refusal is written first ( it goes out in a microtask )
    setImmediate(() => {
      if (connection.connected) {
        connection.disconnect('unauthenticated');
      }
    });

    throw new Unauthenticated(message);
  }
}
```

Create `packages/http-socket/src/stages/authentication.ts`:

```ts
import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketPrincipalGuard } from '../principal-guard.js';

@Injectable(SocketCommandStage)
export class AuthenticationStage extends SocketCommandStage {
  @Autoinject()
  protected Guard: SocketPrincipalGuard;

  public get Order(): number {
    return STAGE_ORDER.Authentication;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    await this.Guard.ensure(ctx.connection);
    return next();
  }
}
```

Append to `packages/http-socket/src/stages/index.ts`:

```ts
export * from './authentication.js';
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './principal-guard.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/revalidation.test.ts test/limits-pipeline.test.ts test/pipeline.test.ts`
Expected: `22 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/principal-guard.ts packages/http-socket/src/stages/authentication.ts packages/http-socket/src/stages/index.ts packages/http-socket/src/index.ts packages/http-socket/test/revalidation.test.ts && \
git commit -m "feat(http-socket): re-check expiry and revocation of a live connection's principal"
```

---

### Task 11: Deadline, cancel, disconnect and shutdown signals (stage 9)

**Files:**
- Modify: `packages/http-socket/src/dispatcher.ts` (import, `attach`, `detach`, `createContext`; new `onCancel`, `abortAll`, `abortRunning`)
- Modify: `packages/http-socket/src/stages/lookup.ts` (arm the command deadline)
- Modify: `packages/http-socket/src/server.ts` (`dispose` aborts running commands)
- Test: `packages/http-socket/test/signals.test.ts`

**Interfaces:**
- Consumes: `SocketCommandContext.armDeadline` / `abort` (Task 8), `isCancelFrame` (Task 1).
- Produces:
  - `SocketDispatcher.abortAll(reason: SocketException): void`, which W3's drain calls after `drainMs`
  - deadline → `deadline_exceeded` (retryable); client `cancel {id}` → `cancelled`; disconnect → `unavailable` ('connection closed'); `SocketServer.dispose()` → `unavailable` ('server is shutting down')

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/signals.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, Signal, SocketController } from '../src/decorators.js';
import { ITestServer, command, delay, errorOf, open, startServer, waitFor } from './harness.js';

export const sigAborts = new Map<string, unknown>();

async function waitForAbort(key: string, signal: AbortSignal): Promise<string> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  sigAborts.set(key, signal.reason);
  return 'aborted';
}

@SocketController('sig')
export class SignalSocket extends BaseSocketController {
  @Command('wait')
  public async wait(@Payload() p: { key: string }, @Signal() signal: AbortSignal) {
    return waitForAbort(p.key, signal);
  }

  @Command('slow', { timeoutMs: 50 })
  public async slow(@Payload() p: { key: string }, @Signal() signal: AbortSignal) {
    return waitForAbort(p.key, signal);
  }
}

const reasonOf = (key: string) => sigAborts.get(key) as SocketException | undefined;

describe('socket command signals', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    socket.close();
    await t.close();
  });

  it('aborts at the client deadline with a retryable deadline_exceeded', async () => {
    const started = Date.now();
    const error = errorOf(await command(socket, 'sig.wait', { key: 'd1' }, { deadline: 50 }));

    expect(error).to.include({ code: 'deadline_exceeded', retryable: true });
    expect(Date.now() - started).to.be.lessThan(1000);
    await waitFor(() => sigAborts.has('d1'));
    expect(reasonOf('d1')?.code).to.equal('deadline_exceeded');
  });

  it('aborts at the command timeoutMs', async () => {
    expect(errorOf(await command(socket, 'sig.slow', { key: 's1' })).code).to.equal('deadline_exceeded');
    await waitFor(() => sigAborts.has('s1'));
    expect(reasonOf('s1')?.code).to.equal('deadline_exceeded');
  });

  it('keeps the earlier of the client deadline and timeoutMs', async () => {
    const started = Date.now();
    expect(errorOf(await command(socket, 'sig.slow', { key: 's2' }, { deadline: 5000 })).code).to.equal('deadline_exceeded');
    expect(Date.now() - started).to.be.lessThan(1000);
  });

  it('aborts on a client cancel with cancelled', async () => {
    const pending = command(socket, 'sig.wait', { key: 'c1' }, { id: 'cancel-me' });
    await delay(50);
    socket.emit(WIRE_EVENTS.cancel, { id: 'cancel-me' });

    expect(errorOf(await pending)).to.include({ code: 'cancelled', retryable: false });
    await waitFor(() => sigAborts.has('c1'));
    expect(reasonOf('c1')?.code).to.equal('cancelled');
  });

  it('aborts running handlers when the client disconnects', async () => {
    void command(socket, 'sig.wait', { key: 'x1' }).catch(() => undefined);
    await delay(50);
    socket.disconnect();

    await waitFor(() => sigAborts.has('x1'));
    expect(reasonOf('x1')?.code).to.equal('unavailable');
  });

  it('aborts running handlers when the server is disposed', async () => {
    void command(socket, 'sig.wait', { key: 'z1' }).catch(() => undefined);
    await delay(50);
    await t.server.dispose();

    await waitFor(() => sigAborts.has('z1'));
    expect(reasonOf('z1')?.code).to.equal('unavailable');
    expect(reasonOf('z1')?.message).to.equal('server is shutting down');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/signals.test.ts`
Expected: 6 failing. The first four fail with `operation has timed out` (nothing aborts the handler), and the last two fail with `condition not met in time`.

- [ ] **Step 3: Wire the signals**

In `packages/http-socket/src/dispatcher.ts`, change the common import to:

```ts
import { CommandReply, CommandRequest, SocketException, WIRE_EVENTS, isCancelFrame, isCommandRequest } from '@spinajs/http-socket-common';
```

In `attach`, directly after the line `socket.on(WIRE_EVENTS.command, (request: unknown, ack: unknown) => this.onCommand(runtime, request, ack));`, add:

```ts
    socket.on(WIRE_EVENTS.cancel, (frame: unknown) => this.onCancel(runtime, frame));
```

Replace the whole `detach` method with:

```ts
  public detach(connection: SocketConnection, _reason: string): void {
    const runtime = this.runtimes.get(connection.id);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(connection.id);
    this.abortRunning(runtime, new SocketException('unavailable', 'connection closed'));
  }

  /** Aborts every running command on every connection ( shutdown ). */
  public abortAll(reason: SocketException): void {
    for (const runtime of this.runtimes.values()) {
      this.abortRunning(runtime, reason);
    }
  }
```

Replace the whole `createContext` method with:

```ts
  protected createContext(runtime: IConnectionRuntime, request: CommandRequest): SocketCommandContext {
    const ctx = new SocketCommandContext(runtime, request, this.callStorage(runtime.connection, request.name, request.id, request.traceparent));
    ctx.armDeadline(request.deadline);
    return ctx;
  }

  protected onCancel(runtime: IConnectionRuntime, frame: unknown): void {
    if (!isCancelFrame(frame)) {
      return;
    }

    runtime.running.get(frame.id)?.abort(new SocketException('cancelled', `command ${frame.id} cancelled by the client`));
  }

  protected abortRunning(runtime: IConnectionRuntime, reason: SocketException): void {
    for (const ctx of runtime.running.values()) {
      ctx.abort(reason);
    }
  }
```

In `packages/http-socket/src/stages/lookup.ts`, replace:

```ts
    ctx.handler = handler;
    return next();
```

with:

```ts
    ctx.handler = handler;
    ctx.armDeadline(handler.descriptor.Options.timeoutMs);
    return next();
```

In `packages/http-socket/src/server.ts`, replace:

```ts
    this._io = null;
    io.disconnectSockets(true);
```

with:

```ts
    this._io = null;
    this.Dispatcher.abortAll(new SocketException('unavailable', 'server is shutting down'));
    io.disconnectSockets(true);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/signals.test.ts test/pipeline.test.ts`
Expected: `20 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/dispatcher.ts packages/http-socket/src/stages/lookup.ts packages/http-socket/src/server.ts packages/http-socket/test/signals.test.ts && \
git commit -m "feat(http-socket): AbortSignal for deadlines, client cancel, disconnect and shutdown"
```

---

### Task 12: Ordered commands (stage 8)

**Files:**
- Create: `packages/http-socket/src/queue.ts`, `packages/http-socket/src/stages/ordering.ts`
- Modify: `packages/http-socket/src/stages/index.ts`, `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/ordering.test.ts`

**Interfaces:**
- Consumes: `ICommandOptions.ordered` (Task 6), `ISocketCommandContext.signal` (Task 8).
- Produces:
  - `class SerialQueue { run<T>(key: string, task: () => Promise<T>): Promise<T>; Size: number }`
  - `OrderingStage` (`STAGE_ORDER.Ordering`), with keys `connection:<connectionId>` and `client:<clientId>`. A command whose signal fired while it waited is skipped, so its handler never runs.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/ordering.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { SerialQueue } from '../src/queue.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer } from './harness.js';

export const ordDone: string[] = [];

interface IOrdStep {
  tag: string;
  ms: number;
}

async function step(p: IOrdStep): Promise<string> {
  await delay(p.ms);
  ordDone.push(p.tag);
  return p.tag;
}

@SocketController('ord')
export class OrderingSocket extends BaseSocketController {
  @Command('conn', { ordered: 'connection' })
  public async conn(@Payload() p: IOrdStep) {
    return step(p);
  }

  @Command('client', { ordered: 'client' })
  public async client(@Payload() p: IOrdStep) {
    return step(p);
  }

  @Command('free')
  public async free(@Payload() p: IOrdStep) {
    return step(p);
  }
}

describe('SerialQueue', () => {
  const task = (log: string[], tag: string, ms: number) => async () => {
    log.push(`${tag}:start`);
    await delay(ms);
    log.push(`${tag}:end`);
    return tag;
  };

  it('runs tasks with one key one after another', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    expect(await Promise.all([queue.run('k', task(log, 'A', 30)), queue.run('k', task(log, 'B', 0))])).to.deep.equal(['A', 'B']);
    expect(log).to.deep.equal(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('runs different keys side by side', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    await Promise.all([queue.run('k1', task(log, 'A', 30)), queue.run('k2', task(log, 'B', 0))]);
    expect(log.indexOf('B:end')).to.be.lessThan(log.indexOf('A:end'));
  });

  it('does not let a failed task block the next one', async () => {
    const queue = new SerialQueue();
    const failed = queue.run('k', async () => {
      throw new Error('fail');
    });
    const next = queue.run('k', async () => 'b');
    await expect(failed).to.be.rejectedWith('fail');
    expect(await next).to.equal('b');
  });

  it('forgets a key once its queue drains', async () => {
    const queue = new SerialQueue();
    await queue.run('k', async () => 1);
    await delay(0);
    expect(queue.Size).to.equal(0);
  });
});

describe('socket ordered commands', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const connectAs = async (clientId: string) => {
    const socket = await open(t, { auth: { clientId } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    ordDone.length = 0;
    t = await startServer();
  });

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('lets unordered commands finish in any order', async () => {
    const s = await connectAs('ord-free');
    await Promise.all([command(s, 'ord.free', { tag: 'A', ms: 80 }), command(s, 'ord.free', { tag: 'B', ms: 0 })]);
    expect(ordDone).to.deep.equal(['B', 'A']);
  });

  it("runs ordered: 'connection' commands in send order", async () => {
    const s = await connectAs('ord-conn');
    await Promise.all([command(s, 'ord.conn', { tag: 'A', ms: 80 }), command(s, 'ord.conn', { tag: 'B', ms: 0 })]);
    expect(ordDone).to.deep.equal(['A', 'B']);
  });

  it("runs ordered: 'client' commands in order across connections of one clientId", async () => {
    const first = await connectAs('ord-same');
    const second = await connectAs('ord-same');
    const a = command(first, 'ord.client', { tag: 'A', ms: 80 });
    await delay(20);
    const b = command(second, 'ord.client', { tag: 'B', ms: 0 });
    await Promise.all([a, b]);
    expect(ordDone).to.deep.equal(['A', 'B']);
  });

  it("keeps different clientIds independent under ordered: 'client'", async () => {
    const first = await connectAs('ord-x');
    const second = await connectAs('ord-y');
    const a = command(first, 'ord.client', { tag: 'A', ms: 80 });
    await delay(20);
    const b = command(second, 'ord.client', { tag: 'B', ms: 0 });
    await Promise.all([a, b]);
    expect(ordDone).to.deep.equal(['B', 'A']);
  });

  it('skips a queued command whose deadline passed while it waited', async () => {
    const s = await connectAs('ord-late');
    const a = command(s, 'ord.conn', { tag: 'A', ms: 150 });
    const b = command(s, 'ord.conn', { tag: 'B', ms: 0 }, { deadline: 50 });

    expect(errorOf(await b).code).to.equal('deadline_exceeded');
    expect(resultOf(await a)).to.equal('A');
    await delay(50);
    expect(ordDone).to.deep.equal(['A']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/ordering.test.ts`
Expected: FAIL with `Cannot find module '../src/queue.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/http-socket/src/queue.ts`:

```ts
/** Runs tasks one at a time per key; different keys run side by side. */
export class SerialQueue {
  protected tails = new Map<string, Promise<void>>();

  public run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return result;
  }

  /** Keys with queued or running work. */
  public get Size(): number {
    return this.tails.size;
  }
}
```

Create `packages/http-socket/src/stages/ordering.ts`:

```ts
import { Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SerialQueue } from '../queue.js';

/**
 * `ordered: 'connection'` serialises a connection's commands; `ordered: 'client'` serialises a
 * clientId's commands across reconnects. In memory, per server instance.
 */
@Injectable(SocketCommandStage)
export class OrderingStage extends SocketCommandStage {
  protected Queue = new SerialQueue();

  public get Order(): number {
    return STAGE_ORDER.Ordering;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const mode = ctx.handler?.descriptor.Options.ordered;

    if (!mode) {
      return next();
    }

    const key = mode === 'client' ? `client:${ctx.connection.clientId}` : `connection:${ctx.connection.id}`;

    return this.Queue.run(key, async () => {
      // already answered ( deadline, cancel, disconnect ) while it waited: never start the handler
      if (ctx.signal.aborted) {
        throw ctx.signal.reason;
      }

      return next();
    });
  }
}
```

Append to `packages/http-socket/src/stages/index.ts`:

```ts
export * from './ordering.js';
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './queue.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/ordering.test.ts`
Expected: `9 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/queue.ts packages/http-socket/src/stages/ordering.ts packages/http-socket/src/stages/index.ts packages/http-socket/src/index.ts packages/http-socket/test/ordering.test.ts && \
git commit -m "feat(http-socket): ordered commands per connection or per clientId"
```

---

### Task 13: Client events and lifecycle hooks

**Files:**
- Replace: `packages/http-socket/src/dispatcher.ts` (full file below; it contains every Task 8 and Task 11 change)
- Test: `packages/http-socket/test/events.test.ts`

**Interfaces:**
- Consumes: `SocketHandlerRegistry.event` / `hooks` (Task 7), `SocketPolicyGate` (Task 9), `SocketArgumentResolver` (Task 6), `assertPayloadSize` / `assertRate` (Task 3), `SocketPrincipalGuard` (Task 10A), `SocketPrincipalSource` (Task 5).
- Produces:
  - `evt` frames from the client go through size → rate → principal guard → lookup → policies → arguments → handler, with policies, arguments and handler inside the call's AsyncLocalStorage store (D14). A failure is logged and dropped, and the socket stays up, except that a failed principal check closes it (D16).
  - Hooks run with the same store, so `@OnConnect` code sees the connection principal.
  - `@OnConnect` hooks run on connect, and `runtime.ready` settles when they are done (commands wait for it). `@OnDisconnect` hooks run after the connect hooks, with `@Reason()`.
  - `SocketDispatcher.call(ctx, handler)` (protected), shared by events and hooks.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/events.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { Principal } from '@spinajs/authz';
import { WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnConnect, OnDisconnect, OnEvent, Payload, Reason, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { ISocketHandshake, SocketPrincipalSource } from '../src/interfaces.js';
import { ITestServer, command, delay, open, resultOf, startServer, waitFor } from './harness.js';

export const evtLog: Array<{ name: string; payload?: unknown; connection: string }> = [];

export const evtRevoked = new Set<string>();

/** Owns the tokens starting with 'evtauth-'. */
export class EvtAuthSource extends SocketPrincipalSource {
  public readonly name = 'evt-auth';
  public readonly order = 2;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('evtauth-')) {
      return null;
    }

    if (evtRevoked.has(token)) {
      throw new AuthenticationFailed('revoked');
    }

    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {} };
  }
}

DI.register(EvtAuthSource).as(SocketPrincipalSource);

export class EvtDeny extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('no');
  }
}

@SocketController('evt')
export class EventSocket extends BaseSocketController {
  @OnEvent('cursor', { schema: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } } })
  public async cursor(@Payload() at: { x: number }, @Connection() conn: SocketConnection) {
    evtLog.push({ name: 'cursor', payload: at, connection: conn.id });
  }

  @OnEvent('explode')
  public async explode(): Promise<void> {
    throw new Error('event handler failure');
  }

  @OnEvent('guarded')
  @SocketPolicy(EvtDeny)
  public async guarded(@Connection() conn: SocketConnection) {
    evtLog.push({ name: 'guarded', connection: conn.id });
  }

  @OnConnect()
  public async joined(@Connection() conn: SocketConnection) {
    await delay(20);
    conn.join('evt-lobby');
  }

  @OnConnect()
  public async failing(): Promise<void> {
    throw new Error('connect hook failure');
  }

  @OnDisconnect()
  public async left(@Connection() conn: SocketConnection, @Reason() reason: string) {
    evtLog.push({ name: 'disconnect', payload: reason, connection: conn.id });
  }

  @Command('rooms')
  public async rooms(@Connection() conn: SocketConnection) {
    return [...conn.rooms];
  }
}

const seen = (name: string, connection: string) => evtLog.filter((e) => e.name === name && e.connection === connection);

describe('socket events and lifecycle hooks', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  const start = async (cfg: Record<string, unknown> = {}) => {
    t = await startServer(cfg);
    socket = await open(t);
  };

  afterEach(async () => {
    socket.close();
    await t.close();
  });

  it('delivers a client event to its handler', async () => {
    await start();
    socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x: 3 } });

    await waitFor(() => seen('cursor', socket.id!).length === 1);
    expect(seen('cursor', socket.id!)[0].payload).to.deep.equal({ x: 3 });
  });

  it('drops an event whose payload fails validation and keeps the socket', async () => {
    await start();
    socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: {} });
    await delay(100);

    expect(seen('cursor', socket.id!)).to.have.length(0);
    expect(resultOf(await command(socket, 'evt.rooms'))).to.include('evt-lobby');
  });

  it('survives a throwing handler and an unknown event', async () => {
    await start();
    socket.emit(WIRE_EVENTS.event, { name: 'evt.explode', payload: null });
    socket.emit(WIRE_EVENTS.event, { name: 'evt.unknown', payload: null });
    await delay(100);

    expect(socket.connected).to.be.true;
    expect(resultOf(await command(socket, 'evt.rooms'))).to.include('evt-lobby');
  });

  it('applies policies to events', async () => {
    await start();
    socket.emit(WIRE_EVENTS.event, { name: 'evt.guarded', payload: null });
    await delay(100);

    expect(seen('guarded', socket.id!)).to.have.length(0);
  });

  it('finishes the connect hooks before the first command and survives a failing hook', async () => {
    await start();

    expect(socket.connected).to.be.true;
    expect(resultOf(await command(socket, 'evt.rooms'))).to.include('evt-lobby');
  });

  it('runs the disconnect hooks with the reason', async () => {
    await start();
    const id = socket.id!;
    socket.disconnect();

    await waitFor(() => seen('disconnect', id).length === 1);
    expect(seen('disconnect', id)[0].payload).to.equal('client namespace disconnect');
  });

  it('drops events from a connection whose credentials stopped working, and closes it (D16)', async () => {
    t = await startServer({ http: { socket: { auth: { revalidateMs: 50 } } } });
    socket = await open(t, { auth: { token: 'evtauth-a' } });
    const id = socket.id!;

    evtRevoked.add('evtauth-a');
    await delay(80);
    socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x: 9 } });

    await waitFor(() => !socket.connected);
    expect(seen('cursor', id)).to.have.length(0);
  });

  it('drops an oversized event', async () => {
    await start({ http: { socket: { maxPayloadBytes: 200 } } });
    socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x: 1, pad: 'x'.repeat(300) } });
    await delay(100);

    expect(seen('cursor', socket.id!)).to.have.length(0);
    expect(socket.connected).to.be.true;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/events.test.ts`
Expected: 6 failing, because events and hooks are not wired yet: "delivers a client event", "drops an event whose payload fails validation", "survives a throwing handler and an unknown event", "finishes the connect hooks", "runs the disconnect hooks" and "drops events from a connection whose credentials stopped working" (nothing reads `evt` frames, so nothing re-checks the principal and the socket stays open). Three of them need the `evt-lobby` room that the connect hook joins. "applies policies to events" and "drops an oversized event" pass trivially for now.

- [ ] **Step 3: Replace the dispatcher**

Replace `packages/http-socket/src/dispatcher.ts` with:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Socket } from 'socket.io';
import { AsyncService, Autoinject, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger, newTraceContext } from '@spinajs/log';
import { CommandReply, CommandRequest, SocketException, WIRE_EVENTS, isCancelFrame, isCommandRequest, isEventFrame } from '@spinajs/http-socket-common';
import { IConnectionRuntime, IRegisteredHandler, ISocketCallContext, ISocketCallStorage, ISocketServerConfig, SocketCommandStage } from './interfaces.js';
import { SocketConnection } from './connection.js';
import { SocketCommandContext } from './context.js';
import { SocketErrorMapper } from './errors.js';
import { TokenBucket, assertPayloadSize, assertRate } from './limits.js';
import { SocketHandlerRegistry } from './registry.js';
import { SocketArgumentResolver } from './args.js';
import { SocketPolicyGate } from './policies.js';
import { SocketPrincipalGuard } from './principal-guard.js';
import './stages/index.js';

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function';
}

@Injectable()
export class SocketDispatcher extends AsyncService {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  @Autoinject()
  protected Errors: SocketErrorMapper;

  @Autoinject()
  protected Registry: SocketHandlerRegistry;

  @Autoinject()
  protected Arguments: SocketArgumentResolver;

  @Autoinject()
  protected Gate: SocketPolicyGate;

  @Autoinject()
  protected Guard: SocketPrincipalGuard;

  @Autoinject()
  protected Als: AsyncLocalStorage<ISocketCallStorage>;

  protected Stages: SocketCommandStage[] = [];

  protected runtimes = new Map<string, IConnectionRuntime>();

  public async resolve(): Promise<void> {
    await super.resolve();
    const stages = (await DI.resolve(Array.ofType(SocketCommandStage))) as SocketCommandStage[];
    this.Stages = [...stages].sort((a, b) => a.Order - b.Order);
  }

  public attach(connection: SocketConnection, socket: Socket): IConnectionRuntime {
    const runtime: IConnectionRuntime = {
      connection,
      bucket: new TokenBucket(this.Options.rate.perSecond, this.Options.rate.burst),
      inFlight: 0,
      running: new Map(),
      ready: Promise.resolve(),
    };

    this.runtimes.set(connection.id, runtime);
    socket.on(WIRE_EVENTS.command, (request: unknown, ack: unknown) => this.onCommand(runtime, request, ack));
    socket.on(WIRE_EVENTS.cancel, (frame: unknown) => this.onCancel(runtime, frame));
    socket.on(WIRE_EVENTS.event, (frame: unknown) => {
      void this.onEvent(runtime, frame);
    });
    runtime.ready = this.runHooks(runtime, 'connect');

    return runtime;
  }

  public detach(connection: SocketConnection, reason: string): void {
    const runtime = this.runtimes.get(connection.id);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(connection.id);
    this.abortRunning(runtime, new SocketException('unavailable', 'connection closed'));
    // even when the client leaves while its connect hooks still run, the disconnect hooks come after them
    void runtime.ready.then(() => this.runHooks(runtime, 'disconnect', reason));
  }

  /** Aborts every running command on every connection ( shutdown ). */
  public abortAll(reason: SocketException): void {
    for (const runtime of this.runtimes.values()) {
      this.abortRunning(runtime, reason);
    }
  }

  /** Runs one command through the stages and the handler; never rejects. */
  public async execute(ctx: SocketCommandContext): Promise<CommandReply> {
    const runtime = ctx.runtime;
    runtime.running.set(ctx.request.id, ctx);

    let reply: CommandReply;

    try {
      await runtime.ready;

      // D14: stages, hydrators and the handler all see the principal ( AuthzService.current() once F4 lands )
      const chain = this.Als.run(ctx.storage, () => this.next(ctx, 0));
      // An abort answers at once; the chain keeps running ( and holds its in-flight slot ) until the handler settles.
      chain.catch(() => undefined);
      const abort = aborted(ctx.signal);
      abort.catch(() => undefined);

      const result = await Promise.race([chain, abort]);
      reply = await this.toReply(ctx, result);
    } catch (err) {
      reply = { id: ctx.request.id, ok: false, error: this.Errors.toWire(err, `command ${ctx.request.name}`) };
    } finally {
      ctx.dispose();
      if (runtime.running.get(ctx.request.id) === ctx) {
        runtime.running.delete(ctx.request.id);
      }
    }

    return reply;
  }

  protected onCommand(runtime: IConnectionRuntime, raw: unknown, ack: unknown): void {
    if (typeof ack !== 'function') {
      this.Log.warn(`Socket command without an ack callback from connection ${runtime.connection.id}, ignored`);
      return;
    }

    const reply = ack as (reply: CommandReply) => void;

    if (!isCommandRequest(raw)) {
      const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : '';
      reply({ id, ok: false, error: new SocketException('invalid_argument', 'malformed command request').toWire() });
      return;
    }

    void this.execute(this.createContext(runtime, raw)).then(reply);
  }

  protected onCancel(runtime: IConnectionRuntime, frame: unknown): void {
    if (!isCancelFrame(frame)) {
      return;
    }

    runtime.running.get(frame.id)?.abort(new SocketException('cancelled', `command ${frame.id} cancelled by the client`));
  }

  protected async onEvent(runtime: IConnectionRuntime, frame: unknown): Promise<void> {
    const connection = runtime.connection;

    if (!isEventFrame(frame)) {
      this.Log.debug(`Malformed socket event from connection ${connection.id}, dropped`);
      return;
    }

    try {
      await runtime.ready;
      assertPayloadSize(frame.payload, this.Options.maxPayloadBytes);
      assertRate(runtime.bucket);
      await this.Guard.ensure(connection);

      const handler = this.Registry.event(frame.name);
      if (!handler) {
        this.Log.debug(`Unknown socket event ${frame.name} from connection ${connection.id}, dropped`);
        return;
      }

      const ctx: ISocketCallContext = { kind: 'event', connection, handler, payload: frame.payload, signal: connection.signal, storage: this.callStorage(connection, frame.name) };
      await this.Als.run(ctx.storage, () => this.Gate.check(ctx));
      await this.call(ctx, handler);
    } catch (err) {
      const wire = this.Errors.toWire(err, `event ${frame.name}`);
      this.Log.warn(`Socket event ${frame.name} from connection ${connection.id} dropped: ${wire.code} ${wire.message}`);
    }
  }

  /** Lifecycle hooks run in registration order; a throwing hook is logged and never refuses the connection. */
  protected async runHooks(runtime: IConnectionRuntime, kind: 'connect' | 'disconnect', reason?: string): Promise<void> {
    const connection = runtime.connection;
    // a disconnect hook must not start with an already aborted signal
    const signal = kind === 'connect' ? connection.signal : new AbortController().signal;

    for (const handler of this.Registry.hooks(kind)) {
      const ctx: ISocketCallContext = { kind, connection, handler, payload: undefined, signal, reason, storage: this.callStorage(connection, handler.fullName) };

      try {
        await this.call(ctx, handler);
      } catch (err) {
        const wire = this.Errors.toWire(err, `${kind} hook ${handler.fullName}`);
        this.Log.warn(`Socket ${kind} hook ${handler.fullName} failed for connection ${connection.id}: ${wire.code} ${wire.message}`);
      }
    }
  }

  /** Arguments and the handler call inside the call's store ( D14 ), shared by events and hooks. */
  protected call(ctx: ISocketCallContext, handler: IRegisteredHandler): Promise<unknown> {
    return this.Als.run(ctx.storage, async () => {
      const args = await this.Arguments.resolve(ctx);
      return handler.controller[handler.descriptor.Method as string](...args);
    });
  }

  protected abortRunning(runtime: IConnectionRuntime, reason: SocketException): void {
    for (const ctx of runtime.running.values()) {
      ctx.abort(reason);
    }
  }

  protected createContext(runtime: IConnectionRuntime, request: CommandRequest): SocketCommandContext {
    const ctx = new SocketCommandContext(runtime, request, this.callStorage(runtime.connection, request.name, request.id, request.traceparent));
    ctx.armDeadline(request.deadline);
    return ctx;
  }

  /** The ambient AsyncLocalStorage store of one call; log lines and policies read it. */
  protected callStorage(connection: SocketConnection, call: string, requestId: string = randomUUID(), traceparent?: string): ISocketCallStorage {
    const trace = newTraceContext(traceparent);

    return {
      Principal: connection.principal,
      AuthnPrincipal: connection.authenticated ? connection.principal : null,
      requestId,
      traceId: trace.traceId,
      spanId: trace.spanId,
      realIp: connection.handshake.address,
      connectionId: connection.id,
      clientId: connection.clientId,
      socketCall: call,
    };
  }

  protected next(ctx: SocketCommandContext, index: number): Promise<unknown> {
    const stage = this.Stages[index];

    if (!stage) {
      return this.invoke(ctx);
    }

    return stage.execute(ctx, () => this.next(ctx, index + 1));
  }

  protected async invoke(ctx: SocketCommandContext): Promise<unknown> {
    if (ctx.signal.aborted) {
      throw ctx.signal.reason;
    }

    const handler = ctx.handler;
    const args = ctx.args;

    if (!handler || !args) {
      throw new SocketException('internal', 'command reached its handler without lookup or arguments; a built-in stage is missing');
    }

    return handler.controller[handler.descriptor.Method as string](...args);
  }

  /** W4 replaces the stream branch with real stream replies. */
  protected async toReply(ctx: SocketCommandContext, result: unknown): Promise<CommandReply> {
    if (isAsyncIterable(result)) {
      try {
        await (result as AsyncGenerator<unknown>).return?.(undefined);
      } catch {
        // a failing generator cleanup does not change the answer
      }
      throw new SocketException('unimplemented', `command ${ctx.request.name} returned a stream; stream replies are not supported by this server version`);
    }

    return { id: ctx.request.id, ok: true, result: result === undefined ? null : result };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/events.test.ts test/signals.test.ts test/pipeline.test.ts`
Expected: `28 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/dispatcher.ts packages/http-socket/test/events.test.ts && \
git commit -m "feat(http-socket): client events and connect/disconnect hooks that never take the socket down"
```

---
### Task 14: `SocketHub` rooms and push

**Files:**
- Replace: `packages/http-socket/src/hub.ts`
- Test: `packages/http-socket/test/hub.test.ts`

**Interfaces:**
- Consumes: `SocketConnection` (Task 5), `WIRE_EVENTS`, `SYSTEM_EVENTS`, `EventFrame`, `DisconnectNotice` (Task 1).
- Produces:
  - `interface ISocketEmitter { emit<P>(name: string, payload: P): void }`
  - `SocketHub.to(room | rooms): ISocketEmitter`
  - `toConnection(connectionId): ISocketEmitter`
  - `join(connectionId, room | rooms): void`
  - `leave(connectionId, room): void`
  - `connectionsIn(room): Promise<string[]>`, which returns connection ids across instances when an adapter is set
  - `disconnect(connectionId, reason): void`, which sends `sys.disconnect {reason}` and then disconnects
  - `connection(id)`, `Connections`, `attach`, `detach`, `register`, `unregister` (unchanged)
  - Throws `InvalidOperation` when used before `SocketServer` attached it.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/hub.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { SYSTEM_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, Payload, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { SocketHub } from '../src/hub.js';
import { ALICE, ITestServer, command, nextEvent, open, resultOf, startServer } from './harness.js';

@SocketController('hub')
export class HubSocket extends BaseSocketController {
  @Command('join')
  public async join(@Payload() p: { room: string }, @Connection() conn: SocketConnection) {
    conn.join(p.room);
    return [...conn.rooms];
  }

  @Command('poke')
  public async poke(@Connection() conn: SocketConnection) {
    conn.emit('hub.poked', { by: 'server' });
    return true;
  }
}

describe('SocketHub', function () {
  this.timeout(15000);

  let t: ITestServer;
  let a: ClientSocket;
  let b: ClientSocket;
  let hub: SocketHub;

  beforeEach(async () => {
    t = await startServer();
    a = await open(t, { auth: { clientId: 'hub-a', token: 'good' } });
    b = await open(t, { auth: { clientId: 'hub-b' } });
    hub = DI.resolve(SocketHub);
  });

  afterEach(async () => {
    a.close();
    b.close();
    await t.close();
  });

  it('pushes to a room only the connections that joined it', async () => {
    const rooms = resultOf(await command<string[]>(a, 'hub.join', { room: 'r1' }));
    expect(rooms).to.include('r1').and.not.include(a.id);

    const missed = nextEvent(b, 'hub.news', 300);
    const received = nextEvent(a, 'hub.news');
    hub.to('r1').emit('hub.news', { n: 1 });

    expect(await received).to.deep.equal({ n: 1 });
    await expect(missed).to.be.rejectedWith(/no hub.news event/);
  });

  it('pushes to one connection by id', async () => {
    const missed = nextEvent(a, 'hub.private', 300);
    const received = nextEvent(b, 'hub.private');
    hub.toConnection(b.id!).emit('hub.private', { to: 'b' });

    expect(await received).to.deep.equal({ to: 'b' });
    await expect(missed).to.be.rejectedWith(/no hub.private event/);
  });

  it('joins and leaves rooms by connection id and lists their members', async () => {
    hub.join(b.id!, 'r2');
    expect(await hub.connectionsIn('r2')).to.deep.equal([b.id]);
    expect([...hub.connection(b.id!)!.rooms]).to.include('r2');

    hub.leave(b.id!, 'r2');
    expect(await hub.connectionsIn('r2')).to.deep.equal([]);
  });

  it('lets a handler push to its own connection', async () => {
    const poked = nextEvent(a, 'hub.poked');
    expect(resultOf(await command(a, 'hub.poke'))).to.be.true;
    expect(await poked).to.deep.equal({ by: 'server' });
  });

  it('disconnects a connection and tells it why', async () => {
    const notice = nextEvent(a, SYSTEM_EVENTS.disconnect);
    const closed = new Promise<string>((resolve) => a.once('disconnect', (reason) => resolve(reason)));
    hub.disconnect(a.id!, 'kicked');

    expect(await notice).to.deep.equal({ reason: 'kicked' });
    expect(await closed).to.equal('io server disconnect');
  });

  it('finds local connections with their identity', () => {
    const connection = hub.connection(a.id!)!;
    expect(connection.clientId).to.equal('hub-a');
    expect(connection.user).to.deep.equal(ALICE);
    expect(hub.Connections.size).to.equal(2);
  });

  it('refuses to push before it is attached', () => {
    expect(() => new SocketHub().to('x')).to.throw(InvalidOperation, /not attached/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/hub.test.ts`
Expected: FAIL to compile, with `Property 'to' does not exist on type 'SocketHub'` (and the same error for `toConnection`, `join`, `leave`, `connectionsIn`, `disconnect`).

- [ ] **Step 3: Write the implementation**

Replace `packages/http-socket/src/hub.ts` with:

```ts
import { Server } from 'socket.io';
import { Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { DisconnectNotice, EventFrame, SYSTEM_EVENTS, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { SocketConnection } from './connection.js';

export interface ISocketEmitter {
  emit<P>(name: string, payload: P): void;
}

/**
 * Server-side push and rooms. Joining or leaving a room is a server decision; clients ask through
 * ordinary commands. Everything addressed by room or connection id also reaches connections on
 * other instances when a socket.io adapter is configured; `connection()` sees only local ones.
 */
@Injectable()
export class SocketHub {
  protected io: Server | null = null;
  protected connections = new Map<string, SocketConnection>();

  public attach(io: Server): void {
    this.io = io;
  }

  public detach(): void {
    this.io = null;
    this.connections.clear();
  }

  public register(connection: SocketConnection): void {
    this.connections.set(connection.id, connection);
  }

  public unregister(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /** A connection held by THIS instance; undefined for unknown ids or connections on other instances. */
  public connection(connectionId: string): SocketConnection | undefined {
    return this.connections.get(connectionId);
  }

  public get Connections(): ReadonlyMap<string, SocketConnection> {
    return this.connections;
  }

  public to(room: string | string[]): ISocketEmitter {
    const io = this.server();

    return {
      emit: <P>(name: string, payload: P) => {
        const frame: EventFrame<P> = { name, payload };
        io.to(room).emit(WIRE_EVENTS.event, frame);
      },
    };
  }

  /** Every socket.io connection is in a room named after its id. */
  public toConnection(connectionId: string): ISocketEmitter {
    return this.to(connectionId);
  }

  public join(connectionId: string, room: string | string[]): void {
    this.server().in(connectionId).socketsJoin(room);
  }

  public leave(connectionId: string, room: string): void {
    this.server().in(connectionId).socketsLeave(room);
  }

  public async connectionsIn(room: string): Promise<string[]> {
    const sockets = await this.server().in(room).fetchSockets();
    return sockets.map((s) => s.id);
  }

  /** Tells the client why, then closes. A server-side disconnect stops socket.io's auto-reconnect. */
  public disconnect(connectionId: string, reason: string): void {
    const io = this.server();
    const frame: EventFrame<DisconnectNotice> = { name: SYSTEM_EVENTS.disconnect, payload: { reason } };

    io.to(connectionId).emit(WIRE_EVENTS.event, frame);
    io.in(connectionId).disconnectSockets(false);
  }

  protected server(): Server {
    if (!this.io) {
      throw new InvalidOperation('SocketHub is not attached; resolve SocketServer first');
    }

    return this.io;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/hub.test.ts`
Expected: `7 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/hub.ts packages/http-socket/test/hub.test.ts && \
git commit -m "feat(http-socket): SocketHub rooms, push to rooms or connections, and server-side disconnect"
```

---

### Task 15: Observability and the stage extension point

**Files:**
- Create: `packages/http-socket/src/metrics.ts`
- Modify: `packages/http-socket/src/dispatcher.ts` (import; `execute` measures; new `observe`)
- Modify: `packages/http-socket/src/server.ts` (import; connection gauge in `onConnection`)
- Modify: `packages/http-socket/src/index.ts` (append)
- Test: `packages/http-socket/test/observability.test.ts`

**Interfaces:**
- Consumes: `Metrics` from `@spinajs/telemetry-common` (the same pattern as `packages/orm/src/metrics.ts:59-90`).
- Produces:
  - Metrics: `socket_commands_total{command,code}` (counter), `socket_command_duration_seconds{command}` (histogram) and `socket_connections` (gauge). `code` is `'ok'` or the error code. An unknown command is labelled `<unknown>`, which bounds label cardinality.
  - `socketMetrics(): MetricMap | null`, `observeCommand(command, code, seconds)`, `trackConnection(): () => void`
  - One debug line per command: `socket command <name> <code> <ms>ms connection <id>`
  - Pinned here as tests: DI-registered `SocketCommandStage`s run at their `Order` (W3's extension point), and an inbound `traceparent` reaches the handler's AsyncLocalStorage store. Both were delivered in Task 8.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/observability.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI, Injectable } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../src/interfaces.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { ITestServer, command, open, resultOf, startServer } from './harness.js';

export const obsStageSeen: Array<{ handler: string | null; args: boolean }> = [];

@Injectable(SocketCommandStage)
export class ObsTagStage extends SocketCommandStage {
  public get Order(): number {
    return STAGE_ORDER.Lookup + 50;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    obsStageSeen.push({ handler: ctx.handler?.fullName ?? null, args: ctx.args !== undefined });
    ctx.storage.obsTag = 'tagged';
    return next();
  }
}

@SocketController('obs')
export class ObsSocket extends BaseSocketController {
  @Command('echo')
  public async echo(@Payload() payload: unknown) {
    return payload;
  }

  @Command('trace')
  public async trace() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).getStore();
    return { traceId: store?.traceId ?? null, tag: store?.obsTag ?? null, requestId: store?.requestId ?? null };
  }
}

describe('socket observability', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    sinon.restore();
    socket.close();
    await t.close();
  });

  it('runs a DI-registered stage at its Order, after lookup and before arguments', async () => {
    await command(socket, 'obs.echo', 1);
    expect(obsStageSeen[obsStageSeen.length - 1]).to.deep.equal({ handler: 'obs.echo', args: false });
  });

  it('carries an inbound traceparent into the handler context', async () => {
    const reply = await command(socket, 'obs.trace', undefined, { id: 'trace-1', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
    expect(resultOf(reply)).to.deep.equal({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', tag: 'tagged', requestId: 'trace-1' });
  });

  it('starts a fresh trace without a traceparent', async () => {
    const { traceId } = resultOf(await command<{ traceId: string }>(socket, 'obs.trace'));
    expect(traceId).to.match(/^[0-9a-f]{32}$/);
  });

  it('writes one debug line per command', async () => {
    const dispatcher = await DI.resolve(SocketDispatcher);
    const debug = sinon.spy((dispatcher as unknown as { Log: { debug: (...args: unknown[]) => void } }).Log, 'debug');

    await command(socket, 'obs.echo', 1);

    const lines = debug.getCalls().map((c) => String(c.args[0]));
    expect(lines.some((line) => /^socket command obs\.echo ok \d+ms connection /.test(line))).to.be.true;
  });

  it('publishes command and connection metrics', async () => {
    await command(socket, 'obs.echo', 1);
    await command(socket, 'obs.echo', 2);
    await command(socket, 'obs.missing');

    const text = await (DI.resolve(Metrics) as Metrics).render();
    expect(text).to.contain('socket_commands_total{command="obs.echo",code="ok"} 2');
    expect(text).to.contain('socket_commands_total{command="<unknown>",code="unimplemented"} 1');
    expect(text).to.contain('socket_command_duration_seconds_count{command="obs.echo"} 2');
    expect(text).to.contain('socket_connections 1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/observability.test.ts`
Expected: 2 failing ("writes one debug line per command", "publishes command and connection metrics") and 3 passing, because the stage and trace behaviour already exists from Task 8.

- [ ] **Step 3: Write the implementation**

Create `packages/http-socket/src/metrics.ts`:

```ts
import { DI } from '@spinajs/di';
import { MetricDef, MetricMap, Metrics } from '@spinajs/telemetry-common';
import type { Counter, Gauge, Histogram } from '@spinajs/telemetry-common';

export const SOCKET_METRIC_PREFIX = 'socket';
export const SOCKET_METRIC_KEY_COMMANDS = 'commands_total';
export const SOCKET_METRIC_KEY_DURATION = 'command_duration_seconds';
export const SOCKET_METRIC_KEY_CONNECTIONS = 'connections';
export const SOCKET_DURATION_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const SOCKET_METRIC_DEFS: MetricDef[] = [
  { name: SOCKET_METRIC_KEY_COMMANDS, help: 'Socket commands answered, by command and reply code', type: 'counter', labelNames: ['command', 'code'] },
  { name: SOCKET_METRIC_KEY_DURATION, help: 'Seconds from receiving a socket command to its reply', type: 'histogram', labelNames: ['command'], buckets: SOCKET_DURATION_BUCKETS_SECONDS },
  { name: SOCKET_METRIC_KEY_CONNECTIONS, help: 'Open socket connections', type: 'gauge' },
];

// defineMetrics rebuilds ( and so resets ) its metrics on every call: build once per Metrics service.
const DEFINED = new WeakMap<Metrics, MetricMap>();

/** Null when telemetry cannot be resolved: publishing a metric must never fail a command. */
export function socketMetrics(): MetricMap | null {
  try {
    const service = DI.get(Metrics) ?? DI.resolve(Metrics);
    let map = DEFINED.get(service);

    if (!map) {
      map = service.defineMetrics(SOCKET_METRIC_PREFIX, SOCKET_METRIC_DEFS);
      DEFINED.set(service, map);
    }

    return map;
  } catch {
    return null;
  }
}

export function observeCommand(command: string, code: string, seconds: number): void {
  const metrics = socketMetrics();
  if (!metrics) {
    return;
  }

  (metrics[SOCKET_METRIC_KEY_COMMANDS] as Counter<string>).inc({ command, code });
  (metrics[SOCKET_METRIC_KEY_DURATION] as Histogram<string>).observe({ command }, seconds);
}

/** Counts one open connection; the returned release decrements the same gauge, even after a DI reset. */
export function trackConnection(): () => void {
  const gauge = socketMetrics()?.[SOCKET_METRIC_KEY_CONNECTIONS] as Gauge<string> | undefined;
  gauge?.inc();
  return () => gauge?.dec();
}
```

In `packages/http-socket/src/dispatcher.ts`, add under the other local imports:

```ts
import { observeCommand } from './metrics.js';
```

In `execute`, replace:

```ts
    const runtime = ctx.runtime;
    runtime.running.set(ctx.request.id, ctx);
```

with:

```ts
    const runtime = ctx.runtime;
    const started = performance.now();
    runtime.running.set(ctx.request.id, ctx);
```

At the end of `execute`, replace:

```ts
    }

    return reply;
  }

  protected onCommand(
```

with:

```ts
    }

    this.observe(ctx, reply, performance.now() - started);
    return reply;
  }

  protected observe(ctx: SocketCommandContext, reply: CommandReply, ms: number): void {
    const code = reply.ok ? 'ok' : reply.error.code;
    this.Log.debug(`socket command ${ctx.request.name} ${code} ${Math.round(ms)}ms connection ${ctx.connection.id}`);
    // unknown names come from the client; keeping them out of labels bounds metric cardinality
    observeCommand(ctx.handler?.fullName ?? '<unknown>', code, ms / 1000);
  }

  protected onCommand(
```

In `packages/http-socket/src/server.ts`, add under the other local imports:

```ts
import { trackConnection } from './metrics.js';
```

Replace the whole `onConnection` method with:

```ts
  protected onConnection(socket: Socket): void {
    const connection = new SocketConnection(socket, toHandshake(socket));
    const release = trackConnection();
    this.Hub.register(connection);
    this.Dispatcher.attach(connection, socket);

    socket.on('disconnect', (reason: string) => {
      release();
      connection.close(reason);
      this.Dispatcher.detach(connection, reason);
      this.Hub.unregister(connection.id);
    });
  }
```

Append to `packages/http-socket/src/index.ts`:

```ts
export * from './metrics.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/observability.test.ts`
Expected: `5 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/metrics.ts packages/http-socket/src/dispatcher.ts packages/http-socket/src/server.ts packages/http-socket/src/index.ts packages/http-socket/test/observability.test.ts && \
git commit -m "feat(http-socket): per-command debug log, telemetry metrics and connection gauge"
```

---

### Task 16: Public surface, full build, release notes

**Files:**
- Test: `packages/http-socket/test/exports.test.ts`
- Create: `packages/http-socket/RELEASE_NOTES.md` (X1 merges it into the root notes, D17)

**Interfaces:**
- Consumes: everything above.
- Produces: the final export surface of `@spinajs/http-socket`. It re-exports `@spinajs/http-socket-common`, so apps import from one package.

- [ ] **Step 1: Write the exports test**

Create `packages/http-socket/test/exports.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import * as api from '../src/index.js';

describe('@spinajs/http-socket public surface', () => {
  it('exports the server, decorators, extension points, the authz-v3 integration and the shared protocol', () => {
    const names = [
      'SocketServer',
      'SocketHub',
      'SocketConnection',
      'SocketDispatcher',
      'SocketHandlerRegistry',
      'BaseSocketController',
      'SocketController',
      'Command',
      'OnEvent',
      'OnConnect',
      'OnDisconnect',
      'Payload',
      'Connection',
      'Signal',
      'Reason',
      'FromDI',
      'SocketPolicy',
      'SocketPolicyGroup',
      'SocketParameter',
      'SocketArg',
      'SocketArgumentResolver',
      'SocketPrincipalSource',
      'AuthnCredentialSource',
      'credentialRequest',
      'AUTHENTICATION_FAILED',
      'isAllowedOrigin',
      'SocketPrincipalGuard',
      'AuthenticationStage',
      'SocketAccess',
      'SocketAccessPolicy',
      'fromPayload',
      'SocketHttpHost',
      'HttpServerHost',
      'SocketCommandStage',
      'STAGE_ORDER',
      'SocketCommandContext',
      'HandleSocketException',
      'SocketErrorMapping',
      'SocketErrorMapper',
      'AccessDeniedMapping',
      'codeMapping',
      'SocketPolicyGate',
      'policyRequest',
      'SerialQueue',
      'TokenBucket',
      'payloadSize',
      'socketMetrics',
      'SocketException',
      'PROTOCOL_VERSION',
      'WIRE_EVENTS',
      'SYSTEM_EVENTS',
      'defineContract',
    ];

    for (const name of names) {
      expect(api, name).to.have.property(name);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/exports.test.ts`
Expected: `1 passing`. If a name is missing, add the missing `export * from './<file>.js';` line to `src/index.ts`. Do not rename anything.

- [ ] **Step 3: Build the whole repo in both module systems**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json && node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.cjs.json && node scripts/generate-packages-for-modules.mjs`
Expected: exits 0. `packages/http-socket/lib/cjs/index.js` and `packages/http-socket/lib/mjs/index.d.ts` exist.

- [ ] **Step 4: Run both package suites**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && npm run test --workspace=packages/http-socket-common`
Expected: `13 passing`.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && npm run test --workspace=packages/http-socket`
Expected: `151 passing`, 0 failing.

- [ ] **Step 5: Record the breaking change**

Create `packages/http-socket/RELEASE_NOTES.md`:

```md
# Release notes — WebSocket server core (W1)

> Branch `feat/websocket-layer`, built on `feat/authz-v3`. Design: `docs/superpowers/specs/2026-10-02-spinajs-websocket-design.md`. X1 merges this file into the root `RELEASE_NOTES.md` for 3.0.

## BREAKING CHANGES

### `@spinajs/http-socket` — v3 rewrite

The v2 API is gone. No package in the repo used it.

| Removed (v2) | Use instead |
|---|---|
| `WebsocketServer` | `SocketServer`. It is `@Injectable`: resolve it after `HttpServer`, either before or after `start()`. |
| `SocketServerMiddleware.before` | `SocketPrincipalSource` (handshake → authz-v3 `Principal`, or a refusal) |
| `SocketServerMiddleware.onConnect` / `onDisconnect` | `@OnConnect()` / `@OnDisconnect()` on a socket controller |
| `SocketController` (abstract class) + `ISocketEvent` | `BaseSocketController` + `@SocketController(prefix)`, `@Command`, `@OnEvent` |
| `SocketMiddleware.execute` | a `SocketCommandStage`, `@SocketPolicy` or `@SocketAccess` |
| `SocketRouteArgs` | `SocketArg` + `@SocketParameter` |
| `ConnectionLogMiddleware` | the per-command debug line and the `socket_*` metrics |

Socket controllers live in `system.dirs.socketControllers`, never in `system.dirs.controllers`.

### Authentication and authorization (authz-v3)

- A connection without credentials runs as `UNATTENDED`: authz denies it, and scoped ORM queries fail closed. Set `http.socket.auth.required: true` to refuse such handshakes instead.
- Bearer tokens (`auth.token` or `Authorization`), keys and signatures resolve through `@spinajs/authn` (`AuthnCredentialSource`). Cookies are never a socket credential.
- Every command, event and hook runs with the principal in the AsyncLocalStorage store under `Principal`, so `AuthzService.current()` works in socket handlers.
- `@SocketAccess(permission, { resource, also, domain, allowAnonymous })` is the socket form of `@Access`. The legacy rbac policies (`LoggedPolicy`, `RbacPolicy`, `TokenPolicy`) are not supported on sockets.
- `http.socket.cors.origins` (default `[]`) admits cross-origin pages. An empty list refuses every cross-origin handshake with `forbidden`.
- Live connections re-check their principal every `http.socket.auth.revalidateMs` (60 s), and at once when `ceiling.expiresAt` passes. A failure answers `unauthenticated` and closes the connection.

### New: `@spinajs/http-socket-common`

This package holds the wire protocol (`PROTOCOL_VERSION` 1, envelopes, the 13 error codes, `SocketException`, `defineContract`). It is shared by the server and `@spinajs/http-socket-client`.
```

- [ ] **Step 6: Commit the test and the notes**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && git status --short`
Expected: the only changes from this plan are `packages/http-socket/test/exports.test.ts` and `packages/http-socket/RELEASE_NOTES.md`, plus an unstaged `package-lock.json` (D17: the integrator commits it). Leave everything else unstaged, including W2's `packages/http-socket-client/**` and any `docs/**` files the planners left.

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/test/exports.test.ts packages/http-socket/RELEASE_NOTES.md && \
git commit -m "chore(http-socket): pin the v3 public surface and its release notes"
```

---

## Spec coverage (W1 scope)

| Spec | Where |
|---|---|
| §3 `http-socket-common` (envelopes, codes, `PROTOCOL_VERSION`, contract helpers) | Task 1 |
| §4 wire protocol (handshake, `cmd` + ack, `CommandReply`, `SocketError`, `evt`, reserved stream frames) | Tasks 1, 5, 8, 13 |
| §5.1 controllers and decorators (`@SocketController`, `@Command`, `@OnEvent`, `@OnConnect`, `@OnDisconnect`, `@Payload`, `@Connection`, `@Signal`, `@Reason`, `@FromDI`; policy groups) | Tasks 6, 9 (`@SocketPolicy`, D3) |
| §5.2 steps 1–3 | Tasks 3, 10 |
| §5.2 step 4 | Task 8 |
| §5.2 step 5 | **W3**, through `SocketCommandStage` at `STAGE_ORDER.Idempotency` (Task 8 extension point, pinned in Task 15) |
| §5.2 step 6 | Tasks 9, 9A (`@SocketAccess` on authz-v3) |
| §5.2 step 7 | Tasks 6, 8; the authz `ArgInputFilter` is gated task G3 |
| (W1) principal re-check before lookup | Task 10A (D16) |
| §5.2 step 8 | Task 12 (D4) |
| §5.2 step 9 | Tasks 8, 11 (shutdown abort; drain is W3, D7) |
| §5.2 step 10 | Task 8 (streams answer `unimplemented` until W4) |
| §5.3 error mapping, prototype walk, production hiding, `errorId`; throws in events and hooks only logged | Tasks 4, 13 |
| §5.4 `SocketHub`, `SocketConnection` | Tasks 5, 14 |
| §5.5 heartbeats, recovery 2 min, adapter config | Task 5 (`ioOptions`); recovery behaviour tests are W3 |
| §5.5 observability (debug line, metrics, `traceparent`) | Tasks 8, 15 |
| §5.6 configuration | Task 2 (plus `cors.origins` and `auth`, D13, D15, D16) |
| §5.1 `@User()` | `SocketConnection.user` = `Principal.identity` (Task 5); a `@User()` argument decorator follows owner question Q1 |
| §7 Errors / Auth / Cancellation / Limits / Rooms rows | Tasks 4+8, 5+5A+9+9A, 11, 10, 14 (recovery replay row is W3) |
| authz-v3 C9 socket principal, default unattended | Tasks 5, 5A, 8 (D11–D14) |
| authz-v3 SR findings that apply to a socket | SR-03, SR-07, A02, A06 and SR-12 (cookies): Task 5A; SR-12 (origin): Task 5; the socket form of SR-06 and SR-08 (revocation on a live connection): Tasks 10A, 13 |

---

## Coordination with W2 (client)

W2 imports only from `@spinajs/http-socket-common`. Copy the full source verbatim from Task 1 Step 5. If W2 runs first, it creates the package from that source, and Task 1 then only verifies it.

**Exact export list of `@spinajs/http-socket-common`:**

| Module | Exports |
|---|---|
| `errors.ts` | `type ErrorCode`, `ERROR_CODES`, `DEFAULT_RETRYABLE`, `interface SocketError`, `isErrorCode`, `isSocketError`, `interface SocketExceptionOptions`, `class SocketException` (`code`, `retryable`, `details?`, `retryAfterMs?`, `errorId?`, `toWire()`, `static fromWire()`) |
| `protocol.ts` | `PROTOCOL_VERSION` (= 1), `MAX_ID_LENGTH` (= 128), `WIRE_EVENTS`, `type WireEventName`, `SYSTEM_EVENTS`, `type SystemEventName`, `interface Handshake`, `interface CommandRequest<P>`, `interface CommandResultReply<R>`, `interface CommandStreamReply`, `interface CommandErrorReply`, `type CommandReply<R>`, `interface EventFrame<P>`, `interface Chunk<D>`, `interface StreamEnd`, `interface StreamFail`, `interface StreamCredit`, `interface CancelFrame`, `interface ShutdownNotice`, `interface DisconnectNotice`, `isCommandRequest`, `isEventFrame`, `isCancelFrame` |
| `contract.ts` | `interface ContractShape` (`commands`, `events`, optional `clientEvents`), `interface SocketContract<C>`, `defineContract<C>()`, `type CommandName<C>`, `type CommandPayload<C,N>`, `type CommandResult<C,N>`, `type EventName<C>`, `type EventPayload<C,N>`, `type ClientEventName<C>`, `type ClientEventPayload<C,N>`, `type ContractOf<T>` |

**Behaviour the W1 server guarantees, which the client relies on:**

1. **Handshake.** Connect with `io(url, { path, auth: { protocol: PROTOCOL_VERSION, clientId, token?, ...appFields } })`. The default path is `/socket.io`. A refusal arrives as `connect_error` with `err.data: SocketError`:
   - `version_mismatch` (also sent when `protocol` is missing; `details: { server: PROTOCOL_VERSION }`). The client stops and emits `incompatible`.
   - `invalid_argument` (missing or over-long `clientId`).
   - `unauthenticated`. The client stops and emits `auth_required`. The message is always "authentication failed" for refused credentials (A02); a throttled attempt adds `retryAfterMs`. "authentication required" means the server sets `http.socket.auth.required` and the handshake carried no credentials. By default a handshake without credentials is accepted and runs as `UNATTENDED`.
   - `forbidden` "origin not allowed" (D15): the page's origin is not same-origin and not in `http.socket.cors.origins`. It is checked before anything else. Retrying cannot succeed, so W2 should treat it as fatal like `version_mismatch`. Today W2 retries every code other than `unauthenticated` and `version_mismatch`; that is W2's change to make.
   - `internal`.
   - A connection whose credentials are revoked or expired gets `unauthenticated` on its next command and then `sys.disconnect { reason: 'unauthenticated' }` (D16). The W2 reconnect asks `auth()` again, so a refreshed token reconnects, and a dead one ends in `auth_required`.
2. **Commands.** `emit('cmd', CommandRequest, ack)`. The ack carries a `CommandReply` with the same `id`.
   - A handler that returns nothing answers `result: null`, never a missing field.
   - A malformed request is answered with `id: ''`.
   - A request without an ack callback is ignored.
3. **`deadline` is relative milliseconds** (D2). Send the remaining `timeoutMs`; the server aborts at the earlier of that and its own `timeoutMs`, and answers `deadline_exceeded` (retryable). A missing, non-finite or `<= 0` deadline is ignored (`SocketCommandContext.armDeadline`), so the client never sends less than `1`.
4. **Cancel.** `emit('cancel', { id })` aborts a running command. The reply is then `cancelled` (not retryable). Cancelling a finished or unknown id does nothing.
5. **Server events** arrive as `'evt'` with an `EventFrame { name, payload }`. There are two system events:
   - `sys.disconnect { reason }`. It is sent just before a server-initiated disconnect, whose socket.io reason is `io server disconnect` (socket.io does not auto-reconnect after it). The W2 client runs its own reconnect policy and does reconnect after it, unless an app listener on `sys.disconnect` calls `client.disconnect()`. To keep a client out, refuse its next handshake.
   - `sys.shutdown { retryAfterMs }`. It is emitted by W3.
   - The client delivers system events to `client.on(name)` listeners like any other event. Its lifecycle names `state`, `auth_required`, `incompatible` and `failed` shadow server events of the same name, so name server events with a dotted prefix (as `@SocketController` prefixes do).
6. **Client events.** `emit('evt', { name, payload })` is fire-and-forget. Type it with the contract's `clientEvents`.
7. **Retries.** Trust `error.retryable` and `error.retryAfterMs`. The values the server sends are:
   - size `resource_exhausted`: `retryable: false` (D1)
   - rate `resource_exhausted`: `retryable: true` with `retryAfterMs` from the token bucket
   - in-flight `resource_exhausted`: `retryAfterMs: 100`
   - `unavailable` on disconnect or shutdown: retryable
8. **Binary.** `ArrayBuffer` / `Uint8Array` anywhere in a payload travels as a socket.io attachment and counts toward `maxPayloadBytes` by byte length.
9. **Streams.** `CommandStreamReply`, `Chunk`, `StreamEnd`, `StreamFail` and `StreamCredit` are reserved for W4. A W1 server answers stream commands with `unimplemented`.
10. **Contracts.** `defineContract<C>()` returns a data-free `SocketContract<C>` marker. The spec's "`defineContract` returns a `TypedSocketClient`" belongs to W2, which builds its typed client from this marker (for example `client.typed(contract)`). Common's `defineContract` signature must not change.
11. **Shared worktree.** W2 adds its own `{ "path": "packages/http-socket-client/tsconfig.mjs.json" }` / `.cjs.json` lines to the root build files after the `http-socket-common` lines. Stage only W2's own paths.

## Coordination with W3 (resilience)

- **Idempotency** plugs in as `@Injectable(SocketCommandStage)` with `Order = STAGE_ORDER.Idempotency` (500). It runs after `AuthenticationStage` (350), so a revoked client gets no stored replay, and inside the call's AsyncLocalStorage store, so a store keyed by principal can read `ctx.storage.Principal`. The stage can read:
  - `ctx.request.idempotencyKey`
  - `ctx.connection.clientId`
  - `ctx.handler.descriptor.Options.idempotent` (lookup at 400 has already run)

  It replays by returning a stored result without calling `next()`, and joins a running key by awaiting the same promise. To replay stored errors, throw `SocketException.fromWire(stored)`. The default config names the store `'MemoryIdempotencyStore'`, with `ttlMs` 600 000: register the default store under that DI name or change the default in `src/config/http-socket.ts`.
- **Ordering** is built (`OrderingStage`, in memory, keys `client:<clientId>` / `connection:<id>`). To replace it: `DI.unregister(OrderingStage)` and register your own stage at `STAGE_ORDER.Ordering`.
- **Graceful shutdown** should replace `SocketServer.dispose()`. Its parts:
  - stop accepting connections
  - send `io.emit(WIRE_EVENTS.event, { name: SYSTEM_EVENTS.shutdown, payload: { retryAfterMs } })`
  - wait up to `drainMs` while any `IConnectionRuntime.running` is non-empty (add a public counter on `SocketDispatcher`)
  - call `Dispatcher.abortAll(new SocketException('unavailable', …, { retryAfterMs }))`, then close

  The `http.server.closing` DI event (`packages/http/src/server.ts:354`) is a good trigger.
- **Recovery** is already configured: `connectionStateRecovery { maxDisconnectionDuration: recovery.maxDisconnectionMs, skipMiddlewares: true }`. `socket.data.auth` (principal, source, last check) and `socket.data.app` (`SocketConnection.data`) survive a recovered drop. Because a recovered socket skips the handshake middleware, its principal is re-checked by `SocketPrincipalGuard` once `checkedAt` is older than `auth.revalidateMs` (D16), against the new handshake. A recovered socket still gets a fresh `SocketConnection` and runtime. W3 owns the replay test (§7 Rooms row) and the fault kit; the harness's `TestHttpHost` is where the restart-on-same-port hook goes.

## Coordination with W4 (streams)

- **Streams.** Replace the stream branch of `SocketDispatcher.toReply` (protected) and send the reserved frames. The `cancel` handler (`onCancel`) already aborts by request id, so stream cancel can reuse it. A stream's generator runs inside the call's AsyncLocalStorage store (D14), so its `AuthzService.current()` is the connection principal. Keep that when chunks are pulled after the command's ack.
- **The W4 auth package** (`@spinajs/rbac-http-socket` in the spec) is reshaped by owner question Q1 below. Its handshake, policy and `@User()` work is now mostly in W1 (Tasks 5, 5A, 9A, 10A). What remains is the session-cookie source (gated task G6) and a `@User()` argument.

---

## Gated follow-up tasks

Each task below waits for an authz-v3 lane that has not merged on `feat/authz-v3`. W1 is complete and green without them. Run a task only when its gate holds.

`feat/websocket-layer` is a shared worktree. Before a gated task, the owner rebases it onto the current `feat/authz-v3` while no agent is working in it: `git -C C:/Users/grzch/SourceCodes/Spinajs/websocket-layer rebase feat/authz-v3`. Where a lane's final signature is not yet known, the task's first step is to rewrite the task's code steps against the merged code. This is written out as a step, not left open.

### G1: `AuthzService.current()` and `runAs` in socket handlers (gate: F3 and F4 merged)

**Files:**
- Test: `packages/http-socket/test/authz-host.test.ts`
- Modify: `packages/http-socket/src/interfaces.ts` (`ISocketCallStorage`, Step 5)
- Modify: `packages/http-socket/test/harness.ts` (`TestConfiguration.onLoad`, Step 2, only if F4 needs config to resolve)

- [ ] **Step 1: Check the gate**

Run: `git -C C:/Users/grzch/SourceCodes/Spinajs/websocket-layer log --oneline feat/authz-v3 | grep -E "Merge authz/F(3|4)"`
Expected: two lines (F3 and F4). Otherwise stop: the gate does not hold.

- [ ] **Step 2: Find what the host needs to resolve**

Read `packages/authz/src/host/**` and `packages/authz/test/host/**` (F4 task 6). Copy the `authz` configuration keys F4's own host test uses to resolve `AuthzService` into the object `TestConfiguration.onLoad` returns in `packages/http-socket/test/harness.ts` (next to `http`). If F4's host test needs no configuration, skip this step.

- [ ] **Step 3: Write the test**

Create `packages/http-socket/test/authz-host.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthzService, SYSTEM, principalKey } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnConnect, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { ITestServer, command, open, resultOf, startServer, waitFor } from './harness.js';

export const hostSeen = new Map<string, string>();

const authz = async (): Promise<AuthzService> => (await DI.resolve(AuthzService)) as AuthzService;

@SocketController('host')
export class HostSocket extends BaseSocketController {
  @Command('me')
  public async me() {
    return principalKey((await authz()).current());
  }

  @Command('system')
  public async system() {
    const service = await authz();
    const inside = await service.runAs(SYSTEM, 'socket-test', async () => principalKey(service.current()));
    return { inside, after: principalKey(service.current()) };
  }

  @OnConnect()
  public async joined(@Connection() conn: SocketConnection) {
    hostSeen.set(conn.id, principalKey((await authz()).current()));
  }
}

describe('authz-v3 host in socket handlers', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;
  let anonymous: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'host-alice', token: 'good' } });
    anonymous = await open(t, { auth: { clientId: 'host-anon' } });
  });

  afterEach(async () => {
    alice.close();
    anonymous.close();
    await t.close();
  });

  it('current() is the connection principal in a command', async () => {
    expect(resultOf(await command(alice, 'host.me'))).to.equal('user:1');
  });

  it('current() is UNATTENDED for a connection without credentials (C9 default)', async () => {
    expect(resultOf(await command(anonymous, 'host.me'))).to.equal('unattended:unattended');
  });

  it('runAs(SYSTEM) inside a handler switches the principal for its callback only', async () => {
    expect(resultOf(await command(alice, 'host.system'))).to.deep.equal({ inside: 'system:system', after: 'user:1' });
  });

  it('connect hooks see the connection principal', async () => {
    await waitFor(() => hostSeen.has(alice.id!));
    expect(hostSeen.get(alice.id!)).to.equal('user:1');
  });
});
```

- [ ] **Step 4: Run it**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/authz-host.test.ts`
Expected: `4 passing` without a source change, because W1 already writes `Principal` into the store (D14).

If `me` answers `unattended:unattended` for alice, F4 reads another store key. In that case, rename the `Principal` key in `ISocketCallStorage` (`src/interfaces.ts`) and in both `callStorage` bodies (`src/dispatcher.ts`) to F4's key, then run the full suite again.

- [ ] **Step 5: Type the store with F4's contract**

If `@spinajs/authz` exports `IAuthzAsyncStorage`, change the declaration in `packages/http-socket/src/interfaces.ts` to:

```ts
export interface ISocketCallStorage extends IAuthnPrincipalStorage, IAuthzAsyncStorage {
  Principal: Principal;
  /** written by SocketAccessPolicy, as authz-http's AccessPolicy writes req.storage.AuthzDecision */
  AuthzDecision?: Decision;
  [key: string]: unknown;
}
```

and add `IAuthzAsyncStorage` to the `import type { … } from '@spinajs/authz'` line. Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket/tsconfig.mjs.json`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/test/authz-host.test.ts packages/http-socket/test/harness.ts packages/http-socket/src/interfaces.ts && \
git commit -m "test(http-socket): AuthzService.current() and runAs inside socket handlers"
```

### G2: B09 socket part, unattended sockets fail closed on scoped models (gate: F4 and L4 merged)

authz-testing already holds the case: `B09Lanes` part `socket` (`packages/authz-testing/src/behaviour/B09-lanes.spec.ts:122-128`), "a socket handler without a principal source fails closed on a scoped model". It is tagged with lane `C9`, which no longer owns sockets.

**Files:**
- Create: `docs/plans/authz-v3-rfc/W1-1.md` (authz-v3 rule §1.4: a lane never edits `authz-testing`)
- Test: `packages/http-socket/test/behaviour.test.ts`

- [ ] **Step 1: Check the gate**

Run: `git -C C:/Users/grzch/SourceCodes/Spinajs/websocket-layer log --oneline feat/authz-v3 | grep -E "Merge authz/(F4|L4)"`
Expected: two lines. Otherwise stop.

- [ ] **Step 2: File the lane-tag RFC**

Create `docs/plans/authz-v3-rfc/W1-1.md`:

```md
# W1-1: B09 socket part moves from lane C9 to W1

- Problem: `B09Lanes` part `socket` and the `later('socket', …)` entry in `B09-unattended-system.spec.ts` name lane C9. The owner moved C9's http-socket work to W1 (2026-10-02).
- Change: tag both with `W1` instead of `C9`; no case changes.
- Affected lanes: C9 (loses the case), W1 (runs it from `packages/http-socket/test/behaviour.test.ts`).
```

- [ ] **Step 3: Rewrite Steps 4–6 against the merged harness**

Read `packages/authz-testing/src/behaviour/{harness,lane,run}.ts` and the harness L4 uses for B09's `orm` part. Replace Steps 4–6 of this task with the full code of `packages/http-socket/test/behaviour.test.ts`. The socket lane handle must:
- start the W1 server through `startServer()`
- register one `@Command(event)` per `SocketWorld.handlers` entry that runs its `OrmQuery` through L4's ORM handle
- open a connection without credentials
- make `emit(event)` send the command and turn a `forbidden` reply back into an `AccessDenied` carrying `details.reason`, as the case expects `{ throws: 'AccessDenied', reason: 'unattended' }`

Do not write any code before this step is done.

- [ ] **Step 4: Run `runBehaviour(['B09'], socketHarness)` filtered to the socket part**

Expected: the socket case passes, and the model `m1` is called 0 times.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add docs/plans/authz-v3-rfc/W1-1.md packages/http-socket/test/behaviour.test.ts && \
git commit -m "test(http-socket): B09 socket part, unattended socket handlers fail closed"
```

### G3: L5's `ArgInputFilter` in the socket argument stage (gate: L5 task 1 merged)

This is the "http-socket copy" of L5 task 1, now owned by W1. The socket payload must pass through the same filters at the same point as an http body in `RouteArgs.tryHydrateParam`.

**Files:**
- Modify: `packages/http-socket/src/args.ts` (`PayloadArg.extract`)
- Test: `packages/http-socket/test/input-filter.test.ts`

- [ ] **Step 1: Check the gate**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && git log --oneline feat/authz-v3 | grep -E "Merge authz/L5" && test -f packages/http/src/arg-input-filter.ts && grep -n "ArgInputFilter" packages/http/src/route-args/RouteArgs.ts`
Expected: the merge line, then the hook call inside `tryHydrateParam`. Otherwise stop.

- [ ] **Step 2: Rewrite Steps 3–6 against L5's signature**

Read `packages/http/src/arg-input-filter.ts` and its call site in `RouteArgs.tryHydrateParam`. Note the abstract members, how filters are resolved (expected: `Array.ofType(ArgInputFilter)`), the position relative to schema validation and hydration, and the arguments passed. Replace Steps 3–6 of this task with complete code that does the following:
- **Test.** A test-only `ArgInputFilter` drops a payload key `secret` and refuses a key `forbidden` with `InvalidArgument`. A socket command answers its hydrated payload, so the test shows `secret` stripped and `forbidden` answered `invalid_argument`.
- **Authz test**, when L5 task 7 has also merged: authz's `AuthzInputFieldFilter` strips the fields outside `decision.fields.write`, with the decision left by `@SocketAccess` in `storage.AuthzDecision`. In `reject` mode the answer is `invalid_argument`. These are the socket form of B17's input cases.
- **Implementation.** `PayloadArg.extract` calls the filters at exactly the position `tryHydrateParam` does, in the same order and with the same arguments. Where an express request is expected, it passes `policyRequest(ctx)` (Task 9), whose `storage` is the call storage (with `Principal` and `AuthzDecision`) and whose `body` / `params` / `headers` / `ip` mirror http's. The stage already runs inside the call's AsyncLocalStorage store (D14).
- the run command (`npx ts-mocha -p tsconfig.json test/input-filter.test.ts test/controller-model.test.ts test/pipeline.test.ts`) with its count, and the commit.

If L5's signature needs an express-only member that `ISocketPolicyRequest` lacks, file `docs/plans/authz-v3-rfc/W1-2.md` asking L5 for a transport-neutral parameter, and stop.

### G4: converge `@SocketAccess` with L5's `AccessPolicy`; output field filters (gate: L5 tasks 4, 5, 7 merged)

**Files:**
- Modify: `packages/http-socket/src/access.ts`
- Test: `packages/http-socket/test/access.test.ts` (extend)

- [ ] **Step 1: Check the gate**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && grep -n "class AccessPolicy\|AuthzFieldTransformer\|AuthzInputFieldFilter" -r packages/authz-http/src`
Expected: all three are implemented (not `notImplemented` stubs). Otherwise stop.

- [ ] **Step 2: Rewrite Steps 3–5 against L5's code**

Compare `SocketAccessPolicy.execute` with `AccessPolicy.execute` on these points:
- the anonymous rule and `@AllowAnonymous`
- the any-of order and which denial is reported
- the `env` passed to `check`
- `subject: 'load'`
- `domain`
- the 403 body and trace rules (B23, B41)

Replace Steps 3–5 with complete code that does the following:
- **Delegate.** If L5 exposes its decision step as a function callable with an `ISocketPolicyRequest` (requested in "Coordination with authz-v3"), `SocketAccessPolicy` delegates to it. Otherwise, mirror every difference found.
- **Options.** Add `subject?: 'load' | 'none'` and `fields?: 'filter' | 'none'` to `ISocketAccessOptions`. `fields: 'filter'` filters a command result with `decision.fields.read` through L5's `AuthzFieldTransformer`.
- **Tests.** Add tests for both options and for every B23 http case that has a socket meaning.

- [ ] **Step 3: Commit** `feat(http-socket): @SocketAccess on L5's AccessPolicy decision, with field filters`, staging `packages/http-socket/src/access.ts` and `packages/http-socket/test/access.test.ts` only.

### G5: authn end to end, trusted proxies and authn-http policies (gate: N1 and N8a merged)

**Files:**
- Modify: `packages/http-socket/src/authn-source.ts` (client address)
- Test: `packages/http-socket/test/authn-e2e.test.ts`

- [ ] **Step 1: Check the gate**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && git log --oneline feat/authz-v3 | grep -E "Merge authz/(N1|N8a)"`
Expected: two lines. Otherwise stop.

- [ ] **Step 2: Rewrite Steps 3–5 against the merged code**

Read N8a's `ClientIp` (`packages/authn-http/src/**`, the `authn.http.trustProxy` / `http.trustProxy` rule) and N1's `AuthnService`. Replace Steps 3–5 with complete code that does the following:
- **Client address.** `AuthnCredentialSource` derives `ctx.ip` with the same trusted-proxy rule as `ClientIp`: socket address unless a configured hop or CIDR is trusted. That rule must be callable without an express request (RFC `W1-3` if it is not). Add a test that a spoofed `X-Forwarded-For` from an untrusted peer is still ignored (SR-03) and a trusted one is honoured.
- **End to end.** A test runs the real `AuthnService` with authn-http's `CredentialExtractor`s and authn-token's `TokenStrategy` on SQLite. A valid API token connects; a revoked one is refused with "authentication failed"; revoking a token on an open socket ends the connection after `revalidateMs` (SR-08).
- **authn-http policies.** A test runs `@SocketPolicy(Authenticated)` and `@SocketPolicy(NoTokenAuthPolicy)` on socket commands; both read `storage.AuthnPrincipal` (D14). File an RFC if either needs more of the express request.
- the run command and the commit.

### G6: session-cookie principal source (gate: N2 and N8a merged, and the owner's answer to Q1)

- [ ] **Step 1: Check the gate**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && git log --oneline feat/authz-v3 | grep -E "Merge authz/(N2|N8a)"`
Expected: two lines, and Q1 has an answer recorded in this plan. Otherwise stop.

- [ ] **Step 2: Write the plan for the source in its package**

The placement depends on Q1. Write a plan section with complete code for a `SocketPrincipalSource` at order 100 (the slot of authn-http's session resolver). It must:
- read the session cookie under authn-http's cookie name and secret
- restore the session through `SessionIssuer.restore`
- give no principal for a pending session (SR-07)
- set `ceiling.roles` from `ActiveRole`
- build the principal through `PrincipalFactory`, so a user lookup runs where `users` wraps it in `runAs(SYSTEM, 'session-restore')`
- revalidate by restoring the session again (D16)

Tests: SR-07 (a pending session is no principal); SR-12, a cross-origin handshake carrying the session cookie is refused before the source runs (D15); a revoked session ends the socket after `revalidateMs`. Then execute it as its own task.

---

## Coordination with authz-v3

Owner decision 2026-10-02: W1 builds `@spinajs/http-socket` v3 on `feat/authz-v3` and absorbs the http-socket parts of lanes L5 and C9 (W1 deletes the v2 code those lanes would have edited).

### What W1 now owns

| authz-v3 deliverable | Source | Where in W1 |
|---|---|---|
| "+ http-socket copy" of the `ArgInputFilter` hook | L5 task 1 | Gated task G3 (`PayloadArg`) |
| "the hydration copy in `packages/http-socket/src/interfaces.ts`" (L5 *Owns*) | L5 | Obsolete: Task 2 deletes v2's `SocketRouteArgs`; G3 replaces it |
| `packages/http-socket/src/**` (C9 *Owns*) | C9 | W1, every task |
| "optional `SocketPrincipalSource` hook in http-socket, documented default = unattended" | C9 | Tasks 5 (seam, D11, D13), 5A (authn source, D12), 8 (principal in the store, D14) |
| C9 acceptance "B09 (socket … paths)" | C9 | Tasks 8, 9A (unattended denied); gated task G2 runs authz-testing's B09 socket part |
| Shared-file row `packages/http-socket/src/interfaces.ts`: "L5, then C9" | plan §1 table | W1 only |

### What stays with the authz-v3 lanes

- **L5:** everything in `packages/authz-http/**` and the http side of task 1:
  - `packages/http/src/arg-input-filter.ts`, the `RouteArgs` hook call, the export line
  - `PrincipalMiddleware`, `AuthnPrincipalSource`, `ServicePrincipalSource`, `LinkPrincipalSource`
  - `@Access`, `AccessPolicy`, the extractors
  - `AuthzInputFieldFilter`, `AuthzFieldTransformer`, `AccessController`, the explain route
- **C9:** email attachments under the sending principal, SR-09 mails, the log context `Principal`, and electron IPC `runAs(SYSTEM, 'electron-ipc')`. Only its socket item moved.

### Merged contracts W1 uses (cited from this branch)

- `packages/authn/src/contracts/principal.ts`: `Principal`, `PrincipalRef`, `Ceiling`, `UNATTENDED`, `SYSTEM`, `principalKey`, re-exported by `@spinajs/authz` (`packages/authz/src/contracts/principal.ts`).
- `packages/authn/src/contracts/hooks.ts`: `IAuthnPrincipalStorage` (`AuthnPrincipal`).
- `packages/authn/src/contracts/{service,extractor,credentials}.ts`: `AuthnService.authenticate` / `principalOf`, `CredentialExtractor`, `SignedRequest`, `AuthnContext`, `AuthenticationResult`.
- `packages/authz/src/contracts/service.ts`: `AuthzService` (`check`, `current`, `runAs`), `CheckInput`, `AuthzDomains.service`.
- `packages/authz/src/contracts/{errors,decision,permission,resource}.ts`: `AccessDenied` (non-enumerable `decision`), `Unauthenticated`, `Decision`, `DenyReason`, `parsePermission`, `resourceKey`.
- `packages/authz-http/src/api.ts`: `PrincipalSource` and `AccessOptions` shapes, mirrored by `SocketPrincipalSource` and `ISocketAccessOptions` (W1 does not depend on `authz-http`).

### Contracts W1 needs that are not merged yet

| Contract | Lane | W1 without it | Follow-up |
|---|---|---|---|
| `AuthzService` implementation, `current()` reading the ALS `Principal` key, `runAs`, `IAuthzAsyncStorage` | F4 (and F3 engine) | writes `Principal` into the store (D14); tests use a scripted `AuthzService` | G1 |
| ORM scoping of `@AccessResource` models | L4 | none needed | G2 |
| `ArgInputFilter` (name and signature) | L5 task 1 | no input filter on socket payloads | G3 |
| `AccessPolicy`, `AuthzFieldTransformer`, `AuthzInputFieldFilter` | L5 tasks 4, 5, 7 | `SocketAccessPolicy` on `AuthzService.check` | G4 |
| `AuthnService` implementation | N1 | `AuthnCredentialSource` is inert | G5 |
| `CredentialExtractor` implementations, `ClientIp` trusted proxies, `Authenticated` / `NoTokenAuthPolicy` | N8a | socket address as client IP (SR-03-safe, proxy-unaware) | G5 |
| `SessionIssuer`, session cookie name and secret | N2, N8a | no cookie authentication (cookies are never a credential, D12) | G6 |

### Requests to the authz-v3 lanes (for the integrator to apply to the authz-v3 plan)

1. **L5 *Owns* and task 1:** drop "+ http-socket copy" and "the hydration copy in `packages/http-socket/src/interfaces.ts`"; W1 G3 does it.
2. **L5 task 1 signature:** `ArgInputFilter` should need nothing from the request beyond `storage`, `body`, `params`, `query`, `headers` and `ip`, which `ISocketPolicyRequest` provides. Otherwise the socket copy cannot call it.
3. **L5 tasks 4–5:** expose `AccessPolicy`'s decision step as a function `(request with storage/body/params, AccessOptions & { permissions }) → Promise<void>`. Then `@SocketAccess` delegates to it instead of mirroring it (G4).
4. **C9:** remove `packages/http-socket/src/**` from *Owns*. Remove "optional `SocketPrincipalSource` hook in http-socket, documented default = unattended" from *Tasks* (W1 Tasks 5, 5A). Its *Depends on L5* no longer covers sockets.
5. **Shared-files table:** remove the row `packages/http-socket/src/interfaces.ts | L5, then C9`.
6. **F4 task 1:** keep the ALS key `Principal`, and keep `current()` on the DI-singleton `AsyncLocalStorage` (the instance `http/src/route-builder.ts` and `log/src/context.ts` use). W1 writes that key (D14).
7. **authz-testing:** retag B09's socket part from C9 to W1 (RFC `W1-1`, G2).
8. **N8a:** make the trusted-proxy client-address rule of `ClientIp` callable without an express request (G5), for `AuthnCredentialSource`.

### Owner questions

- **Owner answers (2026-10-02):**
  - **Q1:** drop `rbac-http-socket`. The session-cookie source goes into `@spinajs/authn-http` as a `/socket` subpath (G6).
  - **Q2:** cross-origin connections are refused unless listed (`cors.origins: []`).
  - **Q3:** W1 ships with 3.0 and merges into `feat/authz-v3`; the owner chose to build W1 on that branch.
  - **Q4:** the revalidation interval is 60 s.
- **Q1. What becomes of `@spinajs/rbac-http-socket` (spec §3, W4)?** authz-v3 has no `rbac*` packages any more. Its authentication glue is `authn-*` and its authorization glue is `authz-*` (design §4.1.1). Most of the planned package now lives in W1: handshake principal, authn token source, `@SocketAccess`, revalidation. What is left is the session-cookie source and a `@User()` argument. Options:
  - (a) **Recommended.** Drop the package. Put the session-cookie `SocketPrincipalSource` in `@spinajs/authn-http` under a subpath `@spinajs/authn-http/socket`, since authn-http owns the cookie name, secret and session restore. `authn-http` then gains an optional peer dependency on `@spinajs/http-socket`; the authz-v3 direction rule forbids only `authz*`/`users*` edges from `authn*`. `@User()` becomes unnecessary: use `SocketConnection.user` (`Principal.identity`), or add `@CurrentPrincipal()`-style args to W1.
  - (b) Rename it **`@spinajs/authn-http-socket`**: a small authn-family package holding the session source and the identity arguments, depending on `authn`, `authn-http` and `http-socket`.

  The spec is not renamed here; record the answer in the spec's §3 and §9.
- **Q2. Cross-origin default.** `http.socket.cors.origins` defaults to `[]`, so a browser page on another origin cannot open a socket until its origin is listed (D15, consistent with H33/A31 for http). Confirm, or choose to apply the guard only to cookie-carrying handshakes.
- **Q3. Release line.** W1 now depends on `@spinajs/authz`/`@spinajs/authn` `3.0.0-alpha.0`, so the socket layer ships with SpinaJS 3.0, not 2.0.549. Confirm, and confirm that `feat/websocket-layer` merges into `feat/authz-v3` (as a lane after G1) rather than into `master`.
- **Q4. Revalidation default.** `http.socket.auth.revalidateMs` is 60 s, so a revoked token keeps a socket for at most a minute. Each check is one `AuthnService.authenticate` call per active connection per minute, counted by authn's throttle. Confirm the interval.
