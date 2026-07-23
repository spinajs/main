# Telemetry HTTP API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@spinajs/telemetry` a routed, policy-guarded, OpenAPI-documented HTTP API (`/metrics`, `/telemetry/stats|timeline|routes|perf|health|ready`) and delete the superseded `@spinajs/metrics` package.

**Architecture:** All observability collapses into `@spinajs/telemetry`. Its existing private `prom-client` registry becomes the single source for the scrape endpoint; the token policy and `/metrics` controller move over from `@spinajs/metrics`, which is then deleted along with `express-prom-bundle`. Two new bounded collectors (per-route `RequestStats` in the middleware, an `InMemoryPerfSink` alongside the prom one) back the JSON views that prom histograms cannot serve. Health is a `HealthCheck` abstraction with a timeout-raced runner and zero shipped checks.

**Tech Stack:** TypeScript (ESM, `node16` module resolution), `@spinajs/di`, `@spinajs/http`, `@spinajs/log`, `@spinajs/configuration`, `@spinajs/validation`, `prom-client` 14, mocha + chai + sinon + chai-http, ts-mocha.

**Spec:** `docs/superpowers/specs/2026-07-23-telemetry-http-api-design.md`

## Global Constraints

- Package under change: `packages/telemetry`. Every path below is relative to the repo root `c:\Users\grzch\SourceCodes\Spinajs-Agent-4\main`.
- ESM only. Every relative import **must** carry a `.js` extension (`./metrics.js`), even from a `.ts` file. `node16` resolution rejects extensionless relative imports.
- Cross-package imports resolve through the **compiled** `lib/`, not `src/`. After changing `packages/http`, run `npm run compile` in that package before any telemetry test that depends on the change.
- Run tests from inside the package directory: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/<file>.test.ts`.
- Test style, matching `packages/telemetry/test/middleware.test.ts`: `import 'mocha'`, `import { expect } from 'chai'`, `import sinon from 'sinon'`, imports from `./../src/...js`.
- Telemetry code must never throw into a request path. All middleware and sink work stays inside `try/catch`.
- Metric label values stay low-cardinality. Never put ids, emails, or raw URLs in a label.
- Comment style in this codebase uses spaces inside parens: `( like this )`. Match it.
- The auth header stays `x-metrics-token` and the scrape path stays `/metrics` — both are load-bearing for existing deployments.
- Commit after every task. Conventional commit prefixes (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).

---

## File Structure

**Created in `packages/telemetry/src/`:**

| File | Responsibility |
|---|---|
| `config/telemetry.ts` | Default config tree + `system.dirs.controllers` registration |
| `policies/TelemetryTokenPolicy.ts` | Token check against `telemetry.auth.token` |
| `policies/PublicPolicy.ts` | Explicit no-op policy for probe endpoints |
| `bootstrap.ts` | `TelemetryBootstrapper` — default metrics + perf sink wiring |
| `responses.ts` | `PrometheusResponse`, `ServiceUnavailable` |
| `health.ts` | `HealthCheck` base, `IHealthResult`, `HealthCheckRunner` |
| `InMemoryPerfSink.ts` | Bounded JSON-readable perf aggregate |
| `routeStats.ts` | Bounded per-route `RequestStats` map |
| `controllers/Metrics.ts` | `GET /metrics` |
| `controllers/Telemetry.ts` | The six JSON endpoints |
| `schemas/*.schema.ts` | JSON schemas for the response DTOs |
| `dto/*.ts` | `@Schema`-decorated response DTO classes |

**Modified:**

| File | Change |
|---|---|
| `packages/telemetry/src/metrics.ts` | Add `'summary'` metric type |
| `packages/telemetry/src/middleware.ts` | Config wiring, per-route stats, rate window |
| `packages/telemetry/src/index.ts` | Export the new modules |
| `packages/telemetry/package.json` | New deps |
| `packages/telemetry/tsconfig*.json` | New project references |
| `packages/telemetry/README.md` | Endpoints, config, migration |
| `packages/http/src/interfaces.ts` | `SERVICE_UNAVAILABLE = 503` |

**Deleted:** `packages/metrics/` (entire directory), in the final task only.

---

## Task 1: Package scaffolding — deps, config, policies

**Files:**
- Modify: `packages/telemetry/package.json`
- Modify: `packages/telemetry/tsconfig.json`, `packages/telemetry/tsconfig.mjs.json`, `packages/telemetry/tsconfig.cjs.json`
- Create: `packages/telemetry/src/config/telemetry.ts`
- Create: `packages/telemetry/src/policies/TelemetryTokenPolicy.ts`
- Create: `packages/telemetry/src/policies/PublicPolicy.ts`
- Modify: `packages/telemetry/src/index.ts`
- Test: `packages/telemetry/test/policies.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TelemetryTokenPolicy` and `PublicPolicy` classes (both `extends BasePolicy`, registered `@Injectable(BasePolicy)`); the default config object at config key `telemetry`.

- [ ] **Step 1: Add the new dependencies**

Edit `packages/telemetry/package.json`, `dependencies` block — add three entries alongside the existing ones (keep the block alphabetical):

```json
  "dependencies": {
    "@spinajs/configuration": "^2.0.481",
    "@spinajs/configuration-common": "^2.0.481",
    "@spinajs/di": "^2.0.481",
    "@spinajs/exceptions": "^2.0.481",
    "@spinajs/http": "^2.0.481",
    "@spinajs/log": "^2.0.481",
    "@spinajs/validation": "^2.0.481",
    "lodash": "^4.17.21",
    "prom-client": "^14.2.0"
  }
```

- [ ] **Step 2: Add the matching tsconfig project references**

In `packages/telemetry/tsconfig.json`, `packages/telemetry/tsconfig.mjs.json` and `packages/telemetry/tsconfig.cjs.json`, extend the `references` array so it reads:

```json
  "references": [
    { "path": "../configuration-common/tsconfig.json" },
    { "path": "../configuration/tsconfig.json" },
    { "path": "../di/tsconfig.json" },
    { "path": "../exceptions/tsconfig.json" },
    { "path": "../log/tsconfig.json" },
    { "path": "../http/tsconfig.json" },
    { "path": "../validation/tsconfig.json" }
  ],
```

(The `.mjs`/`.cjs` variants may list references in a different order or shape — add the missing three, do not reorder what is there.)

- [ ] **Step 3: Write the failing policy test**

Create `packages/telemetry/test/policies.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Forbidden } from '@spinajs/exceptions';

import { TelemetryTokenPolicy, PublicPolicy } from './../src/index.js';

/**
 * The policies read their token / dev flag from @Config properties. Rather than
 * booting a Configuration, assign them directly — @Config is a plain property
 * decorator and the fields are protected, so cast through any.
 */
function makeTokenPolicy(token: string, isDev: boolean) {
  const p = new TelemetryTokenPolicy();
  const anyP = p as any;
  anyP.Token = token;
  anyP.isDev = isDev;
  anyP.Log = { warn: () => undefined };
  return p;
}

function fakeReq(headers: Record<string, string> = {}) {
  return { headers, storage: { realIp: '10.0.0.1' } } as any;
}

describe('TelemetryTokenPolicy', () => {
  it('passes in development regardless of the token', async () => {
    const p = makeTokenPolicy('secret', true);
    await p.execute(fakeReq(), null as any, null as any);
  });

  it('rejects a request with no token', async () => {
    const p = makeTokenPolicy('secret', false);
    let thrown: unknown;
    try {
      await p.execute(fakeReq(), null as any, null as any);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).to.be.instanceOf(Forbidden);
  });

  it('rejects a request with the wrong token', async () => {
    const p = makeTokenPolicy('secret', false);
    let thrown: unknown;
    try {
      await p.execute(fakeReq({ 'x-metrics-token': 'nope' }), null as any, null as any);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).to.be.instanceOf(Forbidden);
  });

  it('accepts a request with the right token on the x-metrics-token header', async () => {
    const p = makeTokenPolicy('secret', false);
    await p.execute(fakeReq({ 'x-metrics-token': 'secret' }), null as any, null as any);
  });

  it('is always enabled', () => {
    expect(makeTokenPolicy('secret', false).isEnabled(null as any, null as any)).to.eq(true);
  });
});

describe('PublicPolicy', () => {
  it('always resolves', async () => {
    await new PublicPolicy().execute(fakeReq(), null as any, null as any);
  });

  it('is always enabled', () => {
    expect(new PublicPolicy().isEnabled(null as any, null as any)).to.eq(true);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/policies.test.ts`
Expected: FAIL — the module has no export named `TelemetryTokenPolicy`.

- [ ] **Step 5: Write `TelemetryTokenPolicy`**

Create `packages/telemetry/src/policies/TelemetryTokenPolicy.ts`:

```ts
import { Config } from '@spinajs/configuration';
import { BasePolicy, IController, IRoute, Request } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Injectable } from '@spinajs/di';

/**
 * Shared-token guard for the telemetry endpoints. Reads the expected token from
 * `telemetry.auth.token` and compares it against the `x-metrics-token` header.
 * The header name is deliberately unchanged from the retired
 * `@spinajs/metrics` package so existing scrape configs keep working.
 *
 * Bypassed entirely in development.
 */
@Injectable(BasePolicy)
export class TelemetryTokenPolicy extends BasePolicy {
  @Logger('Security')
  protected Log: Log;

  @Config('telemetry.auth.token')
  protected Token: string;

  @Config('configuration.isDevelopment')
  protected isDev: boolean;

  protected HEADER_TOKEN_FIELD = 'x-metrics-token';

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    if (this.isDev) {
      return;
    }

    const token = req.headers[this.HEADER_TOKEN_FIELD];
    if (!token) {
      this.Log.warn(`No token is set for restricted area, header field: ${this.HEADER_TOKEN_FIELD}, policy: TelemetryTokenPolicy, ip: ${req.storage.realIp}`);
      throw new Forbidden('access token is not set');
    }

    if (token !== this.Token) {
      this.Log.warn(`Invalid access token received, header field: ${this.HEADER_TOKEN_FIELD}, policy: TelemetryTokenPolicy, ip: ${req.storage.realIp}`);
      throw new Forbidden('invalid access token');
    }
  }
}
```

Note: unlike the retired `DefaultMetricsPolicy`, the received token is **not**
echoed into the log line — logging a rejected credential is how a wrong-but-real
token from another environment ends up in a log aggregator.

- [ ] **Step 6: Write `PublicPolicy`**

Create `packages/telemetry/src/policies/PublicPolicy.ts`:

```ts
import { Injectable } from '@spinajs/di';
import { BasePolicy, IController, IRoute, Request } from '@spinajs/http';

/**
 * A policy that permits everything. Used as the explicit default for the
 * liveness / readiness endpoints, which must be reachable by kubelet probes and
 * load balancers that cannot carry a token.
 *
 * This exists so the config can name a real class. Leaving the policy config
 * key empty would work, but the http layer logs `No policy named ... is
 * registered` on every boot for an unresolvable value, which reads like a
 * misconfiguration.
 */
@Injectable(BasePolicy)
export class PublicPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public execute(_req: Request): Promise<void> {
    return Promise.resolve();
  }
}
```

- [ ] **Step 7: Write the default configuration**

Create `packages/telemetry/src/config/telemetry.ts`:

```ts
import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'telemetry', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

/**
 * Duration histogram bucket boundaries ( ms ) for http request timing. Kept in
 * sync with DURATION_BUCKETS_MS in middleware.ts, which is the compile-time
 * default when no configuration is present.
 */
const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const config = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },

  telemetry: {
    auth: {
      // set this in your project
      token: '',

      /**
       * Policy class name per endpoint. Each route resolves its policy by
       * reading the config key below, so access can be tightened or loosened
       * per endpoint without touching code.
       */
      policies: {
        metrics: 'TelemetryTokenPolicy',
        stats: 'TelemetryTokenPolicy',
        timeline: 'TelemetryTokenPolicy',
        routes: 'TelemetryTokenPolicy',
        perf: 'TelemetryTokenPolicy',

        // probe endpoints must be reachable without credentials
        health: 'PublicPolicy',
        ready: 'PublicPolicy',
      },
    },

    /**
     * Register prom-client's process / heap / cpu / event-loop metrics against
     * the private registry at bootstrap.
     */
    collectDefaultMetrics: true,

    /** Metric name prefix for the http telemetry metrics. */
    prefix: 'http',

    /** Duration histogram buckets in ms. */
    buckets: DURATION_BUCKETS_MS,

    /** Apdex satisfied threshold in ms; tolerated is 4x this. */
    apdexThresholdMs: 25,

    timeline: {
      /** Number of buckets retained in the ring. */
      length: 60,
      /** Bucket width in ms. */
      bucketMs: 60_000,
    },

    routes: {
      enabled: true,
      /** Cap on distinct method+route keys held in memory. */
      maxEntries: 500,
    },

    perf: {
      enabled: true,
      /** Cap on distinct perf measurement names held in memory. */
      maxNames: 200,
    },

    health: {
      /** Per-check timeout in ms. A timed-out check counts as down. */
      timeoutMs: 2000,
      /** When true a degraded overall status returns 503 rather than 200. */
      failOnDegraded: false,
      /** Reported by /telemetry/health. Omitted from the response when unset. */
      version: undefined as string | undefined,
    },
  },
};

