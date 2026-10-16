# Outbound Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new package `@spinajs/authn-webhooks` posts authn events to configured HTTPS endpoints. Each request is signed per the Standard Webhooks spec, and delivery never slows or fails a login.

**Architecture:** `WebhookAuthnEventSink` is an `AuthnEventSink`, so it gets every event (A21). It hands the event to `AuthnWebhookDispatcher`, which only enqueues one durable `AuthnWebhookDelivery` job per subscribed endpoint. A queue worker runs the job: `AuthnWebhookDeliverer` signs the queued body with the endpoint's current secrets and POSTs it through `GuardedWebhookPoster`, which blocks SSRF targets at connect time. The queue transport retries a failed attempt and dead-letters the job at the end. Receivers verify with `verifyWebhook` from the side-effect-free subpath `@spinajs/authn-webhooks/verify`.

**Tech Stack:** TypeScript (node16 ESM + CJS builds), `@spinajs/di`, `@spinajs/configuration` (`@Config` + AJV schema), `@spinajs/queue` (`QueueJob`, transports amqp/stomp/sqs), `node:http`/`node:https` with a custom `lookup`, `node:net` `BlockList`, `node:crypto` HMAC-SHA256, mocha via ts-mocha.

## Global Constraints

- Code comments, identifiers and commit messages are in English. Comment only what the code cannot say.
- Work on branch `authz-v3-refactor`, one commit per task, and run the package suite before each commit.
- Every test command runs from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- After changing a package, rebuild it (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`) before testing the packages that depend on it.
- Working-copy files use CRLF, and `core.autocrlf=true` makes the index LF. New files are written LF by most tools, so convert every file you add or change before committing. Run from the repo root: `node -e "const fs=require('fs');for(const f of process.argv.slice(1)){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))}" <files>`
- Value checks and defaults go in the module's JSON schema (`@Config` plus the AJV schema). Code keeps only DI lookups and the checks that depend on the app env or on another module's configuration (`queue.*`).
- Secrets are secret references, never inline values. A secret is never written to the queue, a log line, an error message or the job's `LastError`.
- Log lines and error messages name the endpoint, the event type and the webhook id. They never contain the URL (it may carry a token), the payload or a socket error message (it names hosts and addresses).
- Test isolation: never call `DI.clear()`. Boot in children of `DI.RootContainer` and dispose them in `afterEach`.
- When committing, stage only the paths of the task, then check with `git diff --cached --name-only` that the staged files are exactly those paths. Other agents work in this working copy.

---

## Current state

- authn sends every `AuthnEvent` to every `AuthnEventSink` through `AuthnAudit`. Sinks run **one at a time, and each is awaited** with a cap of `authn.audit.sinkTimeoutMs` (default 2000). So any time a sink spends is added to the login. A sink that throws or times out is logged by error class, and the login goes on.
- The existing sinks are `LogAuthnAuditSink` (authn), `DbAuthnAuditSink` (authn-orm) and `QueueAuthnEventSink` (users). The users sink re-emits 2.x events through the global `ev()`. Nothing sends authn events to an external HTTP endpoint.
- The only outbound HTTP client in the authn stack is `FetchOidcHttpClient` (authn-oidc). It allows https only (http in dev/test), follows no redirects and has a timeout, but it has no SSRF guard.
- `@spinajs/queue` provides durable jobs: `QueueJob` with `RetryCount` and an `onFailed(err, ctx)` hook. The transport owns retries and dead-lettering. The default connection is a `BlackHoleQueueClient`, which drops every message.

### Facts verified (2026-10-06, working copy)

- `AuthnEvent` and `AuthnEventType` are defined in `packages/authn/src/contracts/audit.ts:4-19` and `:21`. `AuthnEventSink` is an abstract class with `publish(e)` (`:28-30`). It is not an `AsyncService`. `IdentityRef` is in `credentials.ts:36-40` and `PrincipalType` in `principal.ts:9`.
- `AuthnAudit` resolves the sinks with `Array.chainOf(AuthnEventSink)` in its own container (`packages/authn/src/audit/authn-audit.ts:76-77`). It publishes to them sequentially (`:114-118`), and each delivery races a timeout and logs only the error class (`:121-140`). Successful `token.use`/`key.use` events are sampled before any sink sees them (`:24`, `:116`). `DEFAULT_AUDIT_SINK_TIMEOUT_MS = 2000` is at `packages/authn/src/audit/config.ts:15`.
- `auditLog(name)` returns `{ info, warn }`, falls back to the console and never throws (`packages/authn/src/audit/log.ts:4-37`). The main entry exports it (`packages/authn/src/index.ts:5`).
- `LogAuthnAuditSink` is `@PerChildInstance() @Injectable(AuthnEventSink)` (`packages/authn/src/audit/log-sink.ts:39-41`). `DbAuthnAuditSink` is `@Singleton() @Injectable(AuthnEventSink)` and imports only `@spinajs/authn/contracts` (`packages/authn-orm/src/audit/db-audit-sink.ts:3,35-37`).
- `QueueAuthnEventSink` exists (`packages/users/src/identity/queue-sink.ts:43-44`) and emits through the global `ev()` (`:89`, `packages/queue/src/helpers.ts:7-10`). `docs/authn/README.md:524-526` still calls it "TODO(C1): the class does not exist yet".
- The env helpers `authnAppEnv` and `isLenientAuthnEnv` are in `packages/authn/src/service/boot/env.ts:27,32`, exported from the main entry and from the `./env` subpath. `AUTHN_CONFIGURATION_SCHEMA` is in `packages/authn/src/schemas/authn.configuration.ts:84-87`. Its `authn` root has no `propertyNames`/`additionalProperties`, so `authn.webhooks` passes through it. The same file has the secret-ref shape (`:38-45`) and the pepper rotation list as an array of objects (`:109-124`).
- The schema mechanism works as follows. A dotted `$configurationModule` works (`packages/authz-queue/src/schema.ts:6-15`, untracked in the working copy, and `packages/authz-rbac/src/stores/schema.ts:52-57`). A bootstrapper calls `registerConfigurationSchema` (`packages/authn/src/service/boot/bootstrap.ts:7-12`, `packages/configuration/src/schemas.ts:11-19`). The Ajv options are `allErrors`, `removeAdditional`, `useDefaults`, `coerceTypes` and `$data`, with ajv-formats and ajv-keywords (`uniqueItemProperties`) loaded (`packages/configuration/src/configuration.ts:446-487`).
- Secret references (`aws-parameters://…`) are resolved in `load()` before the schema validates (`configuration.ts:202-204`, `:257-258`). A reference that is **a string directly inside an array** is never resolved: `iterate` walks array items as objects and `pickString` only picks object keys (`configuration.ts:321-324`, `packages/configuration/src/util-common.ts:29-35`). This is why rotated secrets are `previous: [{ secret }]` objects, as the pepper's are.
- `CONFIGURATION_CONTAINER_KEY` is at `packages/configuration/src/decorators.ts:8`. `@Config` reads through it, and an instance built with `new` must be pinned to it (`.superpowers/sdd/mechanism-notes.md:3-5`). `FrameworkConfiguration.Env` is public (`configuration.ts:85`), and `load()` sets `process.env.APP_ENV` from it (`:226-231`).
- DI calls `AsyncService.resolve()` right after construction (`packages/di/src/container.ts:637-648`) and awaits promised constructor dependencies (`:715-742`). An `AsyncService` injected into a sink therefore runs its boot checks when `AuthnAudit` resolves the sink. `hasRegistered` looks through parents by default (`:240-242`).
- `QueueService.getConnectionsForMessage` is `protected` and reads `queue.routing[Name] ?? queue.default` (`packages/queue/src/interfaces.ts:57-92`). `QueueJob` has `RetryCount` and `onFailed(err, ctx)`, and its static `emit` sets `Persistent: true` (`:220-262`). `IJobFailureContext` is at `:209-218`. `retryDelay` is a per-connection base delay (`:564-568`).
- `DefaultQueueService` is registered at the root by importing `@spinajs/queue` (`packages/queue/src/index.ts:31`). It assigns `JobId` on emit (`:79-82`), records `MaxAttempts = RetryCount + 1` (`:165`), skips jobs that are already terminal (`:187-190`), and on failure marks the job `retrying`/`dead`, calls `onFailed` and rethrows so that the transport retries (`:220-241`).
- The queue package's default configuration routes everything to `black-hole`, a `BlackHoleQueueClient` (`packages/queue/src/config/queue.ts:6-12`, `packages/queue/src/BlackHoleQueueClient.ts:8-13`).
- **Transport retry:**
  - AMQP: a job is retried `RetryCount` times with `retryDelay × 2^(n−1)` and no jitter, then dead-lettered (`packages/queue-amqp-transport/src/connection.ts:377-399`, `:451-457`). `ScheduleDelay` is not supported (`:626-630`). A publish waits for a receipt for up to `receiptTimeout ?? 5000` ms, with retries (`:466`).
  - STOMP: the same backoff through `AMQ_SCHEDULED_DELAY` (`packages/queue-stomp-transport/src/connection.ts:472-496`, `:563-569`).
  - SQS: `RetryCount` is ignored. Redelivery is driven by the redrive policy (`maxReceiveCount`) and the visibility timeout (`packages/queue-sqs-transport/src/connection.ts:253-256`).
  - `queue-orm-transport` is entirely commented out (`packages/queue-orm-transport/src/index.ts:1-67`), so no DB-only durable queue exists.
- An `@Job()` without `runAs` runs unattended under authz-queue (`packages/authz-queue/src/hook/hook.ts:48-58`).
- Queue test patterns: a capturing `QueueClient` fake (`packages/queue/test/emit.test.ts:18-35`) and a sinon stub of `DefaultQueueService.prototype.emit` (`packages/users/test/authn-sinks.test.ts:36`).
- Telemetry: a counter API exists in `@spinajs/telemetry-common` (`Metrics.defineMetrics`, `packages/telemetry-common/src/metrics.ts:51-78`, built on prom-client), not in `@spinajs/telemetry` itself.
- Scaffolding to copy is in `packages/authn-keys` (package.json, three tsconfigs, `.mocharc.json`, `src/config/authn-keys.ts:1-24` for the CLI dir). The CLI test pattern is at `packages/authn-keys/test/cli.test.ts:15-21`. The root build lists the package at `tsconfig.build.json:88` and `tsconfig.build.cjs.json:88`. The subpath `exports` + `typesVersions` pattern is at `packages/authn/package.json:7-32`. A child-configuration test helper is at `packages/telemetry/test/support/child-config.ts:9-29`, and the schema-bootstrapper test pattern at `packages/authz-queue/test/config.test.ts:42-53`.
- Node 24.14 is installed:
  - `BlockList` checks `::ffff:a.b.c.d` against IPv4 rules but not NAT64 (`64:ff9b::/96`).
  - `http.request` calls `lookup` with `{ all: true }` and never calls it for an IP literal.
  - An aborted `signal` rejects with `AbortError` (code `ABORT_ERR`, cause `TimeoutError`).
  - The Standard Webhooks test vector (secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`, id `msg_p5jXN8AQM9LWM0D4loKWxJek`, timestamp `1614265330`, body `{"test": 2432232314}`) gives `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`. All of this was checked by running it.

### Facts that contradict the brief

1. **"Exponential backoff + jitter, 8 attempts over ~24 h"**: the transport owns the backoff. It is per connection, exponential and without jitter. SQS ignores `RetryCount`, and AMQP cannot delay a message itself. So the plan sets `RetryCount = maxAttempts − 1` and documents a dedicated connection with `retryDelay: 680000`. That gives 8 attempts: delays of 11 min, 23 min, 45 min, 1.5 h, 3 h, 6 h and 12 h, about 23.9 h in total. Jitter would need a change to the shared transports (see Decision 2).
2. **"If no queue is configured"**: one is always configured. The default is a black hole that silently drops jobs, so the boot check looks at the route of `AuthnWebhookDelivery`, not at whether a queue exists. No DB-backed transport works (orm transport commented out), so durable delivery needs an AMQP, STOMP or SQS broker.
3. **Metrics**: there is no counter in `@spinajs/telemetry`. The one in `@spinajs/telemetry-common` pulls in prom-client, so metrics are deferred (Decision 9).
4. **Time budget**: an AMQP publish can wait up to 5 s for a receipt, but `AuthnAudit` caps a sink at 2 s. A slow broker makes the audit log a sink timeout. The job is still enqueued once the publish completes, and the login is never failed.

## Decisions (confirm before Task 1)

1. **Without a durable queue, refuse to boot.** When endpoints are configured and `AuthnWebhookDelivery` routes to a `BlackHoleQueueClient` or to an unknown connection, boot fails with `InvalidOption` in every env. This is rejected: an in-process best-effort buffer. It loses events on every restart or crash without anyone seeing it, it competes with logins for CPU, and its bound turns a slow endpoint into silent drops. An operator who configures webhooks expects delivery or a clear refusal. To try webhooks without a broker, use `authn:webhook-test`, which sends directly.
2. **Retries belong to the transport.** The job sets `RetryCount = authn.webhooks.maxAttempts − 1` (default 8 attempts). The schedule comes from the connection's `retryDelay`, and the README recommends a dedicated connection. There is no jitter: retries of one event are already spread by the times of the events, and adding jitter to `retryBackoff` of the AMQP/STOMP transports would change every job. That is a separate change if wanted. A per-endpoint circuit breaker is YAGNI: dead endpoints cost one bounded request (5 s) per attempt in a worker, never in a login.
3. **One job per (event, endpoint).** The webhook id (`msg_<uuid>`) is shared by all endpoints of one event and is the same on every retry, so receivers dedupe on it. The `webhook-timestamp` header is the attempt time, and the payload `timestamp` is the event time.
4. **The body is built at enqueue, and the URL and secrets are read at send.** The privacy switches apply when the event happens. The queue never holds a secret, and a rotation takes effect for jobs already queued. An endpoint removed from the config before delivery drops its jobs with a warning (job result `dropped`, no retry).
5. **Any answer outside 2xx is a failed attempt**, 3xx and 4xx included. Redirects are not followed and the response body is never read. There are no "permanent failure" classes such as 410 Gone (YAGNI).
6. **`includeData`, `includeClientInfo` and `allowPrivateNetworks` are set per endpoint, and all default to `false`.** Opening one internal endpoint must not open all of them.
7. **The SSRF guard runs at connect time.** `http.request` gets a `lookup` that refuses the host when any resolved address is blocked. This leaves no DNS-rebinding window between a check and the connect. IP literals are checked before the request, because Node never calls `lookup` for them, and also at boot.
8. **The verifier lives in a subpath.** `@spinajs/authn-webhooks/verify` exports the signing and verification functions and registers no DI service. Importing the main entry registers the sink.
9. **No new A-row, and no metrics.** This is a sink under A21: every sink gets every event, and a sink never fails a login, which `AuthnAudit` already enforces. The package's own tests cover delivery. A `authn_webhook_deliveries_total{endpoint,outcome}` counter through `@spinajs/telemetry-common` can follow later.
10. **Event filters are bare `AuthnEventType` names or `'*'`**, checked by a pattern and not an enum. Plans 04 to 09 and 11 add event types, and an enum would need a change each time. The webhook `type` is `authn.<AuthnEventType>`, and `authn.ping` for the CLI test.

## Security notes

- **SSRF.** The guard blocks loopback, RFC 1918, CGNAT, link-local (including `169.254.169.254` and `fd00:ec2::254`), ULA `fc00::/7`, multicast, reserved and documentation ranges, 6to4/Teredo, and IPv4 embedded in mapped (`::ffff:`) or NAT64 (`64:ff9b::`) addresses. A host that resolves to any blocked address is refused. https is required outside dev/test, credentials in the URL are refused by the schema, and redirects are not followed.
- **Secrets.** Endpoint secrets are `whsec_` secret references of at least 24 bytes. They are read in the worker at send time and appear nowhere else. During a rotation every secret signs, so a receiver holding either one verifies.
- **Privacy.** The IP and the user agent go out only with `includeClientInfo`, and `data` only with `includeData`. `reason` (the real failure reason, A02) does go to endpoints. They are operator-configured backends, like the audit store.
- **Receivers** must verify against the raw body, dedupe on `webhook-id`, and reject timestamps more than 5 minutes away. `verifyWebhook` compares signatures in constant time and enforces the tolerance.
- **Availability.** A login waits only for the enqueue, bounded by `authn.audit.sinkTimeoutMs`. HTTP happens in queue workers with a 5 s cap per attempt.

## File structure

```
packages/authn-webhooks/
  package.json, tsconfig.json, tsconfig.mjs.json, tsconfig.cjs.json   scaffold (Task 1)
  .mocharc.json .gitignore .npmignore .eslintignore .eslintrc.cjs .prettierrc typedoc.json   copied from authn-keys (Task 1)
  README.md                         usage, queue setup, receiver side (Task 6)
  src/index.ts                      main entry; importing it registers the sink and the bootstrapper
  src/schema.ts                     AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA, config types, bootstrapper (Task 1)
  src/signature/sign.ts             whsec_ decoding, HMAC, the three headers (Task 2)
  src/signature/verify.ts           verifyWebhook for receivers (Task 2)
  src/signature/index.ts            the ./verify subpath (Task 2)
  src/http/address.ts               blocked ranges, guarded lookup, WebhookTargetRefused (Task 3)
  src/http/poster.ts                GuardedWebhookPoster: one POST, no redirects, timeout (Task 3)
  src/payload.ts                    event -> payload/body, subscription filter, ids (Task 4)
  src/delivery/deliverer.ts         worker side: sign + post + failure logging, ping (Task 4)
  src/delivery/job.ts               AuthnWebhookDelivery job and its builder (Task 4)
  src/dispatch/dispatcher.ts        enqueue side: boot checks + one job per endpoint (Task 5)
  src/dispatch/sink.ts              WebhookAuthnEventSink (Task 5)
  src/cli/WebhookTest.ts, src/cli/index.ts   authn:webhook-test (Task 6)
  src/config/authn-webhooks.ts      CLI scan dir (Task 6)
  test/support/config.ts            child Configuration, pin, violation paths, fixtures (Task 1)
  test/support/server.ts            local recording http server (Task 3)
  test/support/queue.ts             FakeQueueService, DurableTestClient (Task 5)
  test/*.test.ts                    one file per unit
tsconfig.build.json, tsconfig.build.cjs.json   one reference each (Task 1)
package-lock.json                              workspace link (Task 1)
docs/authn/README.md                           one bullet, one table row (Task 6)
```

Task order: 1, then 2 and 3 (independent of each other), then 4, then 5 and 6.

---

### Task 1: Package skeleton and the `authn.webhooks` schema

**Files:**
- Create: `packages/authn-webhooks/package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `src/index.ts`, `src/schema.ts`, `test/support/config.ts`, `test/schema.test.ts`
- Copy from `packages/authn-keys/`: `.mocharc.json`, `.gitignore`, `.npmignore`, `.eslintignore`, `.eslintrc.cjs`, `.prettierrc`, `typedoc.json`
- Modify: `tsconfig.build.json:88` and `tsconfig.build.cjs.json:88` (one line after the `authn-keys` reference), `package-lock.json` (by `npm install`)

**Interfaces:**
- Consumes: `registerConfigurationSchema` (`@spinajs/configuration`), `Bootstrapper`/`Injectable` (`@spinajs/di`).
- Produces:
  - `AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA` (`$configurationModule: 'authn.webhooks'`), `AuthnWebhooksConfigBootstrapper`.
  - Types `WebhookSecretConfig { secret: string; previous?: readonly { secret: string }[] }`, `WebhookEndpointConfig { name; url; secret: WebhookSecretConfig; events: readonly string[]; includeData: boolean; includeClientInfo: boolean; allowPrivateNetworks: boolean }`, `WebhooksConfig { endpoints: readonly WebhookEndpointConfig[]; maxAttempts: number; timeoutMs: number }`.
  - Test support: `SECRET`, `OTHER_SECRET`, `bootChild(values, { env?, schemas? }): Promise<IContainer>`, `disposeChildren()`, `pin(instance, container)`, `violationPaths(boot)`, `endpoint(over?)`.

- [ ] **Step 1: Scaffold the package**

Copy the dotfiles:

```bash
mkdir -p packages/authn-webhooks/src packages/authn-webhooks/test/support
cp packages/authn-keys/.mocharc.json packages/authn-keys/.gitignore packages/authn-keys/.npmignore packages/authn-keys/.eslintignore packages/authn-keys/.eslintrc.cjs packages/authn-keys/.prettierrc packages/authn-keys/typedoc.json packages/authn-webhooks/
```

`packages/authn-webhooks/package.json`:

```json
{
  "name": "@spinajs/authn-webhooks",
  "version": "3.0.0-alpha.0",
  "description": "Signed outbound webhooks (Standard Webhooks) on SpinaJS authn events",
  "main": "lib/cjs/index.js",
  "module": "lib/mjs/index.js",
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    },
    "./verify": {
      "types": "./lib/mjs/signature/index.d.ts",
      "import": "./lib/mjs/signature/index.js",
      "require": "./lib/cjs/signature/index.js"
    }
  },
  "typesVersions": {
    "*": {
      "verify": [
        "lib/cjs/signature/index.d.ts"
      ]
    }
  },
  "type": "module",
  "private": false,
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "rimraf": "./node_modules/rimraf/bin.js",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "pretest": "npm run compile",
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
    "authn",
    "webhooks"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {
    "@spinajs/authn": "3.0.0-alpha.0",
    "@spinajs/cli": "2.0.549",
    "@spinajs/configuration": "2.0.549",
    "@spinajs/di": "2.0.549",
    "@spinajs/exceptions": "2.0.549",
    "@spinajs/log": "2.0.549",
    "@spinajs/queue": "2.0.549"
  }
}
```

`engines` is `>=18` because the code uses `AbortSignal.timeout` and the tests use `server.closeAllConnections()`.

`packages/authn-webhooks/tsconfig.json`:

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
  "references": [{ "path": "../authn/tsconfig.json" }, { "path": "../cli/tsconfig.json" }, { "path": "../configuration/tsconfig.json" }, { "path": "../di/tsconfig.json" }, { "path": "../exceptions/tsconfig.json" }, { "path": "../log/tsconfig.json" }, { "path": "../queue/tsconfig.json" }]
}
```

`packages/authn-webhooks/tsconfig.mjs.json`:

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
  "references": [{ "path": "../authn/tsconfig.mjs.json" }, { "path": "../cli/tsconfig.mjs.json" }, { "path": "../configuration/tsconfig.mjs.json" }, { "path": "../di/tsconfig.mjs.json" }, { "path": "../exceptions/tsconfig.mjs.json" }, { "path": "../log/tsconfig.mjs.json" }, { "path": "../queue/tsconfig.mjs.json" }]
}
```

`packages/authn-webhooks/tsconfig.cjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../authn/tsconfig.cjs.json" }, { "path": "../cli/tsconfig.cjs.json" }, { "path": "../configuration/tsconfig.cjs.json" }, { "path": "../di/tsconfig.cjs.json" }, { "path": "../exceptions/tsconfig.cjs.json" }, { "path": "../log/tsconfig.cjs.json" }, { "path": "../queue/tsconfig.cjs.json" }]
}
```

In `tsconfig.build.json`, after line 88 (`{ "path": "packages/authn-keys/tsconfig.mjs.json" },`), add:

```json
    { "path": "packages/authn-webhooks/tsconfig.mjs.json" },
```

In `tsconfig.build.cjs.json`, after line 88 (`{ "path": "./packages/authn-keys/tsconfig.cjs.json" },`), add:

```json
    { "path": "./packages/authn-webhooks/tsconfig.cjs.json" },
```

Then, from the repo root: `npm install --no-audit --no-fund`
Expected: it ends without errors. `ls -la node_modules/@spinajs/authn-webhooks` shows a link to `packages/authn-webhooks`, and `package-lock.json` gains a `packages/authn-webhooks` entry.

- [ ] **Step 2: Write the test support and the failing tests**

`packages/authn-webhooks/test/support/config.ts`:

```ts
import { CONFIGURATION_CONTAINER_KEY, Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import type { IConfigurationSchema } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

import { AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA } from '../../src/schema.js';

/** The secret of the Standard Webhooks reference test vector (24 bytes). */
export const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
export const OTHER_SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

function configurationOf(values: Record<string, unknown>, env: string): Class<Configuration> {
  const json = JSON.stringify(values);
  return class WebhooksTestConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = env;
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

const booted: IContainer[] = [];

export interface BootOptions {
  /** The app env; default `test`. */
  readonly env?: string;
  /** Default: the authn.webhooks schema only. */
  readonly schemas?: readonly IConfigurationSchema[];
}

/** A child of the root with its own resolved Configuration over `values` alone; `disposeChildren` drops it. */
export async function bootChild(values: Record<string, unknown>, opts: BootOptions = {}): Promise<IContainer> {
  const child = DI.RootContainer.child();
  for (const schema of opts.schemas ?? [AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA]) child.register(schema).asValue('__configurationSchema__');
  child.register(configurationOf(values, opts.env ?? 'test')).as(Configuration);
  try {
    await child.resolve(Configuration);
  } catch (e) {
    await child.dispose();
    throw e;
  }
  booted.push(child);
  return child;
}

export async function disposeChildren(): Promise<void> {
  for (const c of booted.splice(0).reverse()) await c.dispose();
}

/** Points the @Config properties of an instance built with `new` at `container`. */
export function pin<T extends object>(instance: T, container: IContainer): T {
  (instance as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = container;
  return instance;
}

export async function violationPaths(boot: Promise<unknown>): Promise<string[]> {
  try {
    await boot;
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  }
  throw new Error('expected InvalidConfiguration, the boot succeeded');
}

export const endpoint = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'crm',
  url: 'https://hooks.example.com/authn',
  secret: { secret: SECRET },
  events: ['*'],
  ...over,
});
```

`packages/authn-webhooks/test/schema.test.ts`:

```ts
import 'mocha';
import assert from 'node:assert/strict';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

import { AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA, AuthnWebhooksConfigBootstrapper } from '../src/schema.js';
import { OTHER_SECRET, SECRET, bootChild, disposeChildren, endpoint, violationPaths } from './support/config.js';

const webhooksOf = async (values: Record<string, unknown>): Promise<unknown> => (await bootChild({ authn: { webhooks: values } })).get(Configuration)!.get('authn.webhooks');

const refuses = async (webhooks: Record<string, unknown>, path: string): Promise<void> => {
  const paths = await violationPaths(bootChild({ authn: { webhooks } }));
  assert.ok(paths.includes(path), `${path}: ${paths.join(', ')}`);
};

describe('authn.webhooks schema', () => {
  afterEach(disposeChildren);

  it('fills the defaults when authn.webhooks is unset', async () => {
    const child = await bootChild({});
    assert.deepStrictEqual(child.get(Configuration)!.get('authn.webhooks'), { endpoints: [], maxAttempts: 8, timeoutMs: 5000 });
  });

  it('fills the endpoint switches with false and keeps a rotation list', async () => {
    const ep = endpoint({ secret: { secret: SECRET, previous: [{ secret: OTHER_SECRET }] }, events: ['login', 'password.reset.request'] });
    assert.deepStrictEqual(await webhooksOf({ endpoints: [ep] }), {
      endpoints: [
        {
          name: 'crm',
          url: 'https://hooks.example.com/authn',
          secret: { secret: SECRET, previous: [{ secret: OTHER_SECRET }] },
          events: ['login', 'password.reset.request'],
          includeData: false,
          includeClientInfo: false,
          allowPrivateNetworks: false,
        },
      ],
      maxAttempts: 8,
      timeoutMs: 5000,
    });
  });

  it('refuses bad endpoint values, naming each path', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [endpoint({ name: 'Bad Name' }), 'authn.webhooks.endpoints.0.name'],
      [endpoint({ url: 'ftp://hooks.example.com/' }), 'authn.webhooks.endpoints.0.url'],
      [endpoint({ url: 'https://user:pw@hooks.example.com/' }), 'authn.webhooks.endpoints.0.url'],
      [endpoint({ secret: { secret: 'plain-text-secret' } }), 'authn.webhooks.endpoints.0.secret.secret'],
      [endpoint({ secret: { secret: 'whsec_c2hvcnQ=' } }), 'authn.webhooks.endpoints.0.secret.secret'],
      [endpoint({ secret: { secret: SECRET, previous: [{ secret: 'nope' }] } }), 'authn.webhooks.endpoints.0.secret.previous.0.secret'],
      [endpoint({ secret: undefined }), 'authn.webhooks.endpoints.0.secret'],
      [endpoint({ events: [] }), 'authn.webhooks.endpoints.0.events'],
      [endpoint({ events: ['Login!'] }), 'authn.webhooks.endpoints.0.events.0'],
      [endpoint({ retries: 3 }), 'authn.webhooks.endpoints.0.retries'],
    ];
    for (const [ep, path] of cases) await refuses({ endpoints: [ep] }, path);
  });

  it('refuses duplicate names, unknown keys and limits out of range', async () => {
    const dup = await violationPaths(bootChild({ authn: { webhooks: { endpoints: [endpoint(), endpoint()] } } }));
    assert.ok(
      dup.some((p) => p.startsWith('authn.webhooks.endpoints')),
      dup.join(', '),
    );
    await refuses({ retries: 3 }, 'authn.webhooks.retries');
    for (const [key, bad] of [
      ['maxAttempts', 0],
      ['maxAttempts', 21],
      ['timeoutMs', 99],
      ['timeoutMs', 30001],
    ] as const) {
      await refuses({ [key]: bad }, `authn.webhooks.${key}`);
    }
  });

  it('the bootstrapper registers the schema', () => {
    const KEY = '__configurationSchema__';
    const had = DI.RootContainer.Cache.has(KEY);
    new AuthnWebhooksConfigBootstrapper().bootstrap();
    try {
      assert.ok((DI.RootContainer.Cache.get(KEY) as unknown[]).includes(AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA));
    } finally {
      const list = DI.RootContainer.Cache.get(KEY) as unknown[];
      list.splice(list.indexOf(AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA), 1);
      if (!had && list.length === 0) DI.uncache(KEY);
    }
  });
});
```

`packages/authn-webhooks/src/index.ts` (temporary; Step 4 fills it):

```ts
export {};
```

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/schema.test.ts`
Expected: FAIL. The test file does not load: `Cannot find module '../src/schema.js'` (or `ERR_MODULE_NOT_FOUND` for `src/schema.js`).