export default config;
```

- [ ] **Step 8: Export the new modules**

Replace the contents of `packages/telemetry/src/index.ts`:

```ts
export * from './metrics.js';
export * from './requestStats.js';
export * from './timeline.js';
export * from './middleware.js';
export * from './endpoints.js';
export * from './PromMetricSink.js';
export * from './policies/TelemetryTokenPolicy.js';
export * from './policies/PublicPolicy.js';
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/policies.test.ts`
Expected: PASS — 7 passing.

- [ ] **Step 10: Verify the package still compiles**

Run: `cd packages/telemetry && npm run compile`
Expected: exit 0, no output.

- [ ] **Step 11: Commit**

```bash
git add packages/telemetry/package.json packages/telemetry/tsconfig*.json packages/telemetry/src/config packages/telemetry/src/policies packages/telemetry/src/index.ts packages/telemetry/test/policies.test.ts
git commit -m "feat(telemetry): add config tree, token policy and public policy"
```

---

## Task 2: Summary metric type + bootstrapper

**Files:**
- Modify: `packages/telemetry/src/metrics.ts`
- Create: `packages/telemetry/src/bootstrap.ts`
- Modify: `packages/telemetry/src/index.ts`
- Test: `packages/telemetry/test/metrics.test.ts` (existing file — append)

**Interfaces:**
- Consumes: the `telemetry.collectDefaultMetrics` config key from Task 1.
- Produces: `MetricType` now includes `'summary'`; `MetricDef.percentiles?: number[]`; `TelemetryBootstrapper extends Bootstrapper`.

- [ ] **Step 1: Write the failing summary test**

Append to `packages/telemetry/test/metrics.test.ts`:

```ts
describe('Metrics — summary support', () => {
  it('constructs a Summary for type "summary" and registers it', async () => {
    const m = new Metrics();
    const map = m.defineMetrics('jobs', [{ name: 'latency_ms', help: 'Job latency', type: 'summary', labelNames: ['queue'], percentiles: [0.5, 0.9, 0.99] }]);

    expect(map['latency_ms']).to.not.be.undefined;
    expect(m.getRegistry().getSingleMetric('jobs_latency_ms')).to.not.be.undefined;

    (map['latency_ms'] as any).observe({ queue: 'default' }, 12);

    const text = await m.render();
    expect(text).to.contain('jobs_latency_ms');
    expect(text).to.contain('quantile="0.9"');
  });
});
```

Ensure `Metrics` and `expect` are imported at the top of that file — if the existing file already imports them, do not duplicate the import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/metrics.test.ts`
Expected: FAIL — TypeScript rejects `type: 'summary'` as not assignable to `MetricType`.

- [ ] **Step 3: Add the summary type to `metrics.ts`**

In `packages/telemetry/src/metrics.ts`:

Change the type alias:

```ts
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';
```

Add `percentiles` to `MetricDef`, after `buckets`:

```ts
  /**
   * Histogram bucket boundaries. Only meaningful for `type: 'histogram'`.
   */
  buckets?: number[];

  /**
   * Quantiles to track. Only meaningful for `type: 'summary'`.
   * Defaults to prom-client's own defaults when omitted.
   */
  percentiles?: number[];
```

Widen `AnyMetric`:

```ts
export type AnyMetric = Counter<string> | Gauge<string> | Histogram<string> | Summary<string>;
```

and extend the value import at the top of the file so `Summary` is in scope:

```ts
import { Counter, Gauge, Histogram, Registry, Summary } from 'prom-client';
```

Add the switch case, immediately after the `'histogram'` case:

```ts
        case 'summary':
          metric = new client.Summary({
            ...common,
            ...(def.percentiles ? { percentiles: def.percentiles } : {}),
          });
          break;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/metrics.test.ts`
Expected: PASS — including the pre-existing tests in that file.

- [ ] **Step 5: Write the bootstrapper**

Create `packages/telemetry/src/bootstrap.ts`:

```ts
import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Perf } from '@spinajs/log';

import { Metrics } from './metrics.js';
import { PromMetricSink } from './PromMetricSink.js';
import { InMemoryPerfSink } from './InMemoryPerfSink.js';

/**
 * Wires the telemetry collection layer at startup:
 *
 *  - registers prom-client's default process metrics against the PRIVATE
 *    registry ( never the global default one ), when configured,
 *  - resolves both perf sinks and refreshes the Perf facade's sink list, so the
 *    perf bridge is live in apps that use telemetry WITHOUT @spinajs/http.
 *
 * `TelemetryMiddleware.resolve()` does the same sink wiring for the http case.
 * Both paths are idempotent ( the sinks are singletons and `refreshSinks` just
 * drops a memo ).
 */
@Injectable(Bootstrapper)
export class TelemetryBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    const cfg = DI.get(Configuration);
    const metrics = DI.get(Metrics) ?? DI.resolve(Metrics);

    if (cfg?.get<boolean>('telemetry.collectDefaultMetrics', true)) {
      metrics.collectDefault();
    }

    DI.resolve(PromMetricSink);
    DI.resolve(InMemoryPerfSink);
    Perf.refreshSinks();
  }
}
```

Note: this imports `InMemoryPerfSink`, which does not exist until Task 5. Create
a placeholder now so the package compiles — Task 5 replaces it wholesale.

Create `packages/telemetry/src/InMemoryPerfSink.ts` with a minimal stub:

```ts
import { Singleton, Injectable } from '@spinajs/di';
import { PerfSink, IPerfMetric } from '@spinajs/log';

@Singleton()
@Injectable(PerfSink)
export class InMemoryPerfSink extends PerfSink {
  public collect(_metric: IPerfMetric): void {
    // implemented in the InMemoryPerfSink task
  }
}
```

- [ ] **Step 6: Export both modules**

In `packages/telemetry/src/index.ts` add:

```ts
export * from './bootstrap.js';
export * from './InMemoryPerfSink.js';
```

- [ ] **Step 7: Verify the package compiles**

Run: `cd packages/telemetry && npm run compile`
Expected: exit 0.

- [ ] **Step 8: Run the whole suite to confirm nothing regressed**

Run: `cd packages/telemetry && npm test`
Expected: PASS. Record the pass/fail count — it is the baseline for later tasks.

- [ ] **Step 9: Commit**

```bash
git add packages/telemetry/src/metrics.ts packages/telemetry/src/bootstrap.ts packages/telemetry/src/InMemoryPerfSink.ts packages/telemetry/src/index.ts packages/telemetry/test/metrics.test.ts
git commit -m "feat(telemetry): support summary metrics, add TelemetryBootstrapper"
```

---

## Task 3: `GET /metrics` controller

**Files:**
- Modify: `packages/http/src/interfaces.ts`
- Create: `packages/telemetry/src/responses.ts`
- Create: `packages/telemetry/src/controllers/Metrics.ts`
- Modify: `packages/telemetry/src/index.ts`
- Modify: `packages/telemetry/package.json`, `packages/telemetry/.gitignore`
- Create: `packages/telemetry/test/common.ts`
- Test: `packages/telemetry/test/controller.metrics.test.ts`

**Interfaces:**
- Consumes: `Metrics` (Task 2), `TelemetryTokenPolicy` (Task 1).
- Produces: `PrometheusResponse extends Response`; `ServiceUnavailable extends Response` (503); `HTTP_STATUS_CODE.SERVICE_UNAVAILABLE = 503` in `@spinajs/http`; controller class `MetricsController` at base path `metrics`; test helpers `TestConfiguration`, `srcDir()`, `req()`, `TEST_TOKEN` in `test/common.ts`.

The controller class is named `MetricsController`, **not** `Metrics` — the
package already exports a service class called `Metrics`, and the retired
`@spinajs/metrics` package shipped exactly that collision, which silently
dropped the controller from its barrel export.

- [ ] **Step 1: Write the test harness**

Assigning `this.Config` **replaces** the merged package defaults rather than
extending them, so the `fs` providers the http controller cache and response
templates rely on have to be declared here explicitly. Omitting them makes every
controller test fail during route registration, not with a readable error. This
mirrors `packages/http-swagger/test/common.ts`, which is the working reference
for booting controllers in a test.

Create `packages/telemetry/test/common.ts`:

```ts
import { FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import os from 'os';
import chai from 'chai';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import express from 'express';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export function srcDir(path: string) {
  return resolve(normalize(join(process.cwd(), 'src', path)));
}

export function req() {
  return chai.request('http://localhost:1337/');
}

export const TEST_TOKEN = 'test-token-123';

/**
 * Boots the telemetry controllers from `src` ( not the compiled `lib` ), with
 * the token policy ACTIVE — `configuration.isDevelopment` is false so the auth
 * tests exercise the real code path.
 */
export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      configuration: {
        isDevelopment: false,
      },
      system: {
        dirs: {
          controllers: [srcDir('./controllers')],
        },
      },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          { service: 'fsNative', name: 'fs-temp', basePath: dir('./cache') },
          { service: 'fsNative', name: '__file_upload_default_provider__', basePath: os.tmpdir() },
          { service: 'fsNative', name: '__fs_controller_cache__', basePath: dir('./cache') },
          { service: 'fsNative', name: '__fs_swagger_cache__', basePath: dir('./cache') },
          { service: 'fsNative', name: '__fs_swagger_views__', basePath: resolve(normalize(join(process.cwd(), '..', 'http-swagger', 'src', 'views'))) },
          { service: 'fsNative', name: '__fs_http_response_templates__', basePath: resolve(normalize(join(process.cwd(), '..', 'http', 'src', 'views', 'responses'))) },
        ],
      },
      logger: {
        targets: [{ name: 'Empty', type: 'ConsoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      http: {
        port: 1337,
        cookie: { secret: 'dsa12!@E#!$' },
        middlewares: [express.json({ limit: '5mb' }), express.urlencoded({ extended: true })],
        AcceptHeaders: 1 | 2,
        swagger: {
          enabled: true,
          title: 'Telemetry API',
          version: '1.0.0',
        },
      },
      telemetry: {
        auth: {
          token: TEST_TOKEN,
          policies: {
            metrics: 'TelemetryTokenPolicy',
            stats: 'TelemetryTokenPolicy',
            timeline: 'TelemetryTokenPolicy',
            routes: 'TelemetryTokenPolicy',
            perf: 'TelemetryTokenPolicy',
            health: 'PublicPolicy',
            ready: 'PublicPolicy',
          },
        },
        collectDefaultMetrics: false,
        prefix: 'http',
        buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
        apdexThresholdMs: 25,
        timeline: { length: 60, bucketMs: 60_000 },
        routes: { enabled: true, maxEntries: 500 },
        perf: { enabled: true, maxNames: 200 },
        health: { timeoutMs: 2000, failOnDegraded: false, version: '9.9.9' },
      },
    };
  }
}
```

- [ ] **Step 1b: Ignore the test cache directory**

Append to `packages/telemetry/.gitignore`:

```
# controller / swagger cache written by the integration tests
test/cache
```

- [ ] **Step 2: Write the failing controller test**

Create `packages/telemetry/test/controller.metrics.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';

import { TestConfiguration, req, TEST_TOKEN } from './common.js';
import { Metrics } from './../src/index.js';

describe('GET /metrics', function () {
  this.timeout(15000);

  before(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    DI.setESMModuleSupport();

    // The fs providers must exist before Controllers resolves — the controller
    // cache and the response templates both read through them.
    DI.resolve(FsBootsrapper).bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Controllers);
    const server = await DI.resolve(HttpServer);
    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  it('rejects a request with no token', async () => {
    const res = await req().get('metrics');
    expect(res).to.have.status(403);
  });

  it('returns prometheus exposition text with the token', async () => {
    const metrics = DI.get(Metrics) ?? (await DI.resolve(Metrics));
    const map = metrics.defineMetrics('probe', [{ name: 'hits_total', help: 'probe hits', type: 'counter' }]);
    (map['hits_total'] as any).inc();

    const res = await req().get('metrics').set('x-metrics-token', TEST_TOKEN);

    expect(res).to.have.status(200);
    expect(res.header['content-type']).to.contain('text/plain');
    expect(res.text).to.contain('probe_hits_total');
  });

  it('exposes the http request metrics recorded by the middleware', async () => {
    await req().get('metrics').set('x-metrics-token', TEST_TOKEN);
    const res = await req().get('metrics').set('x-metrics-token', TEST_TOKEN);

    expect(res.text).to.contain('http_requests_total');
    expect(res.text).to.contain('http_request_duration_ms');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/controller.metrics.test.ts`
Expected: FAIL — 404 on `/metrics`, no controller registered.

- [ ] **Step 3b: Add the 503 status code to `@spinajs/http` and rebuild it**

`HTTP_STATUS_CODE` stops at `NOT_IMPLEMENTED = 501`, and the readiness endpoint
needs 503. In `packages/http/src/interfaces.ts`, directly after the
`NOT_IMPLEMENTED = 501` member, add:

```ts
  /**
   * The server is not ready to handle the request — a dependency is down or the
   * app is still starting up. Used by the telemetry readiness endpoint.
   */
  SERVICE_UNAVAILABLE = 503,
```

Then rebuild — telemetry resolves `@spinajs/http` through its compiled `lib/`,
so without this the new member is invisible:

Run: `cd packages/http && npm run compile`
Expected: exit 0.

- [ ] **Step 3c: Add the test-only dependencies**

In `packages/telemetry/package.json`, add a `devDependencies` block:

```json
  "devDependencies": {
    "@spinajs/fs": "^2.0.481"
  }
```

and add the project reference to `packages/telemetry/tsconfig.json` **only**
(not the mjs/cjs build configs — this is test-only):

```json
    { "path": "../fs/tsconfig.json" }
```

- [ ] **Step 4: Write the response classes**

Create `packages/telemetry/src/responses.ts`:

```ts
import * as express from 'express';
import { Response, HTTP_STATUS_CODE } from '@spinajs/http';

import { Metrics } from './metrics.js';

/**
 * Writes prometheus exposition text with the registry's own content type.
 * Bypasses the json/pug response pipeline entirely — a scrape endpoint has
 * exactly one representation.
 */
export class PrometheusResponse extends Response {
  constructor(protected metrics: Metrics) {
    super(null);
  }

  public async execute(_req: express.Request, res: express.Response) {
    const result = await this.metrics.render();

    res.contentType(this.metrics.contentType());
    res.end(result);
  }
}

/**
 * HTTP 503. Needed because `Response.execute` overwrites any `StatusCode` given
 * through `IResponseOptions` with the class's own `_errorCode`, so
 * `new Ok( body, { StatusCode: 503 } )` silently returns 200.
 */
export class ServiceUnavailable<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.SERVICE_UNAVAILABLE;
  protected _template = 'serverError.pug';
}
```

- [ ] **Step 5: Write the controller**

Create `packages/telemetry/src/controllers/Metrics.ts`:

```ts
import { BasePath, BaseController, Get, Policy } from '@spinajs/http';
import { Autoinject } from '@spinajs/di';

import { Metrics } from './../metrics.js';
import { PrometheusResponse } from './../responses.js';

/**
 * Prometheus scrape endpoint.
 *
 * Deliberately kept at the bare `/metrics` path rather than under the
 * `/telemetry` prefix used by the JSON api — this is the path existing
 * `scrape_configs` already point at.
 */
@BasePath('metrics')
export class MetricsController extends BaseController {
  @Autoinject(Metrics)
  protected MetricsService: Metrics;

  /**
   * Prometheus exposition text for every metric on the registry: the `http_*`
   * request metrics, the `perf_*` bridge metrics, any application metrics
   * declared through `Metrics.defineMetrics`, and — when
   * `telemetry.collectDefaultMetrics` is on — the `process_*` / `nodejs_*` set.
   *
   * @response 200 {string} Prometheus exposition text ( text/plain )
   * @response 403 Access token missing or invalid
   */
  @Get('/')
  @Policy('telemetry.auth.policies.metrics')
  public async getMetrics() {
    return new PrometheusResponse(this.MetricsService);
  }
}
```

- [ ] **Step 6: Export the responses module**

In `packages/telemetry/src/index.ts` add:

```ts
export * from './responses.js';
```

Do **not** export the controllers from the barrel. They are loaded by path
through `system.dirs.controllers`; exporting them as well would register the
routes twice in apps that import the package root.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/controller.metrics.test.ts`
Expected: PASS — 3 passing.

- [ ] **Step 8: Commit**

```bash
git add packages/http/src/interfaces.ts packages/telemetry/src/responses.ts packages/telemetry/src/controllers packages/telemetry/src/index.ts packages/telemetry/package.json packages/telemetry/tsconfig.json packages/telemetry/.gitignore packages/telemetry/test/common.ts packages/telemetry/test/controller.metrics.test.ts
git commit -m "feat(telemetry): expose GET /metrics from the private registry"
```

---

## Task 4: Middleware config wiring, rate window and per-route stats

**Files:**
- Create: `packages/telemetry/src/routeStats.ts`
- Modify: `packages/telemetry/src/middleware.ts`
- Modify: `packages/telemetry/src/index.ts`
- Test: `packages/telemetry/test/routeStats.test.ts`
- Test: `packages/telemetry/test/middleware.test.ts` (existing — append)

**Interfaces:**
- Consumes: `RequestStats` from `requestStats.js`, config keys from Task 1.
- Produces:
  - `class RouteStats` with `record(method: string, route: string, statusCode: number, durationMs: number): void`, `toJSON(): IRouteStatsSnapshot`, readonly `Truncated: boolean`;
  - `interface IRouteStatsSnapshot { truncated: boolean; routes: { method: string; route: string; stats: IRequestStatsSnapshot }[] }`;
  - on `TelemetryMiddleware`: public readonly `RouteStats: RouteStats`, public `StartedAt: number`.

- [ ] **Step 1: Write the failing RouteStats test**

Create `packages/telemetry/test/routeStats.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { RouteStats } from './../src/routeStats.js';