- [ ] **Step 4: Implement**

`packages/authn-webhooks/src/schema.ts`:

```ts
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

export interface WebhookSecretConfig {
  readonly secret: string;
  /** Older secrets that still sign during a rotation. Objects, not strings: a reference inside a string array is never resolved. */
  readonly previous?: readonly { readonly secret: string }[];
}

export interface WebhookEndpointConfig {
  readonly name: string;
  readonly url: string;
  readonly secret: WebhookSecretConfig;
  /** Bare AuthnEventType names, or '*'. */
  readonly events: readonly string[];
  readonly includeData: boolean;
  readonly includeClientInfo: boolean;
  readonly allowPrivateNetworks: boolean;
}

export interface WebhooksConfig {
  readonly endpoints: readonly WebhookEndpointConfig[];
  readonly maxAttempts: number;
  readonly timeoutMs: number;
}

// `whsec_` and the base64 of at least 24 bytes, as Standard Webhooks asks.
const WEBHOOK_SECRET_PATTERN = '^whsec_(?:[A-Za-z0-9+/]{4}){8,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';

const webhookSecret = { type: 'string', maxLength: 200, pattern: WEBHOOK_SECRET_PATTERN };

export const AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-webhooks.configuration.schema.json',
  $configurationModule: 'authn.webhooks',
  description: 'Outbound webhooks on authn events (authn.webhooks.*)',
  type: 'object',
  propertyNames: { enum: ['endpoints', 'maxAttempts', 'timeoutMs'] },
  properties: {
    endpoints: {
      type: 'array',
      default: [],
      uniqueItemProperties: ['name'],
      items: {
        type: 'object',
        propertyNames: { enum: ['name', 'url', 'secret', 'events', 'includeData', 'includeClientInfo', 'allowPrivateNetworks'] },
        required: ['name', 'url', 'secret', 'events'],
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9_-]{1,64}$' },
          url: { type: 'string', maxLength: 2048, pattern: '^https?://[^\\s/?#@]+(?:[/?#]\\S*)?$', description: 'No credentials in the URL; https outside development and test (checked at boot).' },
          secret: {
            type: 'object',
            description: 'A reference the configuration resolves (e.g. aws-parameters://) to a whsec_ value, never an inline value.',
            propertyNames: { enum: ['secret', 'previous'] },
            required: ['secret'],
            properties: {
              secret: webhookSecret,
              previous: {
                type: 'array',
                maxItems: 3,
                items: { type: 'object', propertyNames: { enum: ['secret'] }, required: ['secret'], properties: { secret: webhookSecret } },
              },
            },
          },
          events: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^(?:\\*|[a-z]+(?:\\.[a-z]+)*)$' } },
          includeData: { type: 'boolean', default: false },
          includeClientInfo: { type: 'boolean', default: false, description: 'Adds the IP and the user agent.' },
          allowPrivateNetworks: { type: 'boolean', default: false },
        },
      },
    },
    maxAttempts: { type: 'integer', minimum: 1, maximum: 20, default: 8, description: 'Attempts per delivery; the queue connection retryDelay sets the backoff.' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 30000, default: 5000, description: 'One attempt, connect to status line.' },
  },
};

/** Registers the authn.webhooks schema, so the configuration validates it and fills its defaults. */
@Injectable(Bootstrapper)
export class AuthnWebhooksConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA);
  }
}
```