describe('RouteStats', () => {
  it('accumulates per method+route', () => {
    const rs = new RouteStats(100, 25);

    rs.record('GET', '/users/:id', 200, 10);
    rs.record('GET', '/users/:id', 500, 30);
    rs.record('POST', '/users', 201, 5);

    const snapshot = rs.toJSON();
    expect(snapshot.routes).to.have.length(2);

    const users = snapshot.routes.find((r) => r.method === 'GET' && r.route === '/users/:id');
    expect(users.stats.requests).to.eq(2);
    expect(users.stats.responses).to.eq(2);
    expect(users.stats.errors).to.eq(1);
    expect(users.stats.server_error).to.eq(1);
    expect(users.stats.success).to.eq(1);
    expect(users.stats.avg_time).to.eq(20);
    expect(users.stats.max_time).to.eq(30);
    expect(users.stats.min_time).to.eq(10);

    const post = snapshot.routes.find((r) => r.method === 'POST');
    expect(post.stats.requests).to.eq(1);
  });

  it('separates the same route on different methods', () => {
    const rs = new RouteStats(100, 25);
    rs.record('GET', '/x', 200, 1);
    rs.record('DELETE', '/x', 200, 1);
    expect(rs.toJSON().routes).to.have.length(2);
  });

  it('stops adding new keys past maxEntries and reports truncation', () => {
    const rs = new RouteStats(2, 25);

    rs.record('GET', '/a', 200, 1);
    rs.record('GET', '/b', 200, 1);
    rs.record('GET', '/c', 200, 1);

    expect(rs.Truncated).to.eq(true);
    expect(rs.toJSON().truncated).to.eq(true);
    expect(rs.toJSON().routes).to.have.length(2);
  });

  it('keeps counting into existing keys after the cap is hit', () => {
    const rs = new RouteStats(1, 25);

    rs.record('GET', '/a', 200, 1);
    rs.record('GET', '/b', 200, 1);
    rs.record('GET', '/a', 200, 3);

    const a = rs.toJSON().routes.find((r) => r.route === '/a');
    expect(a.stats.requests).to.eq(2);
  });

  it('propagates the apdex threshold into each bucket', () => {
    const rs = new RouteStats(100, 10);
    rs.record('GET', '/a', 200, 5);
    rs.record('GET', '/a', 200, 500);

    const a = rs.toJSON().routes.find((r) => r.route === '/a');
    expect(a.stats.apdex_satisfied).to.eq(1);
    expect(a.stats.apdex_tolerated).to.eq(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/routeStats.test.ts`
Expected: FAIL — cannot find module `./../src/routeStats.js`.

- [ ] **Step 3: Write RouteStats**

Create `packages/telemetry/src/routeStats.ts`:

```ts
import { IRequestStatsSnapshot, RequestStats } from './requestStats.js';

/**
 * One row of the per-route breakdown.
 */
export interface IRouteStatsEntry {
  method: string;
  route: string;
  stats: IRequestStatsSnapshot;
}

/**
 * Serializable snapshot of {@link RouteStats}.
 */
export interface IRouteStatsSnapshot {
  /** True once the entry cap was hit and new routes stopped being tracked. */
  truncated: boolean;
  routes: IRouteStatsEntry[];
}

const KEY_SEPARATOR = ' ';

/**
 * A bounded `method + route -> RequestStats` map.
 *
 * The bound is not optional. The telemetry middleware falls back to the raw
 * request path when no route matched, so an unbounded map would grow one entry
 * per distinct URL a 404-scanning bot tries.
 */
export class RouteStats {
  private entries = new Map<string, RequestStats>();
  private truncated = false;

  constructor(public readonly maxEntries: number, public readonly apdexThreshold: number) {}

  /**
   * True once at least one route was dropped because the cap was reached.
   */
  public get Truncated(): boolean {
    return this.truncated;
  }

  /**
   * Record one completed response. A new method+route key is only created while
   * under `maxEntries`; past that, known routes keep accumulating and unknown
   * ones are dropped.
   */
  public record(method: string, route: string, statusCode: number, durationMs: number): void {
    const key = `${method}${KEY_SEPARATOR}${route}`;

    let stats = this.entries.get(key);
    if (!stats) {
      if (this.entries.size >= this.maxEntries) {
        this.truncated = true;
        return;
      }
      stats = new RequestStats(this.apdexThreshold);
      this.entries.set(key, stats);
    }

    stats.countRequest();
    stats.countResponse(statusCode, durationMs);
  }

  public toJSON(): IRouteStatsSnapshot {
    const routes: IRouteStatsEntry[] = [];

    for (const [key, stats] of this.entries) {
      const separator = key.indexOf(KEY_SEPARATOR);
      routes.push({
        method: key.substring(0, separator),
        route: key.substring(separator + 1),
        stats: stats.toJSON(),
      });
    }

    return { truncated: this.truncated, routes };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/routeStats.test.ts`
Expected: PASS — 5 passing.

- [ ] **Step 5: Write the failing middleware test**

Append to `packages/telemetry/test/middleware.test.ts`:

```ts
describe('TelemetryMiddleware — per-route stats and config', () => {
  it('records into RouteStats keyed by method and matched route', () => {
    const { mw } = makeMiddleware();
    const req = fakeReq({ route: { path: '/users/:id' } });
    const res = { statusCode: 200 } as any;

    mw.before()(req, res, sinon.spy());
    mw.after()(req, res, sinon.spy());

    const snapshot = mw.RouteStats.toJSON();
    expect(snapshot.routes).to.have.length(1);
    expect(snapshot.routes[0].method).to.eq('GET');
    expect(snapshot.routes[0].route).to.eq('/users/:id');
    expect(snapshot.routes[0].stats.requests).to.eq(1);
  });

  it('skips per-route recording when routes are disabled', () => {
    const { mw } = makeMiddleware();
    (mw as any).RoutesEnabled = false;

    const req = fakeReq({ route: { path: '/users/:id' } });
    const res = { statusCode: 200 } as any;

    mw.before()(req, res, sinon.spy());
    mw.after()(req, res, sinon.spy());

    expect(mw.RouteStats.toJSON().routes).to.have.length(0);
  });

  it('stamps StartedAt so request rates can be computed', () => {
    const { mw } = makeMiddleware();
    expect(mw.StartedAt).to.be.a('number');
    expect(mw.StartedAt).to.be.at.most(Date.now());
  });

  it('still calls next() when the metric call throws', () => {
    const { mw } = makeMiddleware();
    (mw as any).requestDuration = {
      observe: () => {
        throw new Error('boom');
      },
    };

    const req = fakeReq();
    const res = { statusCode: 200 } as any;
    const next = sinon.spy();

    mw.before()(req, res, sinon.spy());
    mw.after()(req, res, next);

    expect(next.calledOnce).to.eq(true);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/middleware.test.ts`
Expected: FAIL — `mw.RouteStats` is undefined.

- [ ] **Step 7: Wire config and RouteStats into the middleware**

In `packages/telemetry/src/middleware.ts`:

Add to the imports:

```ts
import { Config } from '@spinajs/configuration';
import { RouteStats } from './routeStats.js';
```

Replace the class body's field block (currently `Prefix`, `metrics`, the three
metric handles, `defined`, `RequestStats`, `Timeline`, and the constructor)
with:

```ts
  /**
   * Metric-name prefix. A subclass that assigns this wins over configuration —
   * subclassing to re-prefix is a documented extension point.
   */
  protected Prefix = DEFAULT_PREFIX;

  @Config('telemetry.prefix', { defaultValue: DEFAULT_PREFIX })
  protected ConfiguredPrefix!: string;

  @Config('telemetry.buckets', { defaultValue: DURATION_BUCKETS_MS })
  protected Buckets!: number[];

  @Config('telemetry.apdexThresholdMs', { defaultValue: 25 })
  protected ApdexThresholdMs!: number;

  @Config('telemetry.timeline.length', { defaultValue: 60 })
  protected TimelineLength!: number;

  @Config('telemetry.timeline.bucketMs', { defaultValue: 60_000 })
  protected TimelineBucketMs!: number;

  @Config('telemetry.routes.enabled', { defaultValue: true })
  protected RoutesEnabled!: boolean;

  @Config('telemetry.routes.maxEntries', { defaultValue: 500 })
  protected RoutesMaxEntries!: number;

  protected metrics!: Metrics;
  protected requestsTotal!: Counter<string>;
  protected requestDuration!: Histogram<string>;
  protected inFlight!: Gauge<string>;

  private defined = false;

  /**
   * Epoch ms at which this middleware started collecting. Used to compute the
   * lifetime request / error rates.
   */
  public readonly StartedAt = Date.now();

  /**
   * Lifetime request stats ( status classes, error rate, apdex ). Rebuilt in
   * `resolve()` once configuration is available.
   */
  public RequestStats = new RequestStats();

  /**
   * Rolling timeline of request stats. Rebuilt in `resolve()`.
   */
  public Timeline = new Timeline();

  /**
   * Per method+route breakdown. Rebuilt in `resolve()`.
   */
  public RouteStats = new RouteStats(500, 25);

  constructor() {
    super();
    // Needs req.storage ( ReqStorage = -2 ) and sits alongside RequestId /
    // AccessLog ( Order 2 ).
    this.Order = 2;
  }
```

The aggregates are constructed twice on purpose: as field initializers so a
directly-instantiated middleware ( as in the unit tests ) is usable without DI,
and again in `resolve()` once `@Config` has been populated.

Replace `resolve()` with:

```ts
  public async resolve(): Promise<void> {
    await super.resolve();

    // Rebuild the aggregates now that configuration is available.
    this.RequestStats = new RequestStats(this.ApdexThresholdMs);
    this.Timeline = new Timeline(this.TimelineLength, this.TimelineBucketMs, this.ApdexThresholdMs);
    this.RouteStats = new RouteStats(this.RoutesMaxEntries, this.ApdexThresholdMs);

    // Ensure the perf sinks exist so the Perf facade discovers them.
    void DI.resolve(PromMetricSink);
    void DI.resolve(InMemoryPerfSink);
    Perf.refreshSinks();
  }
```

and add `import { InMemoryPerfSink } from './InMemoryPerfSink.js';` to the imports.

In `ensureMetrics()`, use the configured prefix and buckets. Replace the first
two statements of the method body with:

```ts
    if (this.defined) return;

    this.metrics = DI.get(Metrics) ?? DI.resolve(Metrics);

    // A subclass that overrode Prefix keeps it; otherwise configuration wins.
    const prefix = this.Prefix !== DEFAULT_PREFIX ? this.Prefix : this.ConfiguredPrefix ?? DEFAULT_PREFIX;

    const map: MetricMap = this.metrics.defineMetrics(prefix, [
```

and in that same array change the histogram's `buckets` line to:

```ts
        buckets: this.Buckets ?? DURATION_BUCKETS_MS,
```

In `after()`, after the existing `this.Timeline.record(...)` line, add:

```ts
        if (this.RoutesEnabled !== false) {
          this.RouteStats.record(method, route, status, durationMs);
        }
```

- [ ] **Step 8: Export routeStats**

In `packages/telemetry/src/index.ts` add:

```ts
export * from './routeStats.js';
```

- [ ] **Step 9: Run the middleware tests to verify they pass**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/middleware.test.ts`
Expected: PASS — the pre-existing tests plus the 4 new ones.

- [ ] **Step 10: Run the whole suite**

Run: `cd packages/telemetry && npm test`
Expected: PASS, at or above the Task 2 baseline count.

- [ ] **Step 11: Commit**

```bash
git add packages/telemetry/src/routeStats.ts packages/telemetry/src/middleware.ts packages/telemetry/src/index.ts packages/telemetry/test/routeStats.test.ts packages/telemetry/test/middleware.test.ts
git commit -m "feat(telemetry): config-driven middleware with per-route request stats"
```

---

## Task 5: InMemoryPerfSink

**Files:**
- Modify: `packages/telemetry/src/InMemoryPerfSink.ts` (replaces the Task 2 stub)
- Test: `packages/telemetry/test/inMemoryPerfSink.test.ts`

**Interfaces:**
- Consumes: `PerfSink`, `IPerfMetric` from `@spinajs/log`.
- Produces: `InMemoryPerfSink` with `toJSON(): IPerfSnapshot`; `interface IPerfSnapshot { truncated: boolean; spans: { name: string; count: number; totalMs: number; avgMs: number; maxMs: number }[]; events: { name: string; count: number; total: number }[] }`.

- [ ] **Step 1: Write the failing test**

Create `packages/telemetry/test/inMemoryPerfSink.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { InMemoryPerfSink } from './../src/InMemoryPerfSink.js';

function makeSink(enabled = true, maxNames = 200) {
  const sink = new InMemoryPerfSink();
  const anySink = sink as any;
  anySink.Enabled = enabled;
  anySink.MaxNames = maxNames;
  return sink;
}

describe('InMemoryPerfSink', () => {
  it('aggregates span count, total and max', () => {
    const sink = makeSink();

    sink.collect({ name: 'orm.query', kind: 'span', durationMs: 10 });
    sink.collect({ name: 'orm.query', kind: 'span', durationMs: 30 });

    const spans = sink.toJSON().spans;
    expect(spans).to.have.length(1);
    expect(spans[0].name).to.eq('orm.query');
    expect(spans[0].count).to.eq(2);
    expect(spans[0].totalMs).to.eq(40);
    expect(spans[0].avgMs).to.eq(20);
    expect(spans[0].maxMs).to.eq(30);
  });

  it('aggregates counter and value events separately from spans', () => {
    const sink = makeSink();

    sink.collect({ name: 'cache.miss', kind: 'counter', value: 2 });
    sink.collect({ name: 'cache.miss', kind: 'counter', value: 3 });
    sink.collect({ name: 'queue.depth', kind: 'value', value: 7 });

    const json = sink.toJSON();
    expect(json.spans).to.have.length(0);
    expect(json.events).to.have.length(2);

    const miss = json.events.find((e) => e.name === 'cache.miss');
    expect(miss.count).to.eq(2);
    expect(miss.total).to.eq(5);
  });

  it('defaults a missing duration to 0 and a missing value to 1', () => {
    const sink = makeSink();

    sink.collect({ name: 'a', kind: 'span' });
    sink.collect({ name: 'b', kind: 'counter' });

    expect(sink.toJSON().spans[0].totalMs).to.eq(0);
    expect(sink.toJSON().events[0].total).to.eq(1);
  });

  it('sorts spans by total time and events by total, descending', () => {
    const sink = makeSink();

    sink.collect({ name: 'small', kind: 'span', durationMs: 1 });
    sink.collect({ name: 'big', kind: 'span', durationMs: 100 });
    sink.collect({ name: 'few', kind: 'counter', value: 1 });
    sink.collect({ name: 'many', kind: 'counter', value: 50 });

    const json = sink.toJSON();
    expect(json.spans[0].name).to.eq('big');
    expect(json.events[0].name).to.eq('many');
  });

  it('stops adding new names past maxNames and reports truncation', () => {
    const sink = makeSink(true, 2);

    sink.collect({ name: 'a', kind: 'span', durationMs: 1 });
    sink.collect({ name: 'b', kind: 'span', durationMs: 1 });
    sink.collect({ name: 'c', kind: 'span', durationMs: 1 });

    const json = sink.toJSON();
    expect(json.spans).to.have.length(2);
    expect(json.truncated).to.eq(true);
  });

  it('counts spans and events against the same name budget', () => {
    const sink = makeSink(true, 1);

    sink.collect({ name: 'a', kind: 'span', durationMs: 1 });
    sink.collect({ name: 'b', kind: 'counter', value: 1 });

    const json = sink.toJSON();
    expect(json.spans).to.have.length(1);
    expect(json.events).to.have.length(0);
    expect(json.truncated).to.eq(true);
  });

  it('collects nothing when disabled', () => {
    const sink = makeSink(false);

    sink.collect({ name: 'a', kind: 'span', durationMs: 1 });

    expect(sink.toJSON().spans).to.have.length(0);
  });

  it('never throws on a malformed metric', () => {
    const sink = makeSink();
    sink.collect({} as any);
    sink.collect(null as any);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/inMemoryPerfSink.test.ts`
Expected: FAIL — `sink.toJSON is not a function`.

- [ ] **Step 3: Implement the sink**

Replace the whole of `packages/telemetry/src/InMemoryPerfSink.ts`:

```ts
import { Singleton, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { PerfSink, IPerfMetric } from '@spinajs/log';

/** One aggregated span row. */
export interface IPerfSpanEntry {
  name: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
}

/** One aggregated counter / value row. */
export interface IPerfEventEntry {
  name: string;
  count: number;
  total: number;
}

/** Serializable snapshot served by `GET /telemetry/perf`. */
export interface IPerfSnapshot {
  /** True once the name cap was hit and new names stopped being tracked. */
  truncated: boolean;
  spans: IPerfSpanEntry[];
  events: IPerfEventEntry[];
}

/**
 * A {@link PerfSink} that keeps a bounded, JSON-readable aggregate of every
 * measurement, backing `GET /telemetry/perf`.
 *
 * This exists alongside `PromMetricSink` rather than replacing it: prom
 * histograms are the right shape for Prometheus but their bucket counts cannot
 * be read back as a mean or a max, which is what a JSON snapshot needs.
 *
 * Per-request rollups are intentionally NOT implemented here — `onScopeEnd`
 * totals share the span names, so folding them in would double-count against
 * the same rows. The per-request view lives in `perf_scope_total_ms` on the
 * prometheus side.
 */
@Singleton()
@Injectable(PerfSink)
export class InMemoryPerfSink extends PerfSink {
  @Config('telemetry.perf.enabled', { defaultValue: true })
  protected Enabled!: boolean;

  @Config('telemetry.perf.maxNames', { defaultValue: 200 })
  protected MaxNames!: number;

  private spans = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  private events = new Map<string, { count: number; total: number }>();
  private truncated = false;

  public collect(metric: IPerfMetric): void {
    if (this.Enabled === false) return;
    if (!metric || typeof metric.name !== 'string') return;

    if (metric.kind === 'span') {
      const entry = this.spans.get(metric.name) ?? (this.track(metric.name) ? this.create(this.spans, metric.name, { count: 0, totalMs: 0, maxMs: 0 }) : undefined);
      if (!entry) return;

      const durationMs = metric.durationMs ?? 0;
      entry.count += 1;
      entry.totalMs += durationMs;
      if (durationMs > entry.maxMs) entry.maxMs = durationMs;
      return;
    }

    const entry = this.events.get(metric.name) ?? (this.track(metric.name) ? this.create(this.events, metric.name, { count: 0, total: 0 }) : undefined);
    if (!entry) return;

    entry.count += 1;
    entry.total += metric.value ?? 1;
  }

  public toJSON(): IPerfSnapshot {
    const spans: IPerfSpanEntry[] = [];
    for (const [name, e] of this.spans) {
      spans.push({ name, count: e.count, totalMs: e.totalMs, avgMs: e.count > 0 ? e.totalMs / e.count : 0, maxMs: e.maxMs });
    }
    spans.sort((a, b) => b.totalMs - a.totalMs);

    const events: IPerfEventEntry[] = [];
    for (const [name, e] of this.events) {
      events.push({ name, count: e.count, total: e.total });
    }
    events.sort((a, b) => b.total - a.total);

    return { truncated: this.truncated, spans, events };
  }

  /**
   * Whether a NEW name may be tracked. Spans and events share one budget so the
   * total retained-name count is what `maxNames` bounds.
   */
  private track(_name: string): boolean {
    if (this.spans.size + this.events.size >= (this.MaxNames ?? 200)) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  private create<T>(map: Map<string, T>, name: string, initial: T): T {
    map.set(name, initial);
    return initial;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/inMemoryPerfSink.test.ts`
Expected: PASS — 8 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/InMemoryPerfSink.ts packages/telemetry/test/inMemoryPerfSink.test.ts
git commit -m "feat(telemetry): add InMemoryPerfSink for the JSON perf view"
```

---

## Task 6: Health checks

**Files:**
- Create: `packages/telemetry/src/health.ts`
- Modify: `packages/telemetry/src/index.ts`
- Test: `packages/telemetry/test/health.test.ts`

**Interfaces:**
- Consumes: `AsyncService`, `Array.ofType` from `@spinajs/di`.
- Produces:
  - `type HealthStatus = 'up' | 'degraded' | 'down'`;
  - `interface IHealthResult { status: HealthStatus; message?: string; data?: Record<string, unknown> }`;
  - `interface IHealthCheckReport { name: string; status: HealthStatus; durationMs: number; message?: string; data?: Record<string, unknown> }`;
  - `interface IReadyReport { status: HealthStatus; checks: IHealthCheckReport[] }`;
  - `abstract class HealthCheck extends AsyncService` with abstract `Name: string` and `check(): Promise<IHealthResult>`;
  - `class HealthCheckRunner` with `run(): Promise<IReadyReport>` and `isFailing(status: HealthStatus): boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/telemetry/test/health.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { HealthCheck, HealthCheckRunner, IHealthResult } from './../src/health.js';

class StubCheck extends HealthCheck {
  constructor(public Name: string, private result: IHealthResult | Error, private delayMs = 0) {
    super();
  }

  public check(): Promise<IHealthResult> {
    const settle = () => (this.result instanceof Error ? Promise.reject(this.result) : Promise.resolve(this.result));

    if (this.delayMs === 0) return settle();
    return new Promise((res, rej) => setTimeout(() => settle().then(res, rej), this.delayMs));
  }
}

function makeRunner(checks: HealthCheck[], timeoutMs = 50, failOnDegraded = false) {
  const runner = new HealthCheckRunner();
  const anyRunner = runner as any;
  anyRunner.Checks = checks;
  anyRunner.TimeoutMs = timeoutMs;
  anyRunner.FailOnDegraded = failOnDegraded;
  return runner;
}

describe('HealthCheckRunner', () => {
  it('reports up with an empty check list when nothing is registered', async () => {
    const report = await makeRunner([]).run();
    expect(report.status).to.eq('up');
    expect(report.checks).to.have.length(0);
  });

  it('reports up when every check is up', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'up' }), new StubCheck('b', { status: 'up' })]).run();

    expect(report.status).to.eq('up');
    expect(report.checks).to.have.length(2);
    expect(report.checks[0].name).to.eq('a');
    expect(report.checks[0].durationMs).to.be.a('number');
  });

  it('reports down when any check is down', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'up' }), new StubCheck('b', { status: 'down', message: 'no connection' })]).run();

    expect(report.status).to.eq('down');
    const b = report.checks.find((c) => c.name === 'b');
    expect(b.message).to.eq('no connection');
  });

  it('down beats degraded', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'degraded' }), new StubCheck('b', { status: 'down' })]).run();
    expect(report.status).to.eq('down');
  });

  it('reports degraded when the worst check is degraded', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'up' }), new StubCheck('b', { status: 'degraded' })]).run();
    expect(report.status).to.eq('degraded');
  });

  it('treats a throwing check as down with the error message', async () => {
    const report = await makeRunner([new StubCheck('a', new Error('kaboom'))]).run();

    expect(report.status).to.eq('down');
    expect(report.checks[0].status).to.eq('down');
    expect(report.checks[0].message).to.contain('kaboom');
  });

  it('treats a check that exceeds the timeout as down', async () => {
    const report = await makeRunner([new StubCheck('slow', { status: 'up' }, 200)], 20).run();

    expect(report.status).to.eq('down');
    expect(report.checks[0].status).to.eq('down');
    expect(report.checks[0].message).to.contain('timed out');
  });

  it('does not let one slow check block the others', async () => {
    const report = await makeRunner([new StubCheck('slow', { status: 'up' }, 200), new StubCheck('fast', { status: 'up' })], 20).run();

    expect(report.checks).to.have.length(2);
    expect(report.checks.find((c) => c.name === 'fast').status).to.eq('up');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/health.test.ts`
Expected: FAIL — cannot find module `./../src/health.js`.

- [ ] **Step 3: Implement health.ts**

Create `packages/telemetry/src/health.ts`:

```ts
import { AsyncService, Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

/** Outcome of a single health check. */
export type HealthStatus = 'up' | 'degraded' | 'down';

/** What a {@link HealthCheck} returns. */
export interface IHealthResult {
  status: HealthStatus;
  message?: string;
  data?: Record<string, unknown>;
}

/** One check's line in the readiness report. */
export interface IHealthCheckReport extends IHealthResult {
  name: string;
  /** How long the check took, in ms. */
  durationMs: number;
}

/** The body served by `GET /telemetry/ready`. */
export interface IReadyReport {
  status: HealthStatus;
  checks: IHealthCheckReport[];
}

/**
 * A readiness probe for one dependency.
 *
 * Register a concrete subclass with `@Injectable( HealthCheck )` and it is
 * discovered by {@link HealthCheckRunner} via `Array.ofType( HealthCheck )`.
 * `@spinajs/telemetry` deliberately ships NO concrete checks — a database check
 * belongs where the database dependency already is, not in the observability
 * package.
 *
 * `check()` may throw; a throw counts as `down`.
 */
export abstract class HealthCheck extends AsyncService {
  /** Stable identifier for this check, used as the report key. */
  public abstract Name: string;

  public abstract check(): Promise<IHealthResult>;
}

const RANK: Record<HealthStatus, number> = { up: 0, degraded: 1, down: 2 };

/**
 * Runs every registered {@link HealthCheck} concurrently, each raced against a
 * per-check timeout, and reduces the results to one overall status.
 *
 * The timeout is the point of the class: a readiness endpoint that can hang is
 * worse than no readiness endpoint, because a kubelet probe blocks on it.
 */
@Singleton()
@Injectable()
export class HealthCheckRunner {
  @Autoinject(HealthCheck)
  protected Checks!: HealthCheck[];

  @Config('telemetry.health.timeoutMs', { defaultValue: 2000 })
  protected TimeoutMs!: number;

  @Config('telemetry.health.failOnDegraded', { defaultValue: false })
  protected FailOnDegraded!: boolean;

  /**
   * True when the overall status should be served as HTTP 503.
   */
  public isFailing(status: HealthStatus): boolean {
    if (status === 'down') return true;
    return status === 'degraded' && this.FailOnDegraded === true;
  }

  public async run(): Promise<IReadyReport> {
    const checks = await Promise.all((this.Checks ?? []).map((c) => this.runOne(c)));

    let worst: HealthStatus = 'up';
    for (const c of checks) {
      if (RANK[c.status] > RANK[worst]) worst = c.status;
    }

    return { status: worst, checks };
  }

  private async runOne(check: HealthCheck): Promise<IHealthCheckReport> {
    const startedAt = Date.now();
    const timeoutMs = this.TimeoutMs ?? 2000;

    let timer: NodeJS.Timeout | undefined;

    try {
      const result = await Promise.race([
        check.check(),
        new Promise<IHealthResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);

      return { name: check.Name, status: result.status, message: result.message, data: result.data, durationMs: Date.now() - startedAt };
    } catch (err) {
      return { name: check.Name, status: 'down', message: (err as Error)?.message ?? String(err), durationMs: Date.now() - startedAt };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Export health.ts**

In `packages/telemetry/src/index.ts` add:

```ts
export * from './health.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/health.test.ts`
Expected: PASS — 8 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/telemetry/src/health.ts packages/telemetry/src/index.ts packages/telemetry/test/health.test.ts
git commit -m "feat(telemetry): add pluggable health checks with per-check timeout"
```

---

## Task 7: Response DTOs and JSON schemas

**Files:**
- Create: `packages/telemetry/src/schemas/RequestStatsSnapshot.schema.ts`
- Create: `packages/telemetry/src/schemas/StatsResponse.schema.ts`
- Create: `packages/telemetry/src/schemas/TimelineResponse.schema.ts`
- Create: `packages/telemetry/src/schemas/RoutesResponse.schema.ts`
- Create: `packages/telemetry/src/schemas/PerfResponse.schema.ts`
- Create: `packages/telemetry/src/schemas/HealthResponse.schema.ts`
- Create: `packages/telemetry/src/schemas/ReadyResponse.schema.ts`
- Create: `packages/telemetry/src/dto/index.ts`
- Modify: `packages/telemetry/src/index.ts`
- Test: `packages/telemetry/test/dto.test.ts`

**Interfaces:**
- Consumes: `@Schema` from `@spinajs/validation`.
- Produces: exported classes `StatsResponse`, `TimelineResponse`, `RoutesResponse`, `PerfResponse`, `HealthResponse`, `ReadyResponse` — each `@Schema`-decorated, each registered under its own class name in the `'__schemas__'` DI map, which is what `DtoSchemaProvider` reads when swagger expands a `@returns {ClassName}` tag.

- [ ] **Step 1: Write the failing test**

Create `packages/telemetry/test/dto.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';

import './../src/dto/index.js';

/**
 * `@Schema` registers each schema under the decorated class's name in the
 * '__schemas__' DI map. That map is exactly what DtoSchemaProvider reads when
 * http-swagger expands a `@returns {StatsResponse}` tag into a component, so a
 * name missing here means a missing schema in the generated OpenAPI document.
 */
describe('telemetry response DTOs', () => {
  const NAMES = ['StatsResponse', 'TimelineResponse', 'RoutesResponse', 'PerfResponse', 'HealthResponse', 'ReadyResponse'];

  it('registers every response DTO under its class name', () => {
    const schemas = DI.get<Map<string, any>>('__schemas__');
    expect(schemas).to.not.be.undefined;

    for (const name of NAMES) {
      expect(schemas.get(name), `${name} is not registered`).to.not.be.undefined;
    }
  });

  it('declares each schema as an object with properties', () => {
    const schemas = DI.get<Map<string, any>>('__schemas__');

    for (const name of NAMES) {
      const schema = schemas.get(name);
      expect(schema.type, `${name}.type`).to.eq('object');
      expect(Object.keys(schema.properties ?? {}), `${name}.properties`).to.not.have.length(0);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/dto.test.ts`
Expected: FAIL — cannot find module `./../src/dto/index.js`.

- [ ] **Step 3: Write the shared request-stats schema**

Create `packages/telemetry/src/schemas/RequestStatsSnapshot.schema.ts`:

```ts
/**
 * Shape of `IRequestStatsSnapshot`. Reused by the stats, timeline and routes
 * responses, so it is declared once and spread into each.
 */
const RequestStatsSnapshotSchema = {
  type: 'object',
  properties: {
    requests: { type: 'number', description: 'Requests counted' },
    responses: { type: 'number', description: 'Responses counted' },
    errors: { type: 'number', description: 'Responses with status >= 400' },

    info: { type: 'number', description: '1xx responses' },
    success: { type: 'number', description: '2xx responses' },
    redirect: { type: 'number', description: '3xx responses' },
    client_error: { type: 'number', description: '4xx responses' },
    server_error: { type: 'number', description: '5xx responses' },

    total_time: { type: 'number', description: 'Summed response time in ms' },
    max_time: { type: 'number', description: 'Slowest response in ms' },
    min_time: { type: 'number', description: 'Fastest response in ms' },
    avg_time: { type: 'number', description: 'Mean response time in ms' },

    apdex_satisfied: { type: 'number', description: 'Responses within the apdex threshold' },
    apdex_tolerated: { type: 'number', description: 'Responses within 4x the apdex threshold' },
    apdex_score: { type: 'number', description: '( satisfied + tolerated / 2 ) / responses' },

    req_rate: { type: 'number', description: 'Requests per second over the window' },
    err_rate: { type: 'number', description: 'Errors per second over the window' },
  },
};

export default RequestStatsSnapshotSchema;
```

- [ ] **Step 4: Write the remaining schemas**

Create `packages/telemetry/src/schemas/StatsResponse.schema.ts`:

```ts
import RequestStatsSnapshotSchema from './RequestStatsSnapshot.schema.js';

const StatsResponseSchema = {
  type: 'object',
  properties: {
    all: { ...RequestStatsSnapshotSchema, description: 'Lifetime request stats' },
    timeline: {
      type: 'object',
      description: 'Rolling per-bucket stats, keyed by floor( timestamp / bucketMs )',
      additionalProperties: RequestStatsSnapshotSchema,
    },
  },
};

export default StatsResponseSchema;
```

Create `packages/telemetry/src/schemas/TimelineResponse.schema.ts`:

```ts
import RequestStatsSnapshotSchema from './RequestStatsSnapshot.schema.js';

const TimelineResponseSchema = {
  type: 'object',
  properties: {
    bucketMs: { type: 'number', description: 'Bucket width in ms' },
    length: { type: 'number', description: 'Number of buckets retained in the ring' },
    buckets: {
      type: 'array',
      description: 'Live buckets, oldest first',
      items: {
        type: 'object',
        properties: {
          key: { type: 'number', description: 'floor( timestamp / bucketMs )' },
          from: { type: 'number', description: 'Bucket start, epoch ms' },
          to: { type: 'number', description: 'Bucket end, epoch ms' },
          stats: RequestStatsSnapshotSchema,
        },
      },
    },
  },
};

export default TimelineResponseSchema;
```

Create `packages/telemetry/src/schemas/RoutesResponse.schema.ts`:

```ts
import RequestStatsSnapshotSchema from './RequestStatsSnapshot.schema.js';

const RoutesResponseSchema = {
  type: 'object',
  properties: {
    truncated: { type: 'boolean', description: 'True once the route cap was hit and new routes stopped being tracked' },
    routes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP method' },
          route: { type: 'string', description: 'Matched route path, or the raw path when nothing matched' },
          stats: RequestStatsSnapshotSchema,
        },
      },
    },
  },
};

export default RoutesResponseSchema;
```

Create `packages/telemetry/src/schemas/PerfResponse.schema.ts`:

```ts
const PerfResponseSchema = {
  type: 'object',
  properties: {
    truncated: { type: 'boolean', description: 'True once the measurement-name cap was hit' },
    spans: {
      type: 'array',
      description: 'Timed spans, slowest total first',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Measurement name, eg. orm.query' },
          count: { type: 'number' },
          totalMs: { type: 'number' },
          avgMs: { type: 'number' },
          maxMs: { type: 'number' },
        },
      },
    },
    events: {
      type: 'array',
      description: 'Counter and value events, largest total first',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number', description: 'Number of emissions' },
          total: { type: 'number', description: 'Summed value across emissions' },
        },
      },
    },
  },
};

export default PerfResponseSchema;
```

Create `packages/telemetry/src/schemas/HealthResponse.schema.ts`:

```ts
const HealthResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['up'], description: 'Always "up" — this endpoint runs no checks' },
    startedAt: { type: 'number', description: 'Process start, epoch ms' },
    uptimeMs: { type: 'number' },
    pid: { type: 'number' },
    version: { type: 'string', description: 'telemetry.health.version; omitted when unset' },
    node: { type: 'string', description: 'Node runtime version' },
  },
};

export default HealthResponseSchema;
```

Create `packages/telemetry/src/schemas/ReadyResponse.schema.ts`:

```ts
const ReadyResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['up', 'degraded', 'down'], description: 'Worst status across all checks' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['up', 'degraded', 'down'] },
          durationMs: { type: 'number' },
          message: { type: 'string' },
          data: { type: 'object' },
        },
      },
    },
  },
};

export default ReadyResponseSchema;
```

- [ ] **Step 5: Write the DTO classes**

Create `packages/telemetry/src/dto/index.ts`:

```ts
import { Schema } from '@spinajs/validation';

import StatsResponseSchema from './../schemas/StatsResponse.schema.js';
import TimelineResponseSchema from './../schemas/TimelineResponse.schema.js';
import RoutesResponseSchema from './../schemas/RoutesResponse.schema.js';
import PerfResponseSchema from './../schemas/PerfResponse.schema.js';
import HealthResponseSchema from './../schemas/HealthResponse.schema.js';
import ReadyResponseSchema from './../schemas/ReadyResponse.schema.js';

/**
 * Response shapes for the telemetry endpoints.
 *
 * These classes are never instantiated — they exist so `@Schema` registers each
 * JSON schema under the class name, which is how http-swagger resolves a
 * `@returns {StatsResponse}` JSDoc tag into a `#/components/schemas/...`
 * component. The controller imports this module so the decorators run.
 */

@Schema(StatsResponseSchema)
export class StatsResponse {}

@Schema(TimelineResponseSchema)
export class TimelineResponse {}

@Schema(RoutesResponseSchema)
export class RoutesResponse {}

@Schema(PerfResponseSchema)
export class PerfResponse {}