`packages/authn-webhooks/src/index.ts`:

```ts
export * from './schema.js';
```

- [ ] **Step 5: GREEN + build**

1. `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/schema.test.ts`. Expected: 5 passing.
2. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: no output and exit code 0. `lib/mjs/schema.js` and `lib/cjs/schema.js` exist.
3. If the duplicate-name case reports an unexpected path, print `dup` and keep the `startsWith` check. Do not loosen the other cases.

- [ ] **Step 6: Commit**

```bash
node -e "const fs=require('fs');for(const f of process.argv.slice(1)){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))}" packages/authn-webhooks/package.json packages/authn-webhooks/tsconfig.json packages/authn-webhooks/tsconfig.mjs.json packages/authn-webhooks/tsconfig.cjs.json packages/authn-webhooks/src/index.ts packages/authn-webhooks/src/schema.ts packages/authn-webhooks/test/support/config.ts packages/authn-webhooks/test/schema.test.ts tsconfig.build.json tsconfig.build.cjs.json
git add packages/authn-webhooks/package.json packages/authn-webhooks/tsconfig.json packages/authn-webhooks/tsconfig.mjs.json packages/authn-webhooks/tsconfig.cjs.json packages/authn-webhooks/.mocharc.json packages/authn-webhooks/.gitignore packages/authn-webhooks/.npmignore packages/authn-webhooks/.eslintignore packages/authn-webhooks/.eslintrc.cjs packages/authn-webhooks/.prettierrc packages/authn-webhooks/typedoc.json packages/authn-webhooks/src/index.ts packages/authn-webhooks/src/schema.ts packages/authn-webhooks/test/support/config.ts packages/authn-webhooks/test/schema.test.ts tsconfig.build.json tsconfig.build.cjs.json package-lock.json
git diff --cached --name-only
git commit -m "feat(authn-webhooks): package skeleton and the authn.webhooks schema"
```

Expected from `git diff --cached --name-only`: exactly the 18 paths above. `git add` stages only your hunk of `tsconfig.build*.json`, so if another agent changed those files, stage with `git add -p` instead.

---

### Task 2: Standard Webhooks signing and the receiver verifier

**Files:**
- Create: `packages/authn-webhooks/src/signature/sign.ts`, `src/signature/verify.ts`, `src/signature/index.ts`, `test/signature.test.ts`
- Modify: `packages/authn-webhooks/src/index.ts`

**Interfaces:**
- Consumes: `SECRET`, `OTHER_SECRET` from `test/support/config.ts` (Task 1).
- Produces (also the `@spinajs/authn-webhooks/verify` subpath):
  - `WEBHOOK_SECRET_PREFIX = 'whsec_'`, `decodeWebhookSecret(secret: string): Buffer`
  - `signatureOf(key: Buffer, id: string, timestamp: number, body: string | Uint8Array): Buffer`
  - `type WebhookHeaders = { 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string }`, `signedHeaders(keys: readonly Buffer[], id: string, at: Date, body: string): WebhookHeaders`
  - `WEBHOOK_TOLERANCE_SECONDS = 300`, `type WebhookVerificationFailure = 'headers' | 'timestamp' | 'signature'`, `class WebhookVerificationError extends Error { reason }`
  - `type WebhookHeaderSource`, `interface VerifiedWebhook { id: string; timestamp: Date }`
  - `verifyWebhook(body: string | Uint8Array, headers: WebhookHeaderSource, secrets: string | readonly string[], opts?: { now?: Date; toleranceSeconds?: number }): VerifiedWebhook`

- [ ] **Step 1: Write the failing tests**

`packages/authn-webhooks/test/signature.test.ts`:

```ts
import 'mocha';
import assert from 'node:assert/strict';

import { WebhookVerificationError, decodeWebhookSecret, signedHeaders, verifyWebhook } from '../src/signature/index.js';
import { OTHER_SECRET, SECRET } from './support/config.js';

// The reference vector of the Standard Webhooks libraries.
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const AT = new Date(1614265330 * 1000);
const BODY = '{"test": 2432232314}';

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof WebhookVerificationError) return e.reason;
    throw e;
  }
  return 'verified';
};

describe('Standard Webhooks signatures', () => {
  it('matches the reference signature', () => {
    assert.deepStrictEqual(signedHeaders([decodeWebhookSecret(SECRET)], ID, AT, BODY), {
      'webhook-id': ID,
      'webhook-timestamp': '1614265330',
      'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    });
  });

  it('signs with every key during a rotation, and a receiver holding either verifies', () => {
    const headers = signedHeaders([decodeWebhookSecret(OTHER_SECRET), decodeWebhookSecret(SECRET)], ID, AT, BODY);
    assert.strictEqual(headers['webhook-signature'].split(' ').length, 2);
    for (const secret of [SECRET, OTHER_SECRET]) {
      assert.deepStrictEqual(verifyWebhook(BODY, headers, secret, { now: AT }), { id: ID, timestamp: AT });
    }
  });

  it('reads Node, plain and Fetch headers case-insensitively, and raw bytes', () => {
    const h = signedHeaders([decodeWebhookSecret(SECRET)], ID, AT, BODY);
    const mixed = { 'Webhook-Id': h['webhook-id'], 'WEBHOOK-TIMESTAMP': [h['webhook-timestamp']], 'webhook-signature': h['webhook-signature'] };
    assert.strictEqual(verifyWebhook(BODY, mixed, SECRET, { now: AT }).id, ID);
    assert.strictEqual(verifyWebhook(Buffer.from(BODY), new Headers(h), [OTHER_SECRET, SECRET], { now: AT }).id, ID);
  });

  it('accepts five minutes either side and refuses more, or a timestamp that is not whole seconds', () => {
    const h = signedHeaders([decodeWebhookSecret(SECRET)], ID, AT, BODY);
    const at = (s: number): Date => new Date(AT.getTime() + s * 1000);
    assert.strictEqual(verifyWebhook(BODY, h, SECRET, { now: at(300) }).id, ID);
    assert.strictEqual(verifyWebhook(BODY, h, SECRET, { now: at(-300) }).id, ID);
    assert.strictEqual(
      reasonOf(() => verifyWebhook(BODY, h, SECRET, { now: at(301) })),
      'timestamp',
    );
    assert.strictEqual(
      reasonOf(() => verifyWebhook(BODY, h, SECRET, { now: at(-301) })),
      'timestamp',
    );
    assert.strictEqual(
      reasonOf(() => verifyWebhook(BODY, { ...h, 'webhook-timestamp': '1614265330.5' }, SECRET, { now: AT })),
      'timestamp',
    );
  });

  it('refuses a changed body or id, another secret, an unknown version, a bad signature or a missing header', () => {
    const h = signedHeaders([decodeWebhookSecret(SECRET)], ID, AT, BODY);
    assert.strictEqual(
      reasonOf(() => verifyWebhook(`${BODY} `, h, SECRET, { now: AT })),
      'signature',
    );
    assert.strictEqual(
      reasonOf(() => verifyWebhook(BODY, { ...h, 'webhook-id': `${ID}x` }, SECRET, { now: AT })),
      'signature',
    );
    assert.strictEqual(
      reasonOf(() => verifyWebhook(BODY, h, OTHER_SECRET, { now: AT })),
      'signature',
    );
    assert.strictEqual(
      reasonOf(() => verifyWebhook(BODY, { ...h, 'webhook-signature': h['webhook-signature'].replace('v1,', 'v1a,') }, SECRET, { now: AT })),
      'signature',
    );
    assert.strictEqual(
      reasonOf(() => verifyWebhook(BODY, { ...h, 'webhook-signature': 'v1,AAAA' }, SECRET, { now: AT })),
      'signature',
    );
    const noId: Record<string, string> = { ...h };
    delete noId['webhook-id'];
    assert.strictEqual(
      reasonOf(() => verifyWebhook(BODY, noId, SECRET, { now: AT })),
      'headers',
    );
  });

  it('refuses an empty secret', () => {
    assert.throws(() => decodeWebhookSecret('whsec_'), TypeError);
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/signature.test.ts`
Expected: FAIL. The file does not load: `Cannot find module '../src/signature/index.js'`.

- [ ] **Step 3: Implement**

`packages/authn-webhooks/src/signature/sign.ts`:

```ts
import { createHmac } from 'node:crypto';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** The HMAC key of a `whsec_` secret; a secret without the prefix is read as plain base64, as the reference libraries do. */
export function decodeWebhookSecret(secret: string): Buffer {
  const b64 = secret.startsWith(WEBHOOK_SECRET_PREFIX) ? secret.slice(WEBHOOK_SECRET_PREFIX.length) : secret;
  const key = Buffer.from(b64, 'base64');
  if (key.length === 0) throw new TypeError('the webhook secret is empty or not base64');
  return key;
}

export function signatureOf(key: Buffer, id: string, timestamp: number, body: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest();
}

export type WebhookHeaders = {
  readonly 'webhook-id': string;
  readonly 'webhook-timestamp': string;
  readonly 'webhook-signature': string;
};

/** One `v1,<base64>` per key, space separated: during a rotation a receiver holding either secret verifies. */
export function signedHeaders(keys: readonly Buffer[], id: string, at: Date, body: string): WebhookHeaders {
  const timestamp = Math.floor(at.getTime() / 1000);
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': keys.map((k) => `v1,${signatureOf(k, id, timestamp, body).toString('base64')}`).join(' '),
  };
}
```

`packages/authn-webhooks/src/signature/verify.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';

import { decodeWebhookSecret, signatureOf } from './sign.js';

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookVerificationFailure = 'headers' | 'timestamp' | 'signature';

export class WebhookVerificationError extends Error {
  constructor(public readonly reason: WebhookVerificationFailure) {
    super(`webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

/** Node's IncomingHttpHeaders, a plain record, or a Fetch `Headers`. */
export type WebhookHeaderSource = { get(name: string): string | null } | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifiedWebhook {
  /** Retries repeat it: dedupe on it. */
  readonly id: string;
  readonly timestamp: Date;
}