@Schema(HealthResponseSchema)
export class HealthResponse {}

@Schema(ReadyResponseSchema)
export class ReadyResponse {}
```

- [ ] **Step 6: Export the DTOs**

In `packages/telemetry/src/index.ts` add:

```ts
export * from './dto/index.js';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/dto.test.ts`
Expected: PASS — 2 passing.

- [ ] **Step 8: Commit**

```bash
git add packages/telemetry/src/schemas packages/telemetry/src/dto packages/telemetry/src/index.ts packages/telemetry/test/dto.test.ts
git commit -m "feat(telemetry): add response DTOs and json schemas for openapi"
```

---

## Task 8: The Telemetry JSON controller

**Files:**
- Create: `packages/telemetry/src/controllers/Telemetry.ts`
- Test: `packages/telemetry/test/controller.telemetry.test.ts`

**Interfaces:**
- Consumes: `TelemetryMiddleware` (Task 4), `InMemoryPerfSink` (Task 5), `HealthCheckRunner` (Task 6), DTOs (Task 7), `ServiceUnavailable` (Task 3).
- Produces: routes `/telemetry/stats`, `/telemetry/timeline`, `/telemetry/routes`, `/telemetry/perf`, `/telemetry/health`, `/telemetry/ready`.

- [ ] **Step 1: Write the failing test**

Create `packages/telemetry/test/controller.telemetry.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { Perf } from '@spinajs/log';

import { TestConfiguration, req, TEST_TOKEN } from './common.js';
import { HealthCheck, IHealthResult } from './../src/health.js';

let failCheck = false;

@Injectable(HealthCheck)
class StubHealthCheck extends HealthCheck {
  public Name = 'stub';

  public check(): Promise<IHealthResult> {
    return Promise.resolve(failCheck ? { status: 'down', message: 'stub is down' } : { status: 'up' });
  }
}

describe('telemetry json api', function () {
  this.timeout(15000);

  before(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    DI.setESMModuleSupport();

    DI.resolve(FsBootsrapper).bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Controllers);
    const server = await DI.resolve(HttpServer);
    server.start();

    // generate some traffic so the aggregates are non-empty
    await req().get('telemetry/health');
    await req().get('telemetry/health');
    await Perf.measure('test.span', () => Promise.resolve(1));
    Perf.count('test.counter', 3);
  });

  beforeEach(() => {
    failCheck = false;
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  describe('auth', () => {
    it('rejects the guarded endpoints without a token', async () => {
      for (const path of ['telemetry/stats', 'telemetry/timeline', 'telemetry/routes', 'telemetry/perf']) {
        const res = await req().get(path);
        expect(res, path).to.have.status(403);
      }
    });

    it('leaves the probe endpoints open', async () => {
      expect(await req().get('telemetry/health')).to.have.status(200);
      expect(await req().get('telemetry/ready')).to.have.status(200);
    });
  });

  describe('GET /telemetry/stats', () => {
    it('returns lifetime stats and the timeline', async () => {
      const res = await req().get('telemetry/stats').set('x-metrics-token', TEST_TOKEN);

      expect(res).to.have.status(200);
      expect(res.body.all.requests).to.be.greaterThan(0);
      expect(res.body.all.req_rate).to.be.greaterThan(0);
      expect(Object.keys(res.body.timeline)).to.not.have.length(0);
    });
  });

  describe('GET /telemetry/timeline', () => {
    it('returns annotated buckets', async () => {
      const res = await req().get('telemetry/timeline').set('x-metrics-token', TEST_TOKEN);

      expect(res).to.have.status(200);
      expect(res.body.bucketMs).to.eq(60000);
      expect(res.body.length).to.eq(60);
      expect(res.body.buckets).to.not.have.length(0);

      const bucket = res.body.buckets[0];
      expect(bucket.key).to.be.a('number');
      expect(bucket.to - bucket.from).to.eq(60000);
      expect(bucket.stats.requests).to.be.greaterThan(0);
    });

    it('limits the bucket count when asked', async () => {
      const res = await req().get('telemetry/timeline?buckets=1').set('x-metrics-token', TEST_TOKEN);

      expect(res).to.have.status(200);
      expect(res.body.buckets).to.have.length(1);
    });

    it('rejects a non-numeric bucket count', async () => {
      const res = await req().get('telemetry/timeline?buckets=abc').set('x-metrics-token', TEST_TOKEN);
      expect(res).to.have.status(400);
    });
  });

  describe('GET /telemetry/routes', () => {
    it('returns a per-route breakdown', async () => {
      const res = await req().get('telemetry/routes').set('x-metrics-token', TEST_TOKEN);

      expect(res).to.have.status(200);
      expect(res.body.truncated).to.eq(false);
      expect(res.body.routes).to.not.have.length(0);

      const health = res.body.routes.find((r: any) => r.route.includes('health'));
      expect(health.method).to.eq('GET');
      expect(health.stats.requests).to.be.greaterThan(0);
    });
  });

  describe('GET /telemetry/perf', () => {
    it('returns aggregated spans and events', async () => {
      const res = await req().get('telemetry/perf').set('x-metrics-token', TEST_TOKEN);

      expect(res).to.have.status(200);
      expect(res.body.spans.find((s: any) => s.name === 'test.span')).to.not.be.undefined;

      const counter = res.body.events.find((e: any) => e.name === 'test.counter');
      expect(counter.total).to.eq(3);
    });
  });

  describe('GET /telemetry/health', () => {
    it('returns liveness info', async () => {
      const res = await req().get('telemetry/health');

      expect(res).to.have.status(200);
      expect(res.body.status).to.eq('up');
      expect(res.body.uptimeMs).to.be.a('number');
      expect(res.body.pid).to.eq(process.pid);
      expect(res.body.version).to.eq('9.9.9');
    });
  });

  describe('GET /telemetry/ready', () => {
    it('returns 200 and the check list when everything is up', async () => {
      const res = await req().get('telemetry/ready');

      expect(res).to.have.status(200);
      expect(res.body.status).to.eq('up');
      expect(res.body.checks.find((c: any) => c.name === 'stub').status).to.eq('up');
    });

    it('returns 503 when a check is down', async () => {
      failCheck = true;

      const res = await req().get('telemetry/ready');

      expect(res).to.have.status(503);
      expect(res.body.status).to.eq('down');
      expect(res.body.checks.find((c: any) => c.name === 'stub').message).to.eq('stub is down');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/controller.telemetry.test.ts`
Expected: FAIL — 404 on every `/telemetry/*` path.

- [ ] **Step 3: Write the controller**

Create `packages/telemetry/src/controllers/Telemetry.ts`:

```ts
import { BasePath, BaseController, Get, Policy, Query, Ok } from '@spinajs/http';
import { Autoinject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { BadRequest } from '@spinajs/exceptions';

import { TelemetryMiddleware } from './../middleware.js';
import { InMemoryPerfSink } from './../InMemoryPerfSink.js';
import { HealthCheckRunner } from './../health.js';
import { ServiceUnavailable } from './../responses.js';

// Importing the DTO barrel runs the @Schema decorators, which is what makes the
// response schemas resolvable by name in the generated OpenAPI document.
import './../dto/index.js';

/**
 * JSON telemetry API. Machine-facing — consumed by dashboards, uptime monitors
 * and orchestrator probes.
 *
 * The prometheus scrape endpoint deliberately lives on its own controller at
 * the bare `/metrics` path, not under this prefix.
 */
@BasePath('telemetry')
export class TelemetryController extends BaseController {
  @Autoinject(TelemetryMiddleware)
  protected Telemetry: TelemetryMiddleware;

  @Autoinject(InMemoryPerfSink)
  protected PerfSink: InMemoryPerfSink;

  @Autoinject(HealthCheckRunner)
  protected Health: HealthCheckRunner;

  @Config('telemetry.health.version')
  protected Version: string;

  /**
   * Lifetime request statistics plus the rolling timeline.
   *
   * @returns {StatsResponse} Lifetime stats and the per-bucket timeline
   * @response 403 Access token missing or invalid
   */
  @Get('/stats')
  @Policy('telemetry.auth.policies.stats')
  public async getStats() {
    const stats = this.Telemetry.RequestStats;
    stats.updateRates(Date.now() - this.Telemetry.StartedAt);

    return new Ok({
      all: stats.toJSON(),
      timeline: this.Telemetry.Timeline.toJSON(),
    });
  }

  /**
   * The rolling timeline alone, with each bucket annotated with the wall-clock
   * window it covers so consumers do not have to reverse the bucket key.
   *
   * @param buckets - how many of the most recent buckets to return; all of them when omitted
   * @returns {TimelineResponse} The annotated timeline
   * @response 400 `buckets` was not a positive integer
   * @response 403 Access token missing or invalid
   */
  @Get('/timeline')
  @Policy('telemetry.auth.policies.timeline')
  public async getTimeline(@Query({ type: 'number', minimum: 1 }) buckets?: number) {
    const timeline = this.Telemetry.Timeline;
    const snapshot = timeline.toJSON();

    let keys = Object.keys(snapshot)
      .map((k) => Number(k))
      .sort((a, b) => a - b);

    if (buckets !== undefined && buckets !== null) {
      // Checked here rather than left to the decorator's schema: a query value
      // arrives as a string, and how the hydrator coerces a non-numeric one is
      // framework detail we do not want the contract to depend on.
      if (!Number.isFinite(buckets) || !Number.isInteger(buckets) || buckets < 1) {
        throw new BadRequest('buckets must be a positive integer');
      }
      keys = keys.slice(-buckets);
    }

    return new Ok({
      bucketMs: timeline.bucketMs,
      length: timeline.length,
      buckets: keys.map((key) => ({
        key,
        from: key * timeline.bucketMs,
        to: (key + 1) * timeline.bucketMs,
        stats: snapshot[String(key)],
      })),
    });
  }

  /**
   * Per method+route request breakdown.
   *
   * No percentiles — query them from prometheus against the `route`-labelled
   * `http_request_duration_ms` histogram, which carries the same label values.
   *
   * @returns {RoutesResponse} Per-route request statistics
   * @response 403 Access token missing or invalid
   */
  @Get('/routes')
  @Policy('telemetry.auth.policies.routes')
  public async getRoutes() {
    return new Ok(this.Telemetry.RouteStats.toJSON());
  }

  /**
   * Aggregated performance measurements collected through the `Perf` facade —
   * every `Perf.measure`, `@Measure`, `Perf.count` and `Perf.value` in the
   * process, including the ORM's `orm.query` spans.
   *
   * @returns {PerfResponse} Aggregated spans and events
   * @response 403 Access token missing or invalid
   */
  @Get('/perf')
  @Policy('telemetry.auth.policies.perf')
  public async getPerf() {
    return new Ok(this.PerfSink.toJSON());
  }

  /**
   * Liveness. Runs no checks, so it can never be made slow or flaky by a
   * dependency — if this answers, the process is alive.
   *
   * @returns {HealthResponse} Process liveness information
   */
  @Get('/health')
  @Policy('telemetry.auth.policies.health')
  public async getHealth() {
    const uptimeMs = Math.round(process.uptime() * 1000);

    return new Ok({
      status: 'up',
      startedAt: Date.now() - uptimeMs,
      uptimeMs,
      pid: process.pid,
      node: process.version,
      ...(this.Version ? { version: this.Version } : {}),
    });
  }

  /**
   * Readiness. Runs every registered `HealthCheck`, each raced against
   * `telemetry.health.timeoutMs`.
   *
   * @returns {ReadyResponse} Overall readiness and the per-check results
   * @response 503 At least one check is down ( or degraded, when `telemetry.health.failOnDegraded` is set )
   */
  @Get('/ready')
  @Policy('telemetry.auth.policies.ready')
  public async getReady() {
    const report = await this.Health.run();

    if (this.Health.isFailing(report.status)) {
      return new ServiceUnavailable(report);
    }

    return new Ok(report);
  }
}
```

Every `@returns {Name}` tag must name a DTO class registered in Task 7 exactly.
A tag naming a class the schema provider does not know degrades silently to an
untyped `object` in the OpenAPI document rather than failing — Task 9 is what
catches that.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/controller.telemetry.test.ts`
Expected: PASS — 12 passing.

- [ ] **Step 5: Run the whole suite**

Run: `cd packages/telemetry && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/telemetry/src/controllers/Telemetry.ts packages/telemetry/test/controller.telemetry.test.ts
git commit -m "feat(telemetry): add stats, timeline, routes, perf, health and ready endpoints"
```

---

## Task 9: Verify the generated OpenAPI document

**Files:**
- Test: `packages/telemetry/test/openapi.test.ts`
- Modify: `packages/telemetry/package.json` (devDependency)

**Interfaces:**
- Consumes: the controllers from Tasks 3 and 8, the DTOs from Task 7.
- Produces: nothing consumed by later tasks.

This task exists because the OpenAPI wiring is the one part of the feature with
no compile-time check: a mistyped `@returns {Name}` tag degrades silently to an
untyped object rather than failing.

- [ ] **Step 1: Add http-swagger as a dev dependency**

In `packages/telemetry/package.json`, extend the `devDependencies` block added
in Task 3:

```json
  "devDependencies": {
    "@spinajs/fs": "^2.0.481",
    "@spinajs/http-swagger": "^2.0.481"
  }
```

Add the project reference to `packages/telemetry/tsconfig.json` only (not the
mjs/cjs build configs — this is test-only):

```json
    { "path": "../http-swagger/tsconfig.json" }
```

- [ ] **Step 2: Write the test**

The document is fetched over HTTP from `docs/swagger.json` rather than built
through `SwaggerService` directly — that is the path `packages/http-swagger`'s
own tests exercise, and it covers the controller-cache and JSDoc-extraction
machinery end to end. Importing `@spinajs/http-swagger` for its side effects is
what registers that route.

Create `packages/telemetry/test/openapi.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import '@spinajs/http-swagger';

import { TestConfiguration, req } from './common.js';

describe('telemetry openapi document', function () {
  this.timeout(30000);

  let doc: any;

  before(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    DI.setESMModuleSupport();

    DI.resolve(FsBootsrapper).bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Controllers);
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.start();

    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    doc = JSON.parse(result.text);
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  it('documents every telemetry path', () => {
    for (const path of ['/metrics', '/telemetry/stats', '/telemetry/timeline', '/telemetry/routes', '/telemetry/perf', '/telemetry/health', '/telemetry/ready']) {
      expect(doc.paths[path], `${path} is missing from the document`).to.not.be.undefined;
    }
  });

  it('references a real component schema for each json response', () => {
    const expected: Record<string, string> = {
      '/telemetry/stats': 'StatsResponse',
      '/telemetry/timeline': 'TimelineResponse',
      '/telemetry/routes': 'RoutesResponse',
      '/telemetry/perf': 'PerfResponse',
      '/telemetry/health': 'HealthResponse',
      '/telemetry/ready': 'ReadyResponse',
    };

    for (const [path, name] of Object.entries(expected)) {
      const schema = doc.paths[path].get.responses['200'].content['application/json'].schema;
      expect(schema.$ref, `${path} should $ref ${name}`).to.eq(`#/components/schemas/${name}`);
      expect(doc.components.schemas[name], `${name} component is missing`).to.not.be.undefined;
      expect(Object.keys(doc.components.schemas[name].properties ?? {}), `${name} has no properties`).to.not.have.length(0);
    }
  });

  it('documents the buckets query parameter', () => {
    const params = doc.paths['/telemetry/timeline'].get.parameters ?? [];
    const buckets = params.find((p: any) => p.name === 'buckets');

    expect(buckets).to.not.be.undefined;
    expect(buckets.in).to.eq('query');
    expect(buckets.schema.type).to.eq('number');
  });

  it('documents the 503 on readiness and the 403 on the guarded endpoints', () => {
    expect(doc.paths['/telemetry/ready'].get.responses['503']).to.not.be.undefined;
    expect(doc.paths['/telemetry/stats'].get.responses['403']).to.not.be.undefined;
  });
});
```

- [ ] **Step 3: Run the test**

Run: `cd packages/telemetry && npx ts-mocha --exit -p tsconfig.json test/openapi.test.ts`
Expected: PASS — 4 passing.

If a `$ref` assertion fails, the cause is almost always one of: the JSDoc tag
naming a class that does not exist, the DTO barrel not being imported by the
controller, or the JSDoc living on a non-exported member so it never reached the
emitted `.d.ts`. Fix the cause; do not weaken the assertion.

- [ ] **Step 4: Commit**

```bash
git add packages/telemetry/package.json packages/telemetry/tsconfig.json packages/telemetry/test/openapi.test.ts
git commit -m "test(telemetry): assert the generated openapi document covers every endpoint"
```

---

## Task 10: Delete `@spinajs/metrics`, document the migration

**Files:**
- Delete: `packages/metrics/` (whole directory)
- Modify: `packages/telemetry/README.md`
- Create: `docs/migrations/2026-07-23-metrics-to-telemetry.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

This is the only irreversible task, and it comes last on purpose — the
replacement is fully tested by now.

- [ ] **Step 1: Confirm nothing in the monorepo depends on the package**

Run: `cd c:/Users/grzch/SourceCodes/Spinajs-Agent-4/main && grep -rn "@spinajs/metrics" packages --include=package.json --include=*.ts --include=*.json | grep -v node_modules | grep -v "^packages/metrics/"`
Expected: no output. If anything is listed, repoint it at `@spinajs/telemetry`
before continuing.

- [ ] **Step 2: Delete the package**

```bash
git rm -r packages/metrics
```

- [ ] **Step 3: Write the migration document**

Create `docs/migrations/2026-07-23-metrics-to-telemetry.md`:

```markdown
# Migrating from `@spinajs/metrics` to `@spinajs/telemetry`

`@spinajs/metrics` is removed. `@spinajs/telemetry` replaces it and adds a JSON
telemetry API, per-request performance metrics and health/readiness probes.

## The breaking part: metric series renamed

`@spinajs/metrics` collected http metrics with `express-prom-bundle`, which
reports **seconds**. `@spinajs/telemetry` reports **milliseconds** with
different label names. Queries over the old series return no data rather than
erroring, so dashboards and alerts go quiet instead of red. Update them.

| Before | After |
| --- | --- |
| `http_request_duration_seconds{status_code,method,path}` | `http_request_duration_ms{status,method,route}` |
| `http_requests_total{status_code,method,path}` | `http_requests_total{status,method,route}` |
| — | `http_requests_in_flight` |
| — | `perf_span_duration_ms{name}` |
| — | `perf_events_total{name}` |
| — | `perf_scope_total_ms{name}` |

Durations are in milliseconds throughout, so a query like
`histogram_quantile( 0.95, sum by (le) ( rate( http_request_duration_seconds_bucket[5m] ) ) )`
becomes
`histogram_quantile( 0.95, sum by (le) ( rate( http_request_duration_ms_bucket[5m] ) ) )`
and its result is now in ms.

Unchanged: the scrape path is still `/metrics` and the auth header is still
`x-metrics-token`, so Prometheus `scrape_configs` need no edit.

## Configuration

| Before | After |
| --- | --- |
| `metrics.auth.token` | `telemetry.auth.token` |
| `metrics.auth.policy` | `telemetry.auth.policies.<endpoint>` — one key per endpoint |
| `metrics.http.*` ( express-prom-bundle options ) | removed; use `telemetry.prefix` and `telemetry.buckets` |

## Code

| Before | After |
| --- | --- |
| `import { Gauge, Counter, Histogram, Summary } from '@spinajs/metrics'` | `import { ... } from 'prom-client'` |
| `new Metrics().histogram( name, cfg )` | `DI.get( Metrics ).defineMetrics( prefix, [ { name, help, type: 'histogram' } ] )` |
| `DefaultMetricsPolicy` | `TelemetryTokenPolicy` |
| `MetricsBootstrapper` | `TelemetryBootstrapper` ( automatic ) |

`Metrics.counter()` in the old package constructed a `Gauge`, not a `Counter`.
Anything that relied on the resulting series being gauge-shaped will see a
counter after migrating — which is what the call always asked for.

## Steps

1. `npm uninstall @spinajs/metrics && npm install @spinajs/telemetry`
2. Rename the config keys per the table above.
3. Replace `@spinajs/metrics` imports per the table above.
4. Update dashboards and alert rules for the renamed series.
5. Optionally set `telemetry.health.version` and register `HealthCheck`
   implementations for `/telemetry/ready`.
```

- [ ] **Step 4: Rewrite the telemetry README's quick-start section**

In `packages/telemetry/README.md`, replace the `## Quick start` section — which
currently tells the reader to wire the handlers into their own router — with:

````markdown
## Quick start

Install the package. The controllers, middleware, perf bridge and default
process metrics are wired automatically; set the auth token and you are done.

```ts
// configuration
{
  telemetry: {
    auth: { token: process.env.METRICS_TOKEN },
  },
}
```

| Endpoint | Returns | Default access |
| --- | --- | --- |
| `GET /metrics` | Prometheus exposition text | token |
| `GET /telemetry/stats` | `{ all, timeline }` — lifetime stats + rolling timeline | token |
| `GET /telemetry/timeline?buckets=N` | The timeline alone, buckets annotated with their window | token |
| `GET /telemetry/routes` | Per method+route request breakdown | token |
| `GET /telemetry/perf` | Aggregated `Perf` spans and events | token |
| `GET /telemetry/health` | Liveness — uptime, pid, version | public |
| `GET /telemetry/ready` | Readiness — runs every registered `HealthCheck`, 503 when any is down | public |

Guarded endpoints expect the token on the `x-metrics-token` header:

```bash
curl -H "x-metrics-token: $METRICS_TOKEN" http://localhost:8080/metrics
```

Every endpoint's policy is a config key, so access can be changed without code:

```ts
telemetry: {
  auth: {
    policies: {
      metrics: 'TelemetryTokenPolicy',
      health: 'PublicPolicy',   // probes cannot carry a token
    },
  },
}
```

`/health` and `/ready` are public by default because kubelet probes and load
balancers cannot send a header. They expose uptime, pid and — if you set
`telemetry.health.version` — the app version. Point them at
`TelemetryTokenPolicy` if that is more than you want to publish.

### Readiness checks

Telemetry ships no concrete checks. Register your own:

```ts
import { Injectable } from '@spinajs/di';
import { HealthCheck, IHealthResult } from '@spinajs/telemetry';

@Injectable(HealthCheck)
export class DatabaseCheck extends HealthCheck {
  public Name = 'database';

  public async check(): Promise<IHealthResult> {
    try {
      await db.raw('select 1');
      return { status: 'up' };
    } catch (err) {
      return { status: 'down', message: (err as Error).message };
    }
  }
}
```

Each check is raced against `telemetry.health.timeoutMs` ( default 2000 ), so a
hung dependency cannot hang the probe — a timed-out check counts as `down`.

### Mounting on a bare express app

`metricsHandler( metrics )` and `statsHandler( mw )` are still exported for apps
that do not use the SpinaJS controller stack:

```ts
router.get('/metrics', metricsHandler(await DI.resolve(Metrics)));
```
````

- [ ] **Step 5: Add the configuration reference to the README**

Append to `packages/telemetry/README.md`, before the final `## Notes` section:

````markdown
## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `telemetry.auth.token` | `''` | Expected value of the `x-metrics-token` header |
| `telemetry.auth.policies.<endpoint>` | see below | Policy class name per endpoint |
| `telemetry.collectDefaultMetrics` | `true` | Register `process_*` / `nodejs_*` metrics |
| `telemetry.prefix` | `'http'` | Metric name prefix for the http metrics |
| `telemetry.buckets` | `[5,10,25,50,100,250,500,1000,2500,5000,10000]` | Duration histogram buckets ( ms ) |
| `telemetry.apdexThresholdMs` | `25` | Apdex satisfied threshold; tolerated is 4x |
| `telemetry.timeline.length` | `60` | Buckets retained in the timeline ring |
| `telemetry.timeline.bucketMs` | `60000` | Timeline bucket width |
| `telemetry.routes.enabled` | `true` | Collect the per-route breakdown |
| `telemetry.routes.maxEntries` | `500` | Cap on distinct method+route keys |
| `telemetry.perf.enabled` | `true` | Collect the in-memory perf aggregate |
| `telemetry.perf.maxNames` | `200` | Cap on distinct measurement names |
| `telemetry.health.timeoutMs` | `2000` | Per-check timeout for `/ready` |
| `telemetry.health.failOnDegraded` | `false` | Serve 503 for a degraded status |
| `telemetry.health.version` | unset | Version string reported by `/health` |

Policy defaults: `TelemetryTokenPolicy` for `metrics`, `stats`, `timeline`,
`routes` and `perf`; `PublicPolicy` for `health` and `ready`.

### Cardinality

Both the `route` label and the perf `name` label are meant for bounded
vocabularies. The `maxEntries` / `maxNames` caps bound the JSON views, but the
Prometheus histograms have no such cap — the `route` label falls back to the raw
request path when no route matched, so a 404-scanning bot inflates the series
count. Put telemetry behind a router that 404s unmatched paths early, or subclass
`TelemetryMiddleware` and override `routeLabel()` to collapse unmatched requests
to a constant.
````

- [ ] **Step 6: Remove the stale registration-timing section**

The README's "Registration timing" subsection tells the reader to resolve
`PromMetricSink` manually when using telemetry without `@spinajs/http`.
`TelemetryBootstrapper` now does this. Replace that subsection's body with:

```markdown
`TelemetryBootstrapper` resolves both perf sinks at startup and calls
`Perf.refreshSinks()`, so the bridge is live whether or not `@spinajs/http` is
installed. No manual wiring is needed.
```

- [ ] **Step 7: Verify the monorepo still builds and telemetry's tests pass**

Run: `cd packages/telemetry && npm run compile && npm test`
Expected: compile exit 0; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A packages/metrics packages/telemetry/README.md docs/migrations
git commit -m "feat(telemetry)!: remove @spinajs/metrics, document the migration

BREAKING CHANGE: @spinajs/metrics is removed. The http metric series are renamed
from http_request_duration_seconds{status_code,method,path} to
http_request_duration_ms{status,method,route} — dashboards and alert rules must
be updated. See docs/migrations/2026-07-23-metrics-to-telemetry.md."
```

- [ ] **Step 9: Deprecate the published package**

This is a manual step for whoever publishes — not something to run from an agent
session. Note it in the PR description:

```bash
npm deprecate @spinajs/metrics "Replaced by @spinajs/telemetry — see docs/migrations/2026-07-23-metrics-to-telemetry.md"
```