function header(source: WebhookHeaderSource, name: string): string | undefined {
  if (typeof (source as { get?: unknown }).get === 'function') {
    return (source as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const record = source as Readonly<Record<string, string | readonly string[] | undefined>>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? (value[0] as string | undefined) : (value as string | undefined);
}

/**
 * Verifies a Standard Webhooks request. `body` must be the raw bytes received, not a re-serialised parse. `secrets` holds
 * every secret the receiver accepts (old and new during a rotation). Throws WebhookVerificationError.
 */
export function verifyWebhook(body: string | Uint8Array, headers: WebhookHeaderSource, secrets: string | readonly string[], opts: { readonly now?: Date; readonly toleranceSeconds?: number } = {}): VerifiedWebhook {
  const id = header(headers, 'webhook-id');
  const ts = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !ts || !signatures) throw new WebhookVerificationError('headers');
  if (!/^\d{1,12}$/.test(ts)) throw new WebhookVerificationError('timestamp');
  const timestamp = Number(ts);
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - timestamp) > (opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) throw new WebhookVerificationError('timestamp');

  const expected = (typeof secrets === 'string' ? [secrets] : secrets).map((s) => signatureOf(decodeWebhookSecret(s), id, timestamp, body));
  for (const entry of signatures.split(' ')) {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (expected.some((e) => e.length === given.length && timingSafeEqual(e, given))) return { id, timestamp: new Date(timestamp * 1000) };
  }
  throw new WebhookVerificationError('signature');
}
```

`packages/authn-webhooks/src/signature/index.ts`:

```ts
export * from './sign.js';
export * from './verify.js';
```

`packages/authn-webhooks/src/index.ts`:

```ts
export * from './schema.js';
export * from './signature/index.js';
```

- [ ] **Step 4: GREEN + build + subpath check**

1. `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/signature.test.ts`. Expected: 6 passing.
2. `npm test`. Expected: 11 passing (schema 5, signature 6).
3. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: exit code 0.
4. `node --input-type=module -e "const m = await import('@spinajs/authn-webhooks/verify'); console.log(Object.keys(m).sort().join(','))"`
   Expected: `WEBHOOK_SECRET_PREFIX,WEBHOOK_TOLERANCE_SECONDS,WebhookVerificationError,decodeWebhookSecret,signatureOf,signedHeaders,verifyWebhook`

- [ ] **Step 5: Commit**

```bash
node -e "const fs=require('fs');for(const f of process.argv.slice(1)){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))}" packages/authn-webhooks/src/signature/sign.ts packages/authn-webhooks/src/signature/verify.ts packages/authn-webhooks/src/signature/index.ts packages/authn-webhooks/src/index.ts packages/authn-webhooks/test/signature.test.ts
git add packages/authn-webhooks/src/signature/sign.ts packages/authn-webhooks/src/signature/verify.ts packages/authn-webhooks/src/signature/index.ts packages/authn-webhooks/src/index.ts packages/authn-webhooks/test/signature.test.ts
git diff --cached --name-only
git commit -m "feat(authn-webhooks): Standard Webhooks signing and a receiver verifier on the /verify subpath"
```

---

### Task 3: SSRF-guarded HTTP poster

**Files:**
- Create: `packages/authn-webhooks/src/http/address.ts`, `src/http/poster.ts`, `test/support/server.ts`, `test/address.test.ts`, `test/poster.test.ts`
- Modify: `packages/authn-webhooks/src/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `isBlockedAddress(address: string): boolean`, `bareHost(url: URL): string`
  - `type HostResolver = (hostname: string) => Promise<readonly LookupAddress[]>`, `systemResolver: HostResolver`
  - `class WebhookTargetRefused extends Error { reason: 'scheme' | 'address' }`
  - `guardedLookup(allowPrivateNetworks: boolean, resolve?: HostResolver): (hostname, options: LookupOptions, callback) => void`
  - `WEBHOOK_USER_AGENT`, `interface WebhookPostOptions { timeoutMs: number; allowHttp: boolean; allowPrivateNetworks: boolean }`
  - `interface WebhookPoster { post(url: string, headers: Readonly<Record<string, string>>, body: string, opts: WebhookPostOptions): Promise<number> }`, `class GuardedWebhookPoster implements WebhookPoster` (`constructor(resolveHost?: HostResolver)`)
  - Test support: `class TestServer { received; answer; url; port; start(); close() }`, `interface Received`, `interface Answer`

- [ ] **Step 1: Write the failing tests**

`packages/authn-webhooks/test/support/server.ts`:

```ts
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Answer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Never answer. */
  readonly hang?: boolean;
}

/** An http server on 127.0.0.1 that records every request and answers what `answer` says. */
export class TestServer {
  public readonly received: Received[] = [];
  public answer: (path: string) => Answer = () => ({ status: 200 });
  public url = '';
  public port = 0;
  private readonly server = createServer((req, res) => this.handle(req, res));

  public async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this;
  }

  public async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      this.received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const a = this.answer(req.url ?? '');
      if (a.hang) return;
      res.writeHead(a.status, a.headers);
      res.end(a.body ?? 'a body the poster never reads');
    });
  }
}
```

`packages/authn-webhooks/test/address.test.ts`:

```ts
import 'mocha';
import assert from 'node:assert/strict';
import type { LookupAddress, LookupOptions } from 'node:dns';

import { WebhookTargetRefused, guardedLookup, isBlockedAddress } from '../src/http/address.js';

interface LookupResult {
  readonly err: NodeJS.ErrnoException | null;
  readonly address: unknown;
  readonly family?: number;
}

const lookupWith = (allow: boolean, addresses: LookupAddress[], options: LookupOptions): Promise<LookupResult> =>
  new Promise((resolve) => {
    guardedLookup(allow, async () => addresses)('hooks.example.com', options, (err, address, family) => resolve({ err, address, family }));
  });

describe('isBlockedAddress', () => {
  it('blocks private, loopback, link-local, metadata, reserved and embedded-IPv4 addresses', () => {
    for (const a of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd00:ec2::254', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:c0a8:101::1', 'ff02::1', 'not-an-ip']) {
      assert.strictEqual(isBlockedAddress(a), true, a);
    }
  });

  it('lets public addresses through', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
      assert.strictEqual(isBlockedAddress(a), false, a);
    }
  });
});

describe('guardedLookup', () => {
  const PUBLIC: LookupAddress[] = [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1::1', family: 6 },
  ];

  it('answers the resolved addresses in the shape the caller asks for', async () => {
    assert.deepStrictEqual((await lookupWith(false, PUBLIC, { all: true })).address, PUBLIC);
    assert.deepStrictEqual(await lookupWith(false, PUBLIC, {}), { err: null, address: '93.184.216.34', family: 4 });
    assert.deepStrictEqual(await lookupWith(false, PUBLIC, { family: 6 }), { err: null, address: '2606:2800:220:1::1', family: 6 });
  });

  it('refuses the host when any address is blocked, unless private networks are allowed', async () => {
    const mixed: LookupAddress[] = [PUBLIC[0], { address: '10.0.0.5', family: 4 }];
    const refused = await lookupWith(false, mixed, { all: true });
    assert.ok(refused.err instanceof WebhookTargetRefused && refused.err.reason === 'address');
    assert.strictEqual((await lookupWith(true, mixed, { all: true })).err, null);
  });

  it('passes a resolver error through', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      guardedLookup(false, async () => {
        throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      })('x.example', {}, (e) => resolve(e));
    });
    assert.strictEqual(err?.code, 'ENOTFOUND');
  });
});
```

`packages/authn-webhooks/test/poster.test.ts`:

```ts
import 'mocha';
import assert from 'node:assert/strict';

import { WebhookTargetRefused } from '../src/http/address.js';
import { GuardedWebhookPoster, WEBHOOK_USER_AGENT } from '../src/http/poster.js';
import { TestServer } from './support/server.js';

const OPEN = { timeoutMs: 2000, allowHttp: true, allowPrivateNetworks: true };

const resolvesTo = (address: string) => async () => [{ address, family: 4 }];

const refusedFor = (reason: 'scheme' | 'address') => (e: unknown) => e instanceof WebhookTargetRefused && e.reason === reason;

describe('GuardedWebhookPoster', function () {
  this.timeout(10000);

  let server: TestServer;

  beforeEach(async () => {
    server = await new TestServer().start();
  });

  afterEach(async () => {
    await server.close();
  });

  it('posts the body with the given headers and answers the status without reading the answer body', async () => {
    server.answer = () => ({ status: 200, body: 'x'.repeat(64 * 1024) });
    assert.strictEqual(await new GuardedWebhookPoster().post(`${server.url}/hook`, { 'webhook-id': 'msg_1' }, '{"a":1}', OPEN), 200);
    const [r] = server.received;
    assert.deepStrictEqual(
      { path: r.path, body: r.body, id: r.headers['webhook-id'], type: r.headers['content-type'], agent: r.headers['user-agent'] },
      { path: '/hook', body: '{"a":1}', id: 'msg_1', type: 'application/json', agent: WEBHOOK_USER_AGENT },
    );
  });

  it('does not follow a redirect', async () => {
    server.answer = (path) => (path === '/hook' ? { status: 302, headers: { location: '/elsewhere' } } : { status: 200 });
    assert.strictEqual(await new GuardedWebhookPoster().post(`${server.url}/hook`, {}, '{}', OPEN), 302);
    assert.deepStrictEqual(
      server.received.map((r) => r.path),
      ['/hook'],
    );
  });

  it('gives up after timeoutMs', async () => {
    server.answer = () => ({ status: 200, hang: true });
    const started = Date.now();
    await assert.rejects(new GuardedWebhookPoster().post(`${server.url}/hook`, {}, '{}', { ...OPEN, timeoutMs: 200 }), (e: Error) => e.name === 'AbortError');
    assert.ok(Date.now() - started < 2000);
  });

  it('refuses a loopback IP literal, a mapped one and a host resolving to one, unless private networks are allowed', async () => {
    const closed = { ...OPEN, allowPrivateNetworks: false };
    await assert.rejects(new GuardedWebhookPoster().post(`${server.url}/hook`, {}, '{}', closed), refusedFor('address'));
    await assert.rejects(new GuardedWebhookPoster().post(`http://[::ffff:127.0.0.1]:${server.port}/hook`, {}, '{}', closed), refusedFor('address'));
    await assert.rejects(new GuardedWebhookPoster(resolvesTo('127.0.0.1')).post(`http://webhooks.test:${server.port}/hook`, {}, '{}', closed), refusedFor('address'));
    assert.deepStrictEqual(server.received, []);
    assert.strictEqual(await new GuardedWebhookPoster(resolvesTo('127.0.0.1')).post(`http://webhooks.test:${server.port}/hook`, {}, '{}', OPEN), 200);
  });

  it('refuses http unless allowed', async () => {
    await assert.rejects(new GuardedWebhookPoster().post(`${server.url}/hook`, {}, '{}', { ...OPEN, allowHttp: false }), refusedFor('scheme'));
    assert.deepStrictEqual(server.received, []);
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/address.test.ts test/poster.test.ts`
Expected: FAIL. Neither file loads: `Cannot find module '../src/http/address.js'`.

- [ ] **Step 3: Implement**

`packages/authn-webhooks/src/http/address.ts`:

```ts
import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const BLOCKED = new BlockList();
const IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const IPV6: readonly (readonly [string, number])[] = [
  ['::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['64:ff9b:1::', 48],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of IPV4) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of IPV6) BLOCKED.addSubnet(net, prefix, 'ipv6');

// In the URL-serialised form, IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) addresses end in their IPv4 address.
const EMBEDS_IPV4 = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * True for an address a webhook may reach only with allowPrivateNetworks: private, loopback, link-local (cloud metadata),
 * CGNAT, multicast, reserved, documentation, 6to4 and Teredo. A string that is not an IP is refused too.
 */
export function isBlockedAddress(address: string): boolean {
  const bare = address.split('%')[0];
  const family = isIP(bare);
  if (family === 4) return BLOCKED.check(bare, 'ipv4');
  if (family !== 6) return true;
  const canonical = new URL(`http://[${bare}]`).hostname.slice(1, -1);
  const embedded = EMBEDS_IPV4.exec(canonical);
  if (embedded) {
    const hi = parseInt(embedded[1], 16);
    const lo = parseInt(embedded[2], 16);
    return BLOCKED.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  return BLOCKED.check(canonical, 'ipv6');
}

/** A URL host without the brackets of an IPv6 literal. */
export function bareHost(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

export type HostResolver = (hostname: string) => Promise<readonly LookupAddress[]>;

export const systemResolver: HostResolver = (hostname) => lookup(hostname, { all: true });

export class WebhookTargetRefused extends Error {
  constructor(public readonly reason: 'scheme' | 'address') {
    super(reason === 'scheme' ? 'the webhook URL scheme is not allowed here' : 'the webhook target is a private, loopback, link-local or reserved address');
    this.name = 'WebhookTargetRefused';
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for http.request that refuses the host when any address it resolves to is blocked. The check runs where the
 * socket connects, so no DNS answer can change between the check and the connect.
 */
export function guardedLookup(allowPrivateNetworks: boolean, resolve: HostResolver = systemResolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const wanted = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0;
    resolve(hostname).then(
      (all) => {
        if (!allowPrivateNetworks && all.some((a) => isBlockedAddress(a.address))) {
          callback(new WebhookTargetRefused('address'), '', 0);
          return;
        }
        const usable = all.filter((a) => wanted === 0 || a.family === wanted);
        if (usable.length === 0) {
          callback(Object.assign(new Error('the webhook host has no usable address'), { code: 'ENOTFOUND' }), '', 0);
          return;
        }
        if (options.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      },
      (err) => callback(err, '', 0),
    );
  };
}
```

`packages/authn-webhooks/src/http/poster.ts`:

```ts
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { WebhookTargetRefused, bareHost, guardedLookup, isBlockedAddress, systemResolver } from './address.js';
import type { HostResolver } from './address.js';

export const WEBHOOK_USER_AGENT = 'spinajs-authn-webhooks';

export interface WebhookPostOptions {
  readonly timeoutMs: number;
  readonly allowHttp: boolean;
  readonly allowPrivateNetworks: boolean;
}

export interface WebhookPoster {
  /** The status of the answer; its body is never read. Rejects on a refused target, a transport error or the timeout. */
  post(url: string, headers: Readonly<Record<string, string>>, body: string, opts: WebhookPostOptions): Promise<number>;
}

/** One POST per call on its own connection; a 3xx is only a status, never followed. */
export class GuardedWebhookPoster implements WebhookPoster {
  constructor(private readonly resolveHost: HostResolver = systemResolver) {}

  public async post(url: string, headers: Readonly<Record<string, string>>, body: string, opts: WebhookPostOptions): Promise<number> {
    const target = new URL(url);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && opts.allowHttp)) throw new WebhookTargetRefused('scheme');
    // Node connects to an IP literal without calling `lookup`.
    const host = bareHost(target);
    if (isIP(host) !== 0 && !opts.allowPrivateNetworks && isBlockedAddress(host)) throw new WebhookTargetRefused('address');

    const send: typeof httpRequest = target.protocol === 'https:' ? (httpsRequest as typeof httpRequest) : httpRequest;
    return new Promise<number>((resolve, reject) => {
      const req = send(
        target,
        {
          method: 'POST',
          agent: false,
          lookup: guardedLookup(opts.allowPrivateNetworks, this.resolveHost),
          signal: AbortSignal.timeout(opts.timeoutMs),
          headers: { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'user-agent': WEBHOOK_USER_AGENT },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.destroy();
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }
}
```

`packages/authn-webhooks/src/index.ts`:

```ts
export * from './schema.js';
export * from './signature/index.js';
export * from './http/address.js';
export * from './http/poster.js';
```

- [ ] **Step 4: GREEN + suite + build**

1. `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/address.test.ts test/poster.test.ts`. Expected: 10 passing (address 5, poster 5).
2. `npm test`. Expected: 21 passing.
3. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
node -e "const fs=require('fs');for(const f of process.argv.slice(1)){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))}" packages/authn-webhooks/src/http/address.ts packages/authn-webhooks/src/http/poster.ts packages/authn-webhooks/src/index.ts packages/authn-webhooks/test/support/server.ts packages/authn-webhooks/test/address.test.ts packages/authn-webhooks/test/poster.test.ts
git add packages/authn-webhooks/src/http/address.ts packages/authn-webhooks/src/http/poster.ts packages/authn-webhooks/src/index.ts packages/authn-webhooks/test/support/server.ts packages/authn-webhooks/test/address.test.ts packages/authn-webhooks/test/poster.test.ts
git diff --cached --name-only
git commit -m "feat(authn-webhooks): an HTTP poster that refuses private targets at connect time and follows no redirect"
```

---

### Task 4: Payload, deliverer and the `AuthnWebhookDelivery` job (worker side)

**Files:**
- Create: `packages/authn-webhooks/src/payload.ts`, `src/delivery/deliverer.ts`, `src/delivery/job.ts`, `test/payload.test.ts`, `test/deliverer.test.ts`, `test/job.test.ts`
- Modify: `packages/authn-webhooks/src/index.ts`

**Interfaces:**
- Consumes: `WebhooksConfig`, `WebhookEndpointConfig` (Task 1); `decodeWebhookSecret`, `signedHeaders`, `verifyWebhook` (Task 2); `GuardedWebhookPoster`, `WebhookPoster`, `WebhookTargetRefused` (Task 3); `TestServer`, `bootChild`, `pin`, `endpoint`, `SECRET`, `OTHER_SECRET` (test support).
- Produces:
  - `interface WebhookPayload { id: string; type: string; timestamp: string; data: Readonly<Record<string, unknown>> }`, `interface PayloadOptions { includeData: boolean; includeClientInfo: boolean }`
  - `newMessageId(): string` (`msg_<uuid>`), `webhookType(type: string): string`, `webhookPayload(e: AuthnEvent, id: string, opts: PayloadOptions, now?: () => Date): WebhookPayload`, `webhookBody(p: WebhookPayload): string`, `subscribes(events: readonly string[], type: string): boolean`
  - `interface DeliveryData { Endpoint: string; MessageId: string; EventType: string; Body: string }`, `type DeliveryOutcome = 'delivered' | 'dropped'`
  - `class WebhookDeliveryFailed extends Error { endpoint: string; detail: string }`, message `authn-webhooks: endpoint "<name>" <detail>`
  - `interface DelivererOptions { poster?; now?; log?: AuditLog; lenientEnv?: boolean; newId? }`
  - `class AuthnWebhookDeliverer` (`@Singleton()`): `deliver(job: DeliveryData): Promise<DeliveryOutcome>`, `ping(name: string): Promise<number>`, `failed(job: DeliveryData, err: unknown, ctx: IJobFailureContext): void`
  - `AUTHN_WEBHOOK_JOB = 'AuthnWebhookDelivery'`, `@Job() class AuthnWebhookDelivery extends QueueJob implements DeliveryData` (protected `deliverer(): Promise<AuthnWebhookDeliverer>` seam), `interface DeliveryJobInput { endpoint; messageId; eventType; body; maxAttempts }`, `deliveryJob(input): AuthnWebhookDelivery`

- [ ] **Step 1: Write the failing tests**

`packages/authn-webhooks/test/payload.test.ts`:

```ts
import 'mocha';
import assert from 'node:assert/strict';
import type { AuthnEvent, IdentityRef } from '@spinajs/authn/contracts';

import { subscribes, webhookBody, webhookPayload } from '../src/payload.js';

const EVENT: AuthnEvent = {
  type: 'login',
  at: new Date('2026-10-06T10:00:00.000Z'),
  outcome: 'failure',
  identity: { type: 'user', id: 'u-1' },
  actor: { type: 'user', id: 'admin-1' },
  strategy: 'local',
  reason: 'bad_password',
  ip: '203.0.113.9',
  userAgent: 'Mozilla/5.0',
  session: 'h:abc',
  data: { attempt: 3 },
};

const NONE = { includeData: false, includeClientInfo: false };

const parsed = (e: AuthnEvent, opts = NONE): Record<string, unknown> => JSON.parse(webhookBody(webhookPayload(e, 'msg_1', opts))) as Record<string, unknown>;

describe('webhook payload', () => {
  it('carries the event without the IP, the user agent or data by default', () => {
    assert.deepStrictEqual(parsed(EVENT), {
      id: 'msg_1',
      type: 'authn.login',
      timestamp: '2026-10-06T10:00:00.000Z',
      data: { outcome: 'failure', identity: { type: 'user', id: 'u-1' }, actor: { type: 'user', id: 'admin-1' }, strategy: 'local', reason: 'bad_password', session: 'h:abc' },
    });
  });

  it('adds data and the client info only when asked', () => {
    const data = parsed(EVENT, { includeData: true, includeClientInfo: true }).data as Record<string, unknown>;
    assert.deepStrictEqual([data.data, data.ip, data.userAgent], [{ attempt: 3 }, '203.0.113.9', 'Mozilla/5.0']);
  });

  it('leaves out absent members and anything but type and id of a ref', () => {
    const identity = { type: 'user', id: 'u-1', email: 'a@example.com' } as IdentityRef;
    assert.deepStrictEqual(parsed({ type: 'logout', at: EVENT.at, outcome: 'success', identity }).data, { outcome: 'success', identity: { type: 'user', id: 'u-1' } });
  });

  it('uses now for an invalid event time and writes a bigint as a string', () => {
    assert.strictEqual(webhookPayload({ ...EVENT, at: new Date(NaN) }, 'm', NONE, () => new Date('2026-01-01T00:00:00Z')).timestamp, '2026-01-01T00:00:00.000Z');
    assert.ok(webhookBody(webhookPayload({ ...EVENT, data: { n: 10n } }, 'm', { includeData: true, includeClientInfo: false })).includes('"n":"10"'));
  });

  it('subscribes by bare type or by *', () => {
    assert.deepStrictEqual([subscribes(['*'], 'logout'), subscribes(['login'], 'login'), subscribes(['login'], 'logout')], [true, true, false]);
  });
});
```

`packages/authn-webhooks/test/deliverer.test.ts`:

```ts
import 'mocha';
import assert from 'node:assert/strict';

import { AuthnWebhookDeliverer, WebhookDeliveryFailed } from '../src/delivery/deliverer.js';
import type { DeliveryData } from '../src/delivery/deliverer.js';
import type { WebhookPoster } from '../src/http/poster.js';
import { verifyWebhook } from '../src/signature/index.js';
import { OTHER_SECRET, SECRET, bootChild, disposeChildren, endpoint, pin } from './support/config.js';
import { TestServer } from './support/server.js';

const NOW = new Date('2026-10-06T10:00:00.000Z');

const job = (over: Partial<DeliveryData> = {}): DeliveryData => ({ Endpoint: 'crm', MessageId: 'msg_1', EventType: 'authn.login', Body: '{"id":"msg_1","type":"authn.login"}', ...over });

const failedWith = (message: string) => (e: unknown) => e instanceof WebhookDeliveryFailed && e.message === message;

describe('AuthnWebhookDeliverer', function () {
  this.timeout(10000);

  let server: TestServer;
  let warnings: string[];

  beforeEach(async () => {
    server = await new TestServer().start();
    warnings = [];
  });

  afterEach(async () => {
    await server.close();
    await disposeChildren();
  });

  interface Setup {
    readonly now?: () => Date;
    readonly lenientEnv?: boolean;
    readonly poster?: WebhookPoster;
    readonly webhooks?: Record<string, unknown>;
  }

  async function deliverer(over: Record<string, unknown> = {}, setup: Setup = {}): Promise<AuthnWebhookDeliverer> {
    const child = await bootChild({ authn: { webhooks: { endpoints: [endpoint({ url: `${server.url}/hook`, allowPrivateNetworks: true, ...over })], ...setup.webhooks } } });
    const log = {
      info: () => undefined,
      warn: (m: string) => {
        warnings.push(m);
      },
    };
    return pin(new AuthnWebhookDeliverer({ now: setup.now ?? (() => NOW), lenientEnv: setup.lenientEnv ?? true, poster: setup.poster, log, newId: () => 'msg_ping' }), child);
  }

  it('posts the queued body signed, and the receiver verifies it', async () => {
    assert.strictEqual(await (await deliverer()).deliver(job()), 'delivered');
    const [r] = server.received;
    assert.strictEqual(r.body, job().Body);
    assert.deepStrictEqual(verifyWebhook(r.body, r.headers, SECRET, { now: NOW }), { id: 'msg_1', timestamp: NOW });
  });

  it('keeps the webhook-id on every attempt; the timestamp is the attempt time', async () => {
    let now = NOW;
    const d = await deliverer({}, { now: () => now });
    await d.deliver(job());
    now = new Date(NOW.getTime() + 3600_000);
    await d.deliver(job());
    const [first, second] = server.received;
    assert.strictEqual(first.headers['webhook-id'], second.headers['webhook-id']);
    assert.deepStrictEqual([first.headers['webhook-timestamp'], second.headers['webhook-timestamp']], [String(NOW.getTime() / 1000), String(now.getTime() / 1000)]);
    assert.strictEqual(verifyWebhook(second.body, second.headers, SECRET, { now }).id, 'msg_1');
  });

  it('signs with the current and the previous secrets during a rotation', async () => {
    await (await deliverer({ secret: { secret: OTHER_SECRET, previous: [{ secret: SECRET }] } })).deliver(job());
    const [r] = server.received;
    assert.strictEqual(String(r.headers['webhook-signature']).split(' ').length, 2);
    for (const secret of [SECRET, OTHER_SECRET]) assert.strictEqual(verifyWebhook(r.body, r.headers, secret, { now: NOW }).id, 'msg_1');
  });

  it('fails the attempt on any answer outside 2xx, naming only the endpoint and the status', async () => {
    const d = await deliverer();
    for (const status of [302, 404, 500]) {
      server.answer = () => ({ status, headers: status === 302 ? { location: '/elsewhere' } : {} });
      await assert.rejects(d.deliver(job()), failedWith(`authn-webhooks: endpoint "crm" answered HTTP ${status}`));
    }
    assert.ok(server.received.every((r) => r.path === '/hook'));
  });

  it('fails the attempt on a refused target, http outside dev and test, or the timeout', async () => {
    await assert.rejects((await deliverer({ allowPrivateNetworks: false })).deliver(job()), failedWith('authn-webhooks: endpoint "crm" refused (address)'));
    await assert.rejects((await deliverer({}, { lenientEnv: false })).deliver(job()), failedWith('authn-webhooks: endpoint "crm" refused (scheme)'));
    assert.deepStrictEqual(server.received, []);
    server.answer = () => ({ status: 200, hang: true });
    await assert.rejects((await deliverer({}, { webhooks: { timeoutMs: 200 } })).deliver(job()), failedWith('authn-webhooks: endpoint "crm" timed out'));
  });

  it('reports a socket error by its code, never by its message', async () => {
    const poster: WebhookPoster = {
      post: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 10.1.1.1:443'), { code: 'ECONNREFUSED' });
      },
    };
    await assert.rejects((await deliverer({}, { poster })).deliver(job()), failedWith('authn-webhooks: endpoint "crm" failed (ECONNREFUSED)'));
  });

  it('drops a job whose endpoint is no longer configured, with a warning', async () => {
    assert.strictEqual(await (await deliverer()).deliver(job({ Endpoint: 'gone' })), 'dropped');
    assert.deepStrictEqual(warnings, ['authn-webhooks: endpoint "gone" is no longer configured; delivery "msg_1" ("authn.login") dropped']);
    assert.deepStrictEqual(server.received, []);
  });

  it('logs a failed attempt with the endpoint and the attempt, never the body', async () => {
    const d = await deliverer();
    d.failed(job(), new WebhookDeliveryFailed('crm', 'answered HTTP 500'), { attempt: 8, maxAttempts: 8, isFinal: true, jobId: 'j-1' });
    d.failed(job(), new TypeError('detail that may echo values'), { attempt: 1, maxAttempts: 8, isFinal: false, jobId: 'j-1' });
    assert.deepStrictEqual(warnings, [
      'authn-webhooks: delivery "msg_1" ("authn.login") to endpoint "crm" failed, attempt 8 of 8, giving up: answered HTTP 500',
      'authn-webhooks: delivery "msg_1" ("authn.login") to endpoint "crm" failed, attempt 1 of 8: TypeError',
    ]);
  });

  it('ping sends a signed authn.ping at once and answers the status', async () => {
    const d = await deliverer();
    assert.strictEqual(await d.ping('crm'), 200);
    const [r] = server.received;
    assert.deepStrictEqual(JSON.parse(r.body), { id: 'msg_ping', type: 'authn.ping', timestamp: NOW.toISOString(), data: {} });
    assert.strictEqual(verifyWebhook(r.body, r.headers, SECRET, { now: NOW }).id, 'msg_ping');
    await assert.rejects(d.ping('nope'), /no webhook endpoint "nope" is configured/);
  });
});
```

`packages/authn-webhooks/test/job.test.ts`:

```ts
import 'mocha';
import assert from 'node:assert/strict';
import { QueueMessageType } from '@spinajs/queue';
import type { IJobFailureContext } from '@spinajs/queue';

import type { AuthnWebhookDeliverer, DeliveryData } from '../src/delivery/deliverer.js';
import { AUTHN_WEBHOOK_JOB, AuthnWebhookDelivery, deliveryJob } from '../src/delivery/job.js';

class RecordingDeliverer {
  public readonly calls: unknown[][] = [];

  public async deliver(d: DeliveryData): Promise<'delivered'> {
    this.calls.push(['deliver', d.MessageId]);
    return 'delivered';
  }

  public failed(d: DeliveryData, err: unknown, ctx: IJobFailureContext): void {
    this.calls.push(['failed', d.MessageId, (err as Error).name, ctx.isFinal]);
  }
}

class TestDelivery extends AuthnWebhookDelivery {
  public readonly fake = new RecordingDeliverer();

  protected async deliverer(): Promise<AuthnWebhookDeliverer> {
    return this.fake as unknown as AuthnWebhookDeliverer;
  }
}

const INPUT = { endpoint: 'crm', messageId: 'msg_1', eventType: 'authn.login', body: '{}', maxAttempts: 8 };

describe('AuthnWebhookDelivery', () => {
  it('is a durable job retried maxAttempts - 1 times, and survives the wire', () => {
    const j = deliveryJob(INPUT);
    const view = (x: AuthnWebhookDelivery) => ({ Name: x.Name, Type: x.Type, Persistent: x.Persistent, RetryCount: x.RetryCount, Endpoint: x.Endpoint, MessageId: x.MessageId, EventType: x.EventType, Body: x.Body });
    const expected = { Name: AUTHN_WEBHOOK_JOB, Type: QueueMessageType.Job, Persistent: true, RetryCount: 7, Endpoint: 'crm', MessageId: 'msg_1', EventType: 'authn.login', Body: '{}' };
    assert.deepStrictEqual(view(j), expected);
    const revived = new AuthnWebhookDelivery();
    revived.hydrate(JSON.parse(JSON.stringify(j)));
    assert.deepStrictEqual(view(revived), expected);
  });

  it('hands execute and onFailed to the deliverer', async () => {
    const j = new TestDelivery();
    j.hydrate({ Endpoint: 'crm', MessageId: 'msg_1', EventType: 'authn.login', Body: '{}' });
    assert.strictEqual(await j.execute(), 'delivered');
    await j.onFailed(new TypeError('x'), { attempt: 8, maxAttempts: 8, isFinal: true, jobId: 'j' });
    assert.deepStrictEqual(j.fake.calls, [
      ['deliver', 'msg_1'],
      ['failed', 'msg_1', 'TypeError', true],
    ]);
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/payload.test.ts test/deliverer.test.ts test/job.test.ts`
Expected: FAIL. The files do not load: `Cannot find module '../src/payload.js'` and `'../src/delivery/deliverer.js'`.

- [ ] **Step 3: Implement**

`packages/authn-webhooks/src/payload.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { AuthnEvent } from '@spinajs/authn/contracts';

export interface WebhookPayload {
  readonly id: string;
  /** `authn.<AuthnEventType>`, or `authn.ping` from authn:webhook-test. */
  readonly type: string;
  /** When the event happened; the webhook-timestamp header is the attempt time. */
  readonly timestamp: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PayloadOptions {
  readonly includeData: boolean;
  readonly includeClientInfo: boolean;
}

export const newMessageId = (): string => `msg_${randomUUID()}`;

export const webhookType = (type: string): string => `authn.${type}`;

const ref = (r: { readonly type: string; readonly id: string } | undefined): { type: string; id: string } | undefined => (r ? { type: r.type, id: r.id } : undefined);

/** The IP, the user agent and `data` only when the endpoint asks (privacy); events never carry secrets (A21). */
export function webhookPayload(e: AuthnEvent, id: string, opts: PayloadOptions, now: () => Date = () => new Date()): WebhookPayload {
  const at = e.at instanceof Date && !Number.isNaN(e.at.getTime()) ? e.at : now();
  const data: Record<string, unknown> = {
    outcome: e.outcome,
    identity: ref(e.identity),
    actor: ref(e.actor),
    strategy: e.strategy,
    reason: e.reason,
    session: e.session,
  };
  if (opts.includeData) data.data = e.data;
  if (opts.includeClientInfo) {
    data.ip = e.ip;
    data.userAgent = e.userAgent;
  }
  return { id, type: webhookType(e.type), timestamp: at.toISOString(), data };
}

// JSON.stringify leaves out the undefined members, so absent fields never reach the receiver.
export function webhookBody(payload: WebhookPayload): string {
  return JSON.stringify(payload, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

export function subscribes(events: readonly string[], type: string): boolean {
  return events.includes('*') || events.includes(type);
}
```

`packages/authn-webhooks/src/delivery/deliverer.ts`:

```ts
import { DI, Singleton } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { auditLog, authnAppEnv, isLenientAuthnEnv } from '@spinajs/authn';
import type { AuditLog } from '@spinajs/authn';
import type { IJobFailureContext } from '@spinajs/queue';

import { WebhookTargetRefused } from '../http/address.js';
import { GuardedWebhookPoster } from '../http/poster.js';
import type { WebhookPoster } from '../http/poster.js';
import { newMessageId, webhookBody } from '../payload.js';
import type { WebhookEndpointConfig, WebhooksConfig } from '../schema.js';
import { decodeWebhookSecret, signedHeaders } from '../signature/sign.js';

export interface DeliveryData {
  readonly Endpoint: string;
  readonly MessageId: string;
  readonly EventType: string;
  readonly Body: string;
}

export type DeliveryOutcome = 'delivered' | 'dropped';

const q = (v: string): string => JSON.stringify(v);

/** Safe to log and to keep as the job's LastError: the endpoint name and a status or an error code only. */
export class WebhookDeliveryFailed extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly detail: string,
  ) {
    super(`authn-webhooks: endpoint ${q(endpoint)} ${detail}`);
    this.name = 'WebhookDeliveryFailed';
  }
}

export interface DelivererOptions {
  readonly poster?: WebhookPoster;
  readonly now?: () => Date;
  readonly log?: AuditLog;
  /** Allow http targets; default: the app env is development or test. */
  readonly lenientEnv?: boolean;
  readonly newId?: () => string;
}

function failureDetail(err: unknown): string {
  if (err instanceof WebhookTargetRefused) return `refused (${err.reason})`;
  if ((err as { name?: unknown } | null)?.name === 'AbortError') return 'timed out';
  // Never the message: a socket error's message names the host and its address.
  const code = (err as { code?: unknown } | null)?.code;
  return `failed (${typeof code === 'string' ? code : err instanceof Error ? err.name : typeof err})`;
}

/**
 * The worker side. It signs and posts a queued delivery, reading the endpoint's URL and secrets at send time, so the queue
 * never holds a secret and a rotation reaches queued jobs. A root singleton: the queue consumer resolves jobs at the root.
 */
@Singleton()
export class AuthnWebhookDeliverer {
  @Config('authn.webhooks')
  protected Config: WebhooksConfig;

  private readonly poster: WebhookPoster;
  private readonly now: () => Date;
  private readonly log: AuditLog;
  private readonly newId: () => string;

  /** `options` is for tests; DI passes nothing. */
  constructor(private readonly options: DelivererOptions = {}) {
    this.poster = options.poster ?? new GuardedWebhookPoster();
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? auditLog('authn-webhooks');
    this.newId = options.newId ?? newMessageId;
  }

  public async deliver(job: DeliveryData): Promise<DeliveryOutcome> {
    const endpoint = this.endpoint(job.Endpoint);
    if (!endpoint) {
      this.log.warn(`authn-webhooks: endpoint ${q(job.Endpoint)} is no longer configured; delivery ${q(job.MessageId)} (${q(job.EventType)}) dropped`);
      return 'dropped';
    }
    await this.send(endpoint, job.MessageId, job.Body);
    return 'delivered';
  }

  /** Sends a signed `authn.ping` at once, bypassing the queue; answers the 2xx status. */
  public async ping(name: string): Promise<number> {
    const endpoint = this.endpoint(name);
    if (!endpoint) throw new InvalidArgument(`no webhook endpoint ${q(name)} is configured in authn.webhooks.endpoints`);
    const id = this.newId();
    return this.send(endpoint, id, webhookBody({ id, type: 'authn.ping', timestamp: this.now().toISOString(), data: {} }));
  }

  public failed(job: DeliveryData, err: unknown, ctx: IJobFailureContext): void {
    const why = err instanceof WebhookDeliveryFailed ? err.detail : err instanceof Error ? err.name : typeof err;
    this.log.warn(`authn-webhooks: delivery ${q(job.MessageId)} (${q(job.EventType)}) to endpoint ${q(job.Endpoint)} failed, attempt ${ctx.attempt} of ${ctx.maxAttempts}${ctx.isFinal ? ', giving up' : ''}: ${why}`);
  }

  private get config(): WebhooksConfig {
    if (!this.Config) throw new InvalidOperation('authn.webhooks is unset: AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA is not registered');
    return this.Config;
  }

  private endpoint(name: string): WebhookEndpointConfig | undefined {
    return this.config.endpoints.find((e) => e.name === name);
  }

  private allowsHttp(): boolean {
    if (this.options.lenientEnv !== undefined) return this.options.lenientEnv;
    const configuration = DI.get(Configuration);
    return configuration ? isLenientAuthnEnv(authnAppEnv(configuration)) : false;
  }

  private async send(endpoint: WebhookEndpointConfig, id: string, body: string): Promise<number> {
    const keys = [endpoint.secret.secret, ...(endpoint.secret.previous ?? []).map((p) => p.secret)].map(decodeWebhookSecret);
    let status: number;
    try {
      status = await this.poster.post(endpoint.url, signedHeaders(keys, id, this.now(), body), body, {
        timeoutMs: this.config.timeoutMs,
        allowHttp: this.allowsHttp(),
        allowPrivateNetworks: endpoint.allowPrivateNetworks === true,
      });
    } catch (err) {
      throw new WebhookDeliveryFailed(endpoint.name, failureDetail(err));
    }
    if (status < 200 || status >= 300) throw new WebhookDeliveryFailed(endpoint.name, `answered HTTP ${status}`);
    return status;
  }
}
```

`packages/authn-webhooks/src/delivery/job.ts`:

```ts
import { DI } from '@spinajs/di';
import { Job, QueueJob } from '@spinajs/queue';
import type { IJobFailureContext } from '@spinajs/queue';

import { AuthnWebhookDeliverer } from './deliverer.js';
import type { DeliveryData, DeliveryOutcome } from './deliverer.js';

/** The class name: the queue routes and consumes jobs by it (queue.routing.AuthnWebhookDelivery). */
export const AUTHN_WEBHOOK_JOB = 'AuthnWebhookDelivery';

/**
 * One event to one endpoint. The transport retries a failed attempt RetryCount times with its connection's backoff, then
 * dead-letters the job; MessageId, the webhook-id, is the same on every attempt. Runs unattended: it touches no data.
 */
@Job()
export class AuthnWebhookDelivery extends QueueJob implements DeliveryData {
  public Endpoint: string;
  public MessageId: string;
  public EventType: string;
  public Body: string;

  public async execute(): Promise<DeliveryOutcome> {
    return (await this.deliverer()).deliver(this);
  }

  public async onFailed(err: unknown, ctx: IJobFailureContext): Promise<void> {
    (await this.deliverer()).failed(this, err, ctx);
  }

  protected async deliverer(): Promise<AuthnWebhookDeliverer> {
    return DI.resolve(AuthnWebhookDeliverer);
  }
}

export interface DeliveryJobInput {
  readonly endpoint: string;
  readonly messageId: string;
  readonly eventType: string;
  readonly body: string;
  readonly maxAttempts: number;
}

export function deliveryJob(input: DeliveryJobInput): AuthnWebhookDelivery {
  const job = new AuthnWebhookDelivery();
  job.Endpoint = input.endpoint;
  job.MessageId = input.messageId;
  job.EventType = input.eventType;
  job.Body = input.body;
  job.RetryCount = input.maxAttempts - 1;
  job.Persistent = true;
  return job;
}
```

`packages/authn-webhooks/src/index.ts`:

```ts
export * from './schema.js';
export * from './signature/index.js';
export * from './http/address.js';
export * from './http/poster.js';
export * from './payload.js';
export * from './delivery/deliverer.js';
export * from './delivery/job.js';
```

- [ ] **Step 4: GREEN + suite + build**

1. `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/payload.test.ts test/deliverer.test.ts test/job.test.ts`. Expected: 16 passing (payload 5, deliverer 9, job 2).
2. `npm test`. Expected: 37 passing.
3. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
node -e "const fs=require('fs');for(const f of process.argv.slice(1)){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))}" packages/authn-webhooks/src/payload.ts packages/authn-webhooks/src/delivery/deliverer.ts packages/authn-webhooks/src/delivery/job.ts packages/authn-webhooks/src/index.ts packages/authn-webhooks/test/payload.test.ts packages/authn-webhooks/test/deliverer.test.ts packages/authn-webhooks/test/job.test.ts
git add packages/authn-webhooks/src/payload.ts packages/authn-webhooks/src/delivery/deliverer.ts packages/authn-webhooks/src/delivery/job.ts packages/authn-webhooks/src/index.ts packages/authn-webhooks/test/payload.test.ts packages/authn-webhooks/test/deliverer.test.ts packages/authn-webhooks/test/job.test.ts
git diff --cached --name-only
git commit -m "feat(authn-webhooks): the AuthnWebhookDelivery job signs and posts at send time, retried by the transport"
```

---

### Task 5: Dispatcher and `WebhookAuthnEventSink` (enqueue side, boot checks)

**Files:**
- Create: `packages/authn-webhooks/src/dispatch/dispatcher.ts`, `src/dispatch/sink.ts`, `test/support/queue.ts`, `test/dispatcher.test.ts`
- Modify: `packages/authn-webhooks/src/index.ts`

**Interfaces:**
- Consumes: `WebhooksConfig`, `WebhookEndpointConfig`, `AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA` (Task 1); `bareHost`, `isBlockedAddress` (Task 3); `newMessageId`, `subscribes`, `webhookBody`, `webhookPayload`, `webhookType`, `AUTHN_WEBHOOK_JOB`, `deliveryJob`, `AuthnWebhookDelivery` (Task 4); `AuthnAudit`, `AUTHN_CONFIGURATION_SCHEMA`, `auditLog`, `authnAppEnv`, `isLenientAuthnEnv` (`@spinajs/authn`); `QueueService`, `BlackHoleQueueClient`, `QueueMessageType` (`@spinajs/queue`).
- Produces:
  - `endpointUrlProblems(endpoints: readonly WebhookEndpointConfig[], lenient: boolean): string[]`
  - `interface DispatcherOptions { queue?: QueueService; log?: AuditLog; newId?: () => string }`
  - `class AuthnWebhookDispatcher extends AsyncService` (`@PerChildInstance() @Inject(Container)`, `constructor(container, options?)`): `resolve()` (boot checks), `dispatch(e: AuthnEvent): Promise<void>` (never rejects)
  - `class WebhookAuthnEventSink extends AuthnEventSink` (`@PerChildInstance() @Injectable(AuthnEventSink) @Inject(AuthnWebhookDispatcher)`)
  - Test support: `FakeQueueService` (static `built`, `emitted`, `failWith`, `clients` with `jobs` and `black-hole`), `DurableTestClient`

- [ ] **Step 1: Write the failing tests**

`packages/authn-webhooks/test/support/queue.ts`:

```ts
import { BlackHoleQueueClient, QueueService } from '@spinajs/queue';
import type { IQueueMessage, QueueClient, QueueEvent, QueueJob } from '@spinajs/queue';

/** Not named BlackHoleQueueClient, so the dispatcher counts it as durable. */
export class DurableTestClient extends BlackHoleQueueClient {}

const options = (name: string) => ({ name, transport: 'test', type: 'job' as const });

/** Records what is emitted. DI builds it with no arguments; `built` finds the instance DI made. */
export class FakeQueueService extends QueueService {
  public static readonly built: FakeQueueService[] = [];

  public readonly emitted: IQueueMessage[] = [];
  public failWith: Error | undefined;
  public readonly clients: Record<string, QueueClient> = {
    jobs: new DurableTestClient(options('jobs')),
    'black-hole': new BlackHoleQueueClient(options('black-hole')),
  };

  constructor() {
    super();
    FakeQueueService.built.push(this);
  }

  public async emit(message: IQueueMessage | QueueEvent | QueueJob): Promise<string | undefined> {
    if (this.failWith) throw this.failWith;
    this.emitted.push(message);
    return undefined;
  }

  public async consume(): Promise<void> {}

  public async stopConsuming(): Promise<void> {}

  public get(connection?: string): QueueClient {
    return this.clients[connection ?? this.Configuration.default];
  }
}
```

`packages/authn-webhooks/test/dispatcher.test.ts`:

```ts
import 'mocha';
import assert from 'node:assert/strict';
import type { Class } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { QueueService } from '@spinajs/queue';
import { AUTHN_CONFIGURATION_SCHEMA, AuthnAudit } from '@spinajs/authn';
import type { AuthnEvent } from '@spinajs/authn/contracts';

import { AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA, AuthnWebhookDispatcher, WebhookAuthnEventSink } from '../src/index.js';
import type { AuthnWebhookDelivery } from '../src/index.js';
import { bootChild, disposeChildren, endpoint, pin } from './support/config.js';
import { FakeQueueService } from './support/queue.js';

const LOGIN: AuthnEvent = {
  type: 'login',
  at: new Date('2026-10-06T10:00:00.000Z'),
  outcome: 'success',
  identity: { type: 'user', id: 'u-1' },
  strategy: 'local',
  ip: '203.0.113.9',
  userAgent: 'UA',
  data: { k: 1 },
};

const QUEUE = { default: 'jobs', connections: [] };

const QueueKey = QueueService as unknown as Class<QueueService>;

const jobsOf = (q: FakeQueueService): AuthnWebhookDelivery[] => q.emitted as unknown as AuthnWebhookDelivery[];

describe('AuthnWebhookDispatcher and WebhookAuthnEventSink', () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
  });

  afterEach(disposeChildren);

  interface Setup {
    readonly queue?: Record<string, unknown>;
    readonly env?: string;
    readonly fake?: FakeQueueService;
  }

  async function dispatcher(endpoints: Record<string, unknown>[], setup: Setup = {}): Promise<{ d: AuthnWebhookDispatcher; queue: FakeQueueService }> {
    const child = await bootChild({ authn: { webhooks: { endpoints } }, queue: setup.queue ?? QUEUE }, { env: setup.env });
    const queue = pin(setup.fake ?? new FakeQueueService(), child);
    const log = {
      info: () => undefined,
      warn: (m: string) => {
        warnings.push(m);
      },
    };
    const d = pin(new AuthnWebhookDispatcher(child, { queue, log, newId: () => 'msg_1' }), child);
    await d.resolve();
    return { d, queue };
  }

  it('enqueues one durable job per subscribed endpoint, all with one webhook id', async () => {
    const { d, queue } = await dispatcher([endpoint({ name: 'a', events: ['login'] }), endpoint({ name: 'b', events: ['*'] }), endpoint({ name: 'c', events: ['logout'] })]);
    await d.dispatch(LOGIN);
    assert.deepStrictEqual(
      jobsOf(queue).map((j) => [j.Name, j.Endpoint, j.MessageId, j.EventType, j.RetryCount, j.Persistent]),
      [
        ['AuthnWebhookDelivery', 'a', 'msg_1', 'authn.login', 7, true],
        ['AuthnWebhookDelivery', 'b', 'msg_1', 'authn.login', 7, true],
      ],
    );
  });

  it("applies each endpoint's privacy switches to its own body", async () => {
    const { d, queue } = await dispatcher([endpoint({ name: 'a' }), endpoint({ name: 'b', includeData: true, includeClientInfo: true })]);
    await d.dispatch(LOGIN);
    const [a, b] = jobsOf(queue).map((j) => (JSON.parse(j.Body) as { data: Record<string, unknown> }).data);
    assert.deepStrictEqual([a.ip, a.userAgent, a.data], [undefined, undefined, undefined]);
    assert.deepStrictEqual([b.ip, b.userAgent, b.data], ['203.0.113.9', 'UA', { k: 1 }]);
  });

  it('without endpoints it checks no route and enqueues nothing', async () => {
    const { d, queue } = await dispatcher([], { queue: { default: 'black-hole' } });
    await d.dispatch(LOGIN);
    assert.deepStrictEqual(queue.emitted, []);
  });

  it('logs an enqueue failure with the endpoint name and error class, and does not throw', async () => {
    const fake = new FakeQueueService();
    fake.failWith = new RangeError('broker refused: password=hunter2');
    const { d } = await dispatcher([endpoint({ name: 'a' })], { fake });
    await d.dispatch(LOGIN);
    assert.deepStrictEqual(warnings, ['authn-webhooks: could not enqueue a "authn.login" delivery for endpoint "a" (RangeError)']);
  });

  it('fails the boot when the job would be discarded or has no connection', async () => {
    await assert.rejects(dispatcher([endpoint()], { queue: { default: 'black-hole' } }), (e: Error) => e instanceof InvalidOption && e.message.includes('connection "black-hole", a BlackHoleQueueClient'));
    await assert.rejects(dispatcher([endpoint()], { queue: { default: 'jobs', routing: { AuthnWebhookDelivery: { connection: 'black-hole' } } } }), /BlackHoleQueueClient/);
    await assert.rejects(dispatcher([endpoint()], { queue: { default: 'jobs', routing: { AuthnWebhookDelivery: { connection: 'nowhere' } } } }), /connection "nowhere", which is not configured/);
  });

  it('fails the boot on an http endpoint outside development and test, naming the endpoint but not the URL', async () => {
    const http = endpoint({ url: 'http://hooks.example.com/authn?token=abc' });
    await assert.rejects(
      dispatcher([http], { env: 'production' }),
      (e: Error) => e instanceof InvalidOption && e.message.includes('authn.webhooks.endpoints.0.url (endpoint "crm") must use https') && !e.message.includes('token=abc'),
    );
    await dispatcher([http], { env: 'test' });
  });

  it('fails the boot on a private IP literal unless the endpoint allows private networks', async () => {
    await assert.rejects(dispatcher([endpoint({ url: 'https://10.0.0.5/hook' })]), /private, loopback, link-local or reserved/);
    await assert.rejects(dispatcher([endpoint({ url: 'https://169.254.169.254/latest' })]), /private, loopback, link-local or reserved/);
    await dispatcher([endpoint({ url: 'https://10.0.0.5/hook', allowPrivateNetworks: true })]);
  });

  it('the sink hands every event to the dispatcher', async () => {
    const { d, queue } = await dispatcher([endpoint()]);
    await new WebhookAuthnEventSink(d).publish(LOGIN);
    assert.strictEqual(jobsOf(queue).length, 1);
  });

  it("AuthnAudit builds the sink in its container and enqueues through that container's QueueService", async () => {
    FakeQueueService.built.splice(0);
    const child = await bootChild({ authn: { webhooks: { endpoints: [endpoint()] } }, queue: QUEUE }, { schemas: [AUTHN_CONFIGURATION_SCHEMA, AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA] });
    child.register(FakeQueueService).as(QueueKey);
    const audit = await child.resolve(AuthnAudit);
    assert.ok(audit.sinks().some((s) => s instanceof WebhookAuthnEventSink));
    await audit.publish(LOGIN);
    const queue = FakeQueueService.built[FakeQueueService.built.length - 1];
    assert.deepStrictEqual(
      jobsOf(queue).map((j) => j.Endpoint),
      ['crm'],
    );
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/dispatcher.test.ts`
Expected: FAIL at compile time: `Module '"../src/index.js"' has no exported member 'AuthnWebhookDispatcher'` (and the same for `WebhookAuthnEventSink`).

- [ ] **Step 3: Implement**

`packages/authn-webhooks/src/dispatch/dispatcher.ts`:

```ts
import { isIP } from 'node:net';
import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { QueueMessageType, QueueService } from '@spinajs/queue';
import type { IQueueMessage, QueueClient } from '@spinajs/queue';
import { auditLog, authnAppEnv, isLenientAuthnEnv } from '@spinajs/authn';
import type { AuditLog } from '@spinajs/authn';
import type { AuthnEvent } from '@spinajs/authn/contracts';

import { AUTHN_WEBHOOK_JOB, deliveryJob } from '../delivery/job.js';
import { bareHost, isBlockedAddress } from '../http/address.js';
import { newMessageId, subscribes, webhookBody, webhookPayload, webhookType } from '../payload.js';
import type { WebhookEndpointConfig, WebhooksConfig } from '../schema.js';

export interface DispatcherOptions {
  readonly queue?: QueueService;
  readonly log?: AuditLog;
  readonly newId?: () => string;
}

const q = (v: string): string => JSON.stringify(v);

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/** Boot findings on the endpoint URLs. They name the endpoint, never the URL: it may carry a token. */
export function endpointUrlProblems(endpoints: readonly WebhookEndpointConfig[], lenient: boolean): string[] {
  const out: string[] = [];
  endpoints.forEach((e, i) => {
    const at = `authn.webhooks.endpoints.${i}.url (endpoint ${q(e.name)})`;
    let url: URL;
    try {
      url = new URL(e.url);
    } catch {
      out.push(`${at} is not a valid URL`);
      return;
    }
    if (url.protocol === 'http:' && !lenient) out.push(`${at} must use https outside development and test`);
    const host = bareHost(url);
    if (isIP(host) !== 0 && !e.allowPrivateNetworks && isBlockedAddress(host)) {
      out.push(`${at} is a private, loopback, link-local or reserved address; set allowPrivateNetworks on the endpoint to allow it`);
    }
  });
  return out;
}

// By name: a client built from another copy of @spinajs/queue (cjs and mjs) fails instanceof.
const isBlackHole = (c: QueueClient): boolean => c.constructor?.name === 'BlackHoleQueueClient';

/**
 * Enqueues one AuthnWebhookDelivery per subscribed endpoint and sends nothing itself, so a login waits for the enqueue
 * only. Boot fails when endpoints are configured but the job has no durable route, or a URL is not allowed in this env.
 * One per container, like AuthnAudit.
 */
@PerChildInstance()
@Inject(Container)
export class AuthnWebhookDispatcher extends AsyncService {
  @Config('authn.webhooks')
  protected Config: WebhooksConfig;

  private endpoints: readonly WebhookEndpointConfig[] = [];
  private maxAttempts = 1;
  private queue: QueueService | undefined;
  private readonly log: AuditLog;
  private readonly newId: () => string;

  /** `options` is for tests; DI passes only the container. */
  constructor(
    private readonly container: IContainer,
    private readonly options: DispatcherOptions = {},
  ) {
    super();
    this.log = options.log ?? auditLog('authn-webhooks');
    this.newId = options.newId ?? newMessageId;
  }

  public async resolve(): Promise<void> {
    const config = this.Config;
    if (!config) throw new InvalidOperation('authn.webhooks is unset: AUTHN_WEBHOOKS_CONFIGURATION_SCHEMA is not registered');
    // A snapshot: the boot checks below hold for these endpoints only.
    const endpoints = Object.freeze([...config.endpoints]);
    if (endpoints.length > 0) {
      const lenient = isLenientAuthnEnv(authnAppEnv(this.container.get(Configuration) as Configuration));
      const problems = endpointUrlProblems(endpoints, lenient);
      if (problems.length > 0) throw new InvalidOption(`authn.webhooks: ${problems.join('; ')}`);
      const queue = this.options.queue ?? (await this.container.resolve(QueueService as unknown as Class<QueueService>));
      this.checkRoute(queue);
      this.queue = queue;
    }
    this.endpoints = endpoints;
    this.maxAttempts = config.maxAttempts;
    await super.resolve();
  }

  /** Never rejects: an enqueue failure is logged per endpoint. */
  public async dispatch(e: AuthnEvent): Promise<void> {
    const targets = this.endpoints.filter((ep) => subscribes(ep.events, e.type));
    if (targets.length === 0) return;
    const id = this.newId();
    await Promise.all(targets.map((ep) => this.enqueue(ep, id, e)));
  }

  private async enqueue(endpoint: WebhookEndpointConfig, id: string, e: AuthnEvent): Promise<void> {
    const type = webhookType(e.type);
    try {
      const body = webhookBody(webhookPayload(e, id, endpoint));
      await this.queue!.emit(deliveryJob({ endpoint: endpoint.name, messageId: id, eventType: type, body, maxAttempts: this.maxAttempts }));
    } catch (err) {
      // AuthnAudit would name only this sink; the endpoint tells the operator which delivery is missing.
      this.log.warn(`authn-webhooks: could not enqueue a ${q(type)} delivery for endpoint ${q(endpoint.name)} (${errorName(err)})`);
    }
  }

  private checkRoute(queue: QueueService): void {
    const probe = { Name: AUTHN_WEBHOOK_JOB, Type: QueueMessageType.Job } as IQueueMessage;
    let names: string[];
    try {
      // Protected on QueueService; calling it keeps the routing rules in one place.
      names = (queue as unknown as { getConnectionsForMessage(m: IQueueMessage): string[] }).getConnectionsForMessage(probe);
    } catch (err) {
      throw new InvalidOption(`authn.webhooks: cannot route the ${AUTHN_WEBHOOK_JOB} job (${errorName(err)}); configure queue.default and queue.connections`);
    }
    for (const name of names) {
      const client = queue.get(name) as QueueClient | undefined;
      if (!client) {
        throw new InvalidOption(`authn.webhooks: the ${AUTHN_WEBHOOK_JOB} job routes to queue connection ${q(name)}, which is not configured; route it to a durable connection in queue.routing.${AUTHN_WEBHOOK_JOB}`);
      }
      if (isBlackHole(client)) {
        throw new InvalidOption(`authn.webhooks: the ${AUTHN_WEBHOOK_JOB} job routes to queue connection ${q(name)}, a BlackHoleQueueClient that discards it; route it to a durable connection in queue.routing.${AUTHN_WEBHOOK_JOB}`);
      }
    }
  }
}
```

`packages/authn-webhooks/src/dispatch/sink.ts`:

```ts
import { Inject, Injectable, PerChildInstance } from '@spinajs/di';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';

import { AuthnWebhookDispatcher } from './dispatcher.js';

/** AuthnEventSink cannot be an AsyncService, so the boot checks run in the injected dispatcher. */
@PerChildInstance()
@Injectable(AuthnEventSink)
@Inject(AuthnWebhookDispatcher)
export class WebhookAuthnEventSink extends AuthnEventSink {
  constructor(private readonly dispatcher: AuthnWebhookDispatcher) {
    super();
  }

  public async publish(e: AuthnEvent): Promise<void> {
    await this.dispatcher.dispatch(e);
  }
}
```

`packages/authn-webhooks/src/index.ts`:

```ts
export * from './schema.js';
export * from './signature/index.js';
export * from './http/address.js';
export * from './http/poster.js';
export * from './payload.js';
export * from './delivery/deliverer.js';
export * from './delivery/job.js';
export * from './dispatch/dispatcher.js';
export * from './dispatch/sink.js';
```

- [ ] **Step 4: GREEN + suite + build**

1. `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/dispatcher.test.ts`. Expected: 9 passing. `LogAuthnAuditSink` prints one `authn audit login success …` line to the console in the last test. That is expected: no `Log` is registered.
2. If the last test fails because `child.resolve(AuthnAudit)` resolves the root's `DefaultQueueService` instead of the child's fake, the child registration did not win. Register the fake before the Configuration (move the `register` line into a `bootChild` variant that registers it right after creating the child). Do not change the dispatcher.
3. `npm test`. Expected: 46 passing.
4. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
node -e "const fs=require('fs');for(const f of process.argv.slice(1)){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))}" packages/authn-webhooks/src/dispatch/dispatcher.ts packages/authn-webhooks/src/dispatch/sink.ts packages/authn-webhooks/src/index.ts packages/authn-webhooks/test/support/queue.ts packages/authn-webhooks/test/dispatcher.test.ts
git add packages/authn-webhooks/src/dispatch/dispatcher.ts packages/authn-webhooks/src/dispatch/sink.ts packages/authn-webhooks/src/index.ts packages/authn-webhooks/test/support/queue.ts packages/authn-webhooks/test/dispatcher.test.ts
git diff --cached --name-only
git commit -m "feat(authn-webhooks): WebhookAuthnEventSink enqueues one delivery per endpoint and refuses a boot without a durable route"
```

---

### Task 6: `authn:webhook-test` CLI and documentation

**Files:**
- Create: `packages/authn-webhooks/src/cli/WebhookTest.ts`, `src/cli/index.ts`, `src/config/authn-webhooks.ts`, `test/cli.test.ts`, `README.md`
- Modify: `docs/authn/README.md:527` (new bullet after it) and `docs/authn/README.md:641` (new row after it)

**Interfaces:**
- Consumes: `AuthnWebhookDeliverer.ping(name): Promise<number>` (Task 4); `Command`, `Argument`, `CliCommand` (`@spinajs/cli`); `Log`, `Logger` (`@spinajs/log`).
- Produces: `class WebhookTest extends CliCommand` (`authn:webhook-test <name>`), default export of `src/config/authn-webhooks.ts` (`{ system: { dirs: { cli: string[] } } }`).

- [ ] **Step 1: Write the failing test**

`packages/authn-webhooks/test/cli.test.ts`:

```ts
import 'mocha';
import assert from 'node:assert/strict';

import { WebhookTest } from '../src/cli/index.js';
import webhooksConfig from '../src/config/authn-webhooks.js';

function command(ping: (name: string) => Promise<number>): { cmd: WebhookTest; out: string[] } {
  const out: string[] = [];
  const cmd = new WebhookTest();
  Object.defineProperty(cmd, 'Log', { value: { success: (m: string) => out.push(m) } });
  Object.defineProperty(cmd, 'Deliverer', { value: { ping } });
  return { cmd, out };
}

describe('authn:webhook-test', () => {
  it('pings the named endpoint and prints the status', async () => {
    const names: string[] = [];
    const { cmd, out } = command(async (name) => {
      names.push(name);
      return 204;
    });
    await cmd.execute('crm');
    assert.deepStrictEqual([names, out], [['crm'], ['Endpoint "crm" answered HTTP 204']]);
  });

  it('lets a failed ping fail the command', async () => {
    const { cmd } = command(async () => {
      throw new Error('authn-webhooks: endpoint "crm" answered HTTP 500');
    });
    await assert.rejects(cmd.execute('crm'), /answered HTTP 500/);
  });

  it('the package configuration adds its CLI directory', () => {
    assert.ok(webhooksConfig.system.dirs.cli.length > 0);
    assert.ok(webhooksConfig.system.dirs.cli.every((d) => d.replace(/\\/g, '/').includes('/@spinajs/authn-webhooks/lib/')));
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/cli.test.ts`
Expected: FAIL. The file does not load: `Cannot find module '../src/cli/index.js'`.

- [ ] **Step 3: Implement**

`packages/authn-webhooks/src/cli/WebhookTest.ts`:

```ts
import { Autoinject } from '@spinajs/di';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log';

import { AuthnWebhookDeliverer } from '../delivery/deliverer.js';

@Command('authn:webhook-test', 'Sends a signed authn.ping to one webhook endpoint at once, bypassing the queue, and prints the answer')
@Argument('name', true, 'endpoint name (authn.webhooks.endpoints[].name)')
export class WebhookTest extends CliCommand {
  @Logger('authn-webhooks')
  protected Log: Log;

  @Autoinject(AuthnWebhookDeliverer)
  protected Deliverer: AuthnWebhookDeliverer;

  public async execute(name: string): Promise<void> {
    const status = await this.Deliverer.ping(name);
    this.Log.success(`Endpoint ${JSON.stringify(name)} answered HTTP ${status}`);
  }
}
```

`packages/authn-webhooks/src/cli/index.ts`:

```ts
export * from './WebhookTest.js';
```

`packages/authn-webhooks/src/config/authn-webhooks.ts`:

```ts
import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-webhooks', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'authn-webhooks', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

// Only the CLI scan dir: the authn.webhooks defaults live in the schema.
const authnWebhooks = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
};

export default authnWebhooks;
```

`packages/authn-webhooks/README.md`:

````markdown
# @spinajs/authn-webhooks

Signed outbound webhooks on authn events, per [Standard Webhooks](https://www.standardwebhooks.com).

## How it works

- `WebhookAuthnEventSink` gets every `AuthnEvent` (A21). For each endpoint that subscribes to the event type, it
  enqueues one `AuthnWebhookDelivery` job. A login waits only for the enqueue, never for HTTP.
- A queue worker runs the job. It signs the body with the endpoint's current secrets and POSTs it. An answer
  outside 2xx, a timeout (`timeoutMs`, default 5 s) or a refused target fails the attempt. The queue transport retries it
  `maxAttempts - 1` times with the backoff of its connection, then dead-letters it. Every attempt is logged with
  the endpoint name, never with the payload.
- `webhook-id` is the same on every attempt. Receivers dedupe on it. `webhook-timestamp` is the attempt time, and
  the payload `timestamp` is the event time.

## Configuration

```ts
authn: {
  webhooks: {
    endpoints: [
      {
        name: 'crm',
        url: 'https://crm.example.com/hooks/authn',
        // A secret reference to a whsec_ value (24+ bytes, base64). During a rotation, list the old one in `previous`.
        secret: { secret: 'aws-parameters://prod/authn/webhooks/crm', previous: [{ secret: 'aws-parameters://prod/authn/webhooks/crm-old' }] },
        events: ['login', 'password.reset', 'mfa.enrol'], // or ['*']
        includeData: false,        // event `data`
        includeClientInfo: false,  // IP and user agent
        allowPrivateNetworks: false,
      },
    ],
    maxAttempts: 8,
    timeoutMs: 5000,
  },
}
```

- `url` must be https outside development and test. Credentials in the URL are refused.
- The endpoint's host must not resolve to a private, loopback, link-local (cloud metadata), CGNAT, multicast or
  reserved address, unless `allowPrivateNetworks` is set on that endpoint. The check runs when the socket connects.
  Redirects are not followed, and the answer body is never read.

## Queue

Boot fails when endpoints are configured but `AuthnWebhookDelivery` routes to the default `BlackHoleQueueClient` or
to a connection that does not exist. Route it to a durable connection of its own. With AMQP or STOMP,
`retryDelay: 680000` and `maxAttempts: 8` retry after about 11 min, 23 min, 45 min, 1.5 h, 3 h, 6 h and 12 h (about 24 h in all):

```ts
queue: {
  routing: {
    AuthnWebhookDelivery: { connection: 'webhooks', channel: '/queue/authn-webhooks', deadLetterChannel: '/queue/authn-webhooks.dead' },
  },
  connections: [
    { service: 'StompQueueClient', name: 'webhooks', host: 'ws://broker:61614/ws', retryDelay: 680000 },
  ],
}
```

SQS ignores `maxAttempts`. Set the redrive policy's `maxReceiveCount` and the visibility timeout on the queue instead.
`authn.audit.sinkTimeoutMs` (default 2000) bounds the enqueue. A broker slower than that makes the audit log a sink
timeout, but the job is still enqueued.

A worker process consumes the job:

```ts
import { DI } from '@spinajs/di';
import { QueueService } from '@spinajs/queue';
import { AuthnWebhookDelivery } from '@spinajs/authn-webhooks';

await (await DI.resolve(QueueService)).consume(AuthnWebhookDelivery);
```

## Payload

```json
{ "id": "msg_…", "type": "authn.login", "timestamp": "2026-10-06T10:00:00.000Z",
  "data": { "outcome": "success", "identity": { "type": "user", "id": "…" }, "actor": { "type": "user", "id": "…" },
            "strategy": "local", "reason": "…", "session": "<hashed handle>" } }
```

`data.data`, `data.ip` and `data.userAgent` appear only when the endpoint opts in. Events never carry passwords,
tokens, secrets or raw session ids (A21).

## Receiving

Import the verifier from the `verify` subpath. It registers no DI service:

```ts
import { verifyWebhook, WebhookVerificationError } from '@spinajs/authn-webhooks/verify';

// `rawBody` is the request body as received (Buffer or string), never a re-serialised parse.
const { id } = verifyWebhook(rawBody, req.headers, [process.env.CRM_WEBHOOK_SECRET!]);
// dedupe on `id`; a WebhookVerificationError (reason 'headers' | 'timestamp' | 'signature') means 400
```

It compares signatures in constant time and refuses a timestamp more than 5 minutes away.

## CLI

`authn:webhook-test <name>` sends a signed `authn.ping` to one endpoint at once, without the queue, and prints the
status. Use it to check the URL, the secret and the network path.
````

In `docs/authn/README.md`, after line 527 (`- The DB sink never fails on event content: an identity that does not fit the column goes into \`data\`.`), add:

```markdown
- `@spinajs/authn-webhooks` adds `WebhookAuthnEventSink`. For each endpoint of `authn.webhooks.endpoints` that
  subscribes to the event type, it enqueues one delivery signed per Standard Webhooks. It never sends during the login:
  a queue worker sends and retries. Boot fails when the delivery job has no durable queue route. See
  `packages/authn-webhooks/README.md`.
```

After line 641 (the `| \`authn.audit.*\` | …` row), add:

```markdown
| `authn.webhooks.*` | `authn-webhooks` | `endpoints` (name, https URL, `whsec_` secret reference, events, privacy switches), `maxAttempts` (default 8), `timeoutMs` (default 5000). The queue connection's `retryDelay` sets the backoff. |
```

- [ ] **Step 4: GREEN + suite + build**

1. `cd packages/authn-webhooks && npx ts-mocha -p tsconfig.json test/cli.test.ts`. Expected: 3 passing.
2. `npm test`. Expected: 49 passing.
3. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: exit code 0, and `lib/mjs/cli/WebhookTest.js` exists.

- [ ] **Step 5: Commit**

```bash
node -e "const fs=require('fs');for(const f of process.argv.slice(1)){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))}" packages/authn-webhooks/src/cli/WebhookTest.ts packages/authn-webhooks/src/cli/index.ts packages/authn-webhooks/src/config/authn-webhooks.ts packages/authn-webhooks/test/cli.test.ts packages/authn-webhooks/README.md docs/authn/README.md
git add packages/authn-webhooks/src/cli/WebhookTest.ts packages/authn-webhooks/src/cli/index.ts packages/authn-webhooks/src/config/authn-webhooks.ts packages/authn-webhooks/test/cli.test.ts packages/authn-webhooks/README.md docs/authn/README.md
git diff --cached --name-only
git commit -m "feat(authn-webhooks): authn:webhook-test and the package documentation"
```

`docs/authn/README.md` may hold other agents' unstaged edits. If `git diff docs/authn/README.md` shows more than your two hunks, stage with `git add -p docs/authn/README.md`.

---

## Self-review

**Spec coverage**

| Brief item | Where |
|---|---|
| `AuthnEventSink` implementation in a new `packages/authn-webhooks` | Task 1 (package), Task 5 (`WebhookAuthnEventSink`) |
| Never slow or fail a login; the sink only enqueues | Task 5 (`dispatch` never rejects, no HTTP on that path); Decision 1 |
| No queue configured: decide and justify | Decision 1; Task 5 boot checks (black-hole, missing connection) |
| Retries, exponential backoff, jitter, ~8 attempts over ~24 h, dead letter | Task 4 (`RetryCount = maxAttempts − 1`, `onFailed` logging, final "giving up"); README queue section; Decision 2 (no jitter: transport-owned) |
| Circuit breaker (optional) | Decision 2: YAGNI |
| Standard Webhooks headers and `v1,<base64 HMAC>` | Task 2 (reference vector test) |
| `whsec_` secret refs and rotation with several signatures | Task 1 (schema, `previous` objects), Task 2, Task 4 rotation test |
| Verifier for receivers: 5 min tolerance, constant time | Task 2 (`verifyWebhook`, `/verify` subpath) |
| Config `authn.webhooks.endpoints` via `@Config` + schema | Task 1 schema, `@Config` in Tasks 4 and 5 |
| https only outside dev/test | Task 5 boot check (`endpointUrlProblems`), Task 4 send check (`allowHttp`) |
| SSRF guard: DNS, private/loopback/link-local/metadata/fc00::/7; `allowPrivateNetworks` | Task 3 (`isBlockedAddress`, `guardedLookup`), Task 5 IP-literal boot check |
| No redirects, body ignored, 5 s timeout | Task 3 tests, `timeoutMs` default 5000 |
| Payload shape and privacy (`includeClientInfo`, `includeData`), `authn.<type>` | Task 4 payload tests, Task 5 per-endpoint body test |
| Idempotency: stable webhook-id | Task 4 (same id over attempts), Task 5 (one id per event) |
| Observability: failures logged with the endpoint name, no payload | Task 4 (`failed`, `dropped`), Task 5 (enqueue warning) |
| Metrics through telemetry (optional) | Decision 9: deferred; fact: counter API is in telemetry-common |
| CLI `authn:webhook-test <name>` | Task 6 |
| Tests: local http server, fake queue, clock control | `test/support/server.ts`, `test/support/queue.ts`, `now` seams in the deliverer and `opts.now` in the verifier |

**Placeholder scan.** Every code step shows complete files, and no step defers work. The two conditional notes (the duplicate-name path in Task 1 and the DI fallback in Task 5) say exactly what to do.

**Type consistency.**
- `DeliveryData` field names (`Endpoint`, `MessageId`, `EventType`, `Body`) are the same in `deliverer.ts`, `job.ts`, `deliveryJob` and the tests.
- `WebhookSecretConfig.previous` is `{ secret }[]` in the schema, in `deliverer.send` and in the tests.
- `WebhookPoster.post(url, headers, body, opts)` matches `GuardedWebhookPoster`, the deliverer call and the fake poster.
- `webhookPayload(e, id, opts, now?)` takes an endpoint config as `opts` structurally.
- `AUTHN_WEBHOOK_JOB` equals the class name and is asserted in the job test.
- `AuditLog` (`info`, `warn`) is the log type of both the deliverer and the dispatcher.
