# Configuration Phase 3: the authn packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `authn-http`, `authn-keys`, `authn-oidc`, `authn-orm`, `authn-totp`, `authn-local`, `authn-token`, `authn-session` and a new `http` schema module read their configuration through `@Config` and validate it with JSON schemas, so the hand-written `read*`/`check*` validators and the manual `Configuration.get` reads go away.

**Architecture:** The recipe of the parent plan (`2026-10-05-config-injection-and-schema-validation.md`, "Phases 2 to 6"), applied to the rows of "Phase 3: authn packages". Rules and defaults move into a schema (`AUTHN_CONFIGURATION_SCHEMA`, a new `HTTP_CONFIGURATION_SCHEMA`, and authn-oidc's own `AUTHN_OIDC_CONFIGURATION_SCHEMA`); tests boot through a child `Configuration` and assert `InvalidConfiguration.violations[].path`; the class reads `@Config('<key>')`.

**Tech Stack:** TypeScript, `@spinajs/di`, `@spinajs/configuration` (Ajv 8: `useDefaults`, `coerceTypes`, `removeAdditional: true`, `$data`, ajv-formats, ajv-keywords), mocha with chai, ts-mocha.

## Preconditions and facts verified against the current tree

1. **Phase 0 and the pilot.** `@Config` currently (working tree of `packages/configuration/src/decorators.ts`, not yet committed when this plan was written) injects the resolving CONTAINER under the exported constant `CONFIGURATION_CONTAINER_KEY` and reads `container.get(Configuration)` on every access; `mechanism-notes.md` says "the constant exported by decorators.ts". The Task 5 brief still names `CONFIGURATION_INJECTION_KEY` holding a Configuration: that is stale. Before Task 3.1 starts, the decorators change must be committed; every `new X()` seam below uses `CONFIGURATION_CONTAINER_KEY` with a container. If the committed constant has another name, change the one import in the shared test helper (below) and nothing else.
2. **Phase 2 is not landed.** `git log` has no "authn.audit through @Config" commit, and `readThrottleConfig`, `readMaxAge` and the `mfa.policy.service` and `freshAuth.maxAgeSeconds` schema defaults still live in the old form. Tasks 3.4 (authn-totp), 3.5 (authn-orm) and 3.10 (MFA policy name) therefore state, in their Step 1, which schema line they need and add it when Phase 2 has not (each fragment is marked "skip when present").
3. **The app Ajv removes additional properties.** `initValidator` builds Ajv with `removeAdditional: true`, so `additionalProperties: false` silently DELETES an unknown key instead of reporting it. Every "no other keys" rule below is a `propertyNames: { enum: [...] }` (the pilot's `authn.audit` rule). The existing `AUTHN_OIDC_PROVIDER_SCHEMA` and `AUTHN_OIDC_CONFIGURATION_SCHEMA` use `additionalProperties: false` and are rewritten in Task 3.11, and `jwt.issuers[].linking` in the authn schema is rewritten in Task 3.3. `coerceTypes: true` also applies: `null` becomes `''` for a `string`, and `0`, `1`, `true`, `false` convert between number and boolean, so a union that must keep `0` or `null` is written as `authn.http.trustProxy` is (an `anyOf` with a `nullable` integer).
4. **Inventory names that differ from the code.** The row "authn-http extractors" lists `http.publicOrigin`; the key every reader uses is `authn.http.publicOrigin`, so it goes into the `authn.http` block of `AUTHN_CONFIGURATION_SCHEMA`. The schema uses an origin `pattern`, not `format: 'uri'` (a URI with a path would pass `uri` and then be cut down to an origin).
5. **Packages must not import the `@spinajs/authn` root from `src`.** The root registers `DefaultAuthnService`, `MemoryAuthnThrottle` and the bootstrapper as a side effect (authn-http loads it lazily for that reason). Pure values that other packages need (`isFresh`, the throttle parameter types and `backoffDelayMs`) therefore move into `@spinajs/authn/contracts`, and the env helpers get a new `@spinajs/authn/env` subpath.
6. **Shipped package configs stay.** A package config file loads whether or not its package is imported, so authn-token's and authn-totp's shipped `authn.*` values keep serving apps that do not load the `@spinajs/authn` bootstrapper. Each schema `default` that duplicates a shipped value is pinned equal to it by a test (as `authn/test/boot/config-defaults.test.ts` does).
7. **Tests that boot the ROOT Configuration** (authn-token, authn-totp, authn-http, authn-local and authn-session suites do) lose the code defaults that moved into a schema, because no bootstrapper ran. Such a suite registers the schema before it resolves the Configuration: `DI.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__')` (or `new AuthnConfigBootstrapper().bootstrap()`); each task names the fixture to change.

## Shared test helper H

Every task that needs a booted Configuration copies this file verbatim to `packages/<pkg>/test/support/config-boot.ts` (the packages have no common test module that avoids a dependency cycle). `authn` already has the equivalent `configurationOf(values, env?, isolated?)` in `test/behaviour/harness.ts` and uses that one.

```ts
import { Configuration, CONFIGURATION_CONTAINER_KEY, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

export function configurationOf(values: Record<string, unknown>, env = 'test'): Class<Configuration> {
  const json = JSON.stringify(values);
  return class SpecConfiguration extends FrameworkConfiguration {
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

export interface Booted {
  readonly child: IContainer;
  readonly configuration: Configuration;
}

const open: IContainer[] = [];

/** A child container with these schemas and values; the Configuration is resolved, so its validation has run. */
export async function boot(schemas: readonly object[], values: Record<string, unknown>, env?: string): Promise<Booted> {
  const child = DI.RootContainer.child();
  open.push(child);
  for (const schema of schemas) child.register(schema).asValue('__configurationSchema__');
  child.register(configurationOf(values, env)).as(Configuration);
  return { child, configuration: await child.resolve(Configuration) };
}

/** The full paths of the violations the boot reports; [] when it succeeds. */
export async function violationsOf(schemas: readonly object[], values: Record<string, unknown>, env?: string): Promise<string[]> {
  try {
    await boot(schemas, values, env);
    return [];
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  }
}

export async function disposeBooted(): Promise<void> {
  for (const c of open.splice(0)) await c.dispose();
}

/** For an instance built with `new`: makes its `@Config` properties read this container's Configuration. */
export function readingFrom<T extends object>(instance: T, container: IContainer): T {
  Object.defineProperty(instance, CONFIGURATION_CONTAINER_KEY, { value: container, configurable: true, writable: true });
  return instance;
}

/** A container whose Configuration answers `values` by full path (a unit-test stand-in; the values are not validated). */
export function fakeContainer(values: Record<string, unknown>): IContainer {
  const keyOf = (path: string | string[]): string => (Array.isArray(path) ? path.join('.') : path);
  const configuration = { get: (path: string | string[], fallback?: unknown) => (keyOf(path) in values ? values[keyOf(path)] : fallback) };
  return { get: () => configuration } as unknown as IContainer;
}
```

Every test file that uses it registers `afterEach(disposeBooted)` in its top-level `describe`.

## Task order and parallelism

The rows share two resources: `packages/authn/src/schemas/authn.configuration.ts` (edited by 3.3, 3.4, 3.6, 3.7, 3.8, 3.9, 3.10 and 3.11) and the `lib/` of `@spinajs/authn` (rebuilt by every task that touches `packages/authn`, and read by the test suites of all the others). A task that edits that file or rebuilds that lib must not overlap another one.

| Order | Task | Packages edited | Needs |
|---|---|---|---|
| 1 | 3.1 http schema module | http | none |
| 1 | 3.2 authn-session env reuse | authn (package.json), authn-session | none |
| 2 | 3.3 authn-token | authn (schema), authn-token | 3.1, 3.2 |
| 3 | 3.4 authn-totp | authn (schema, contracts), authn-totp | 3.3 |
| 4 | 3.5 authn-orm `DbAuthnThrottle` | authn (contracts, throttle), authn-orm | 3.4 |
| 5 | 3.6 authn-local | authn (schema), authn-local | 3.5 |
| 6 | 3.7 authn-keys | authn (schema), authn-keys | 3.6 |
| 7 | 3.8 authn-http extractors | authn (schema), authn-http | 3.3, 3.7 |
| 8 | 3.9 authn-http `AuthnMiddleware`, `ClientIp`, `CsrfOriginGuard` | authn (schema), authn-http | 3.1, 3.2, 3.8 |
| 9 | 3.10 authn-http MFA policy name | authn-http (authn schema only if Phase 2 has not landed) | 3.9 |
| 10 | 3.11 authn-oidc | authn (schema: removes the `oidc` block), authn-oidc | 3.1, 3.5, 3.9 |

**Parallel groups.** Only one pair is safe: **3.1 and 3.2** (disjoint packages and disjoint libs: http versus authn plus authn-session; neither suite reads the other's lib). Everything after them is a single chain, because each task edits the authn schema file or rebuilds `authn/lib`, and each authn-http task also reads the `lib/` of http, authn-session, authn-token and authn-totp. Authoring the tasks in separate worktrees is possible (the schema hunks are in different blocks) but they must be integrated and re-tested in the order above. The authn-http tasks (3.8, 3.9, 3.10) all edit `packages/authn-http` and are sequential among themselves even without the schema file.

Dependants run sequentially, never in parallel with a rebuild: `for p in <list>; do (cd packages/$p && npm test) || break; done`.

## Rows verified and left as they are

- authn-http `v3/responses.ts` (`authnSessionCookie`, `authnClearedSessionCookie`) and `LoginController.mfaStepsRequired` / `configuredStepRequired` (2.x path, out of scope per the parent plan): they take a `Configuration` argument or are deprecated 2.x code, and the schema already validates their keys. Not changed.
- authn-oidc `FetchOidcHttpClient`: `@Config` cannot apply (see Task 3.11); its only read is the app env.
- authn-orm `AuthnFromUserMetadata` migration (`container.get(Configuration)` at line 303): a migration helper that takes an explicit container; not in the inventory. Not changed.
- authn-totp `Default2FaToken` and `Generate2FaQrCode` already use `@Config('authn.mfa.totp')`; they now get validated and defaulted values from Task 3.4 without a code change.
- http-socket `assertLimitsConfig` and the `http.socket` readers belong to Phase 6; Task 3.1 only adds the `http.socket` schema block, which Phase 6 then relies on. The http middlewares (`RealIp`, `CorsMiddleware`, `ThrottleMiddleware`) also stay on `Configuration.get` until Phase 6; their parsers (`parseTrustProxy`, `parseOrigin`) are reused by the tasks below.

---

### Task 3.1: The `http` schema module (`trustProxy`, `cookie.secret`, `cors`, `throttle`, `socket`)

Row: authn-http `AuthnMiddleware`, `ClientIp`, `CsrfOriginGuard` (schema addition "new `http` schema module"), and the shared parser decision for `parseTrustProxy`.

**Files:**
- Create: `packages/http/src/schemas/http.configuration.ts`
- Modify: `packages/http/src/bootstrap.ts` (add `HttpConfigBootstrapper`; the existing `HttpBootstrapper` stays as it is)
- Modify: `packages/http/src/index.ts` (add one export line after `export * from './bootstrap.js';`)
- Modify: `packages/http/src/config/http.ts:83-106` (delete the `trustProxy` and `throttle` entries and their doc comments; the defaults move into the schema)
- Create: `packages/http/test/support/config-boot.ts` (helper H, verbatim)
- Create: `packages/http/test/http-configuration-schema.test.ts`

**Interfaces:**
- Consumes: `registerConfigurationSchema` from `@spinajs/configuration`. `@spinajs/http` already depends on `@spinajs/configuration` (`package.json` line 72, `RealIp.ts` imports it), and `@spinajs/configuration` does not depend on `@spinajs/http`, so a bootstrapper in `packages/http` creates no cycle.
- Produces: `HTTP_CONFIGURATION_SCHEMA` (`$configurationModule: 'http'`), `HttpConfigBootstrapper`, and validated, defaulted `http.trustProxy`, `http.cookie.secret`, `http.cors`, `http.throttle`, `http.socket`. Shared parsers, unchanged and reused by later tasks: `parseTrustProxy`, `isTrustedPeer`, `trustedClientAddress`, `requestOrigin` (`RealIp.ts`) and `parseOrigin` (`Cors.ts`). They keep the one job a schema cannot do: compiling a trust setting into a `BlockList` (CIDR arithmetic) and normalising an origin through `new URL`. Their shape checks (type of the value) are removed in Phase 6, when `RealIp`, `CorsMiddleware` and `ThrottleMiddleware` move to `@Config`.

- [ ] **Step 1: Schema (new file) and defaults moved out of the shipped config**

`packages/http/src/schemas/http.configuration.ts`:

```ts
const nonEmpty = { type: 'string', minLength: 1 };

// Scheme, host and optional port; no path, query, credentials, wildcard, backslash or space. parseOrigin still normalises
// the entry (case, default port) and refuses what a pattern cannot judge (a port above 65535, a broken IPv6 literal).
const ORIGIN_PATTERN = '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#*@\\\\\\s]+/?$';

const headerList = { type: ['array', 'string', 'null'], items: { type: 'string' } };
const positive = { type: 'number', exclusiveMinimum: 0 };
const positiveInteger = { type: 'integer', minimum: 1 };

export const HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/http.configuration.schema.json',
  $configurationModule: 'http',
  description: 'HTTP server configuration (http.*)',
  type: 'object',
  properties: {
    cookie: {
      type: 'object',
      properties: {
        // The public default ships in the package config, so there is no schema default; absence is refused by the session code.
        secret: { ...nonEmpty, description: 'Signs cookies. The shipped value is public: set your own.' },
      },
    },
    // Not a type union: with coerceTypes, 0 (trust no proxy) would become null. The string branch refuses a string that is
    // only a number, because coerceTypes would otherwise turn -1 or 1.5 into the string "-1" and accept it.
    trustProxy: {
      anyOf: [
        { type: 'array', items: { type: 'string', minLength: 1 } },
        { type: 'integer', minimum: 0, nullable: true },
        { type: 'string', pattern: '^(?![+-]?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$)' },
      ],
      default: null,
      description:
        'Proxies in front of the app whose X-Forwarded-For counts (RealIp, and authn ClientIp when authn.http.trustProxy is null): a hop count, or addresses, CIDRs and the names loopback, linklocal and uniquelocal (an array, or a comma-separated string). null or 0: no proxy. true coerces to one hop and false to none, never to trust-all. The first X-Forwarded-Proto and -Host value from a trusted proxy counts too, so that proxy must overwrite both headers.',
    },
    cors: {
      type: ['object', 'boolean', 'null'],
      description: 'Absent or falsy: no CORS middleware. Origins are listed as scheme://host[:port] or the one entry *.',
      properties: {
        origins: { type: ['array', 'null'], items: { anyOf: [{ const: '*' }, { type: 'string', pattern: ORIGIN_PATTERN }] } },
        exposedHeaders: headerList,
        allowedHeaders: headerList,
      },
    },
    throttle: {
      type: 'object',
      default: {},
      description: 'Per-ip, per-route rate limiting (ThrottleMiddleware). Off by default: the authn throttle is the real login limiter.',
      properties: {
        enabled: { type: 'boolean', default: false },
        rules: {
          type: 'array',
          default: [],
          description: 'The first rule whose path prefix (on a segment boundary) and methods match wins.',
          items: {
            type: 'object',
            required: ['path', 'limit', 'windowSeconds'],
            properties: {
              path: nonEmpty,
              methods: { type: 'array', items: nonEmpty },
              limit: positiveInteger,
              windowSeconds: positiveInteger,
            },
          },
        },
      },
    },
    socket: {
      type: 'object',
      description: 'Ranges and cross-field rules of the socket server (http-socket). Defaults stay in the http-socket package config.',
      properties: {
        path: nonEmpty,
        pingInterval: positiveInteger,
        pingTimeout: positiveInteger,
        drainMs: { type: 'number', minimum: 0 },
        maxPayloadBytes: positiveInteger,
        maxInFlightPerConnection: positiveInteger,
        // A cap below the burst would drop events the rate limit lets through.
        maxInFlightEventsPerConnection: { type: 'integer', exclusiveMinimum: 0, minimum: { $data: '1/rate/burst' } },
        rate: { type: 'object', properties: { perSecond: positive, burst: positive } },
        auth: { type: 'object', properties: { required: { type: 'boolean' }, revalidateMs: { type: 'number', minimum: 0 } } },
        recovery: { type: 'object', properties: { maxDisconnectionMs: { type: 'number', minimum: 0 } } },
        ordering: { type: 'object', properties: { abortGraceMs: positive } },
        hooks: { type: 'object', properties: { connectTimeoutMs: positive } },
        transports: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['websocket', 'polling'] } },
      },
    },
  },
};
```

`packages/http/src/index.ts`: add `export * from './schemas/http.configuration.js';` after `export * from './bootstrap.js';`.

`packages/http/src/bootstrap.ts`: add the imports and the class (the file's existing `HttpBootstrapper` is untouched):

```ts
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { registerConfigurationSchema } from '@spinajs/configuration';
import { DateTimeHydrator } from './hydrators/DateTimeHydrator.js';
import { DateTime } from 'luxon';
import { HTTP_CONFIGURATION_SCHEMA } from './schemas/http.configuration.js';

/** Registers the http.* schema, so the configuration validates the merged tree and fills its defaults. */
@Injectable(Bootstrapper)
export class HttpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(HTTP_CONFIGURATION_SCHEMA);
  }
}
```

`packages/http/src/config/http.ts`: delete lines 83-106, that is the doc comment and `trustProxy: null as ...,` (83-93), the blank line, and the doc comment and `throttle: { enabled: false, rules: [...] },` (95-105). `ssl` follows `upload`. The text of both comments now lives in the schema `description`s above.

- [ ] **Step 2: Write the failing tests**

Copy helper H to `packages/http/test/support/config-boot.ts`. Then `packages/http/test/http-configuration-schema.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';

import { HttpConfigBootstrapper } from '../src/bootstrap.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { boot, disposeBooted, violationsOf } from './support/config-boot.js';

const SCHEMAS = [HTTP_CONFIGURATION_SCHEMA];
const bad = (http: Record<string, unknown>) => violationsOf(SCHEMAS, { http });

describe('http configuration schema', () => {
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('gives an unconfigured http module no trusted proxy and a disabled throttle', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('http.trustProxy')).to.eq(null);
      expect(configuration.get('http.throttle')).to.deep.eq({ enabled: false, rules: [] });
    });

    it('keeps a configured throttle and fills the rest', async () => {
      const { configuration } = await boot(SCHEMAS, { http: { throttle: { rules: [{ path: '/auth', limit: 5, windowSeconds: 60 }] } } });
      expect(configuration.get('http.throttle.enabled')).to.eq(false);
      expect(configuration.get('http.throttle.rules')).to.deep.eq([{ path: '/auth', limit: 5, windowSeconds: 60 }]);
    });
  });

  describe('trustProxy', () => {
    it('accepts a hop count, 0, a list and a comma-separated string unchanged', async () => {
      for (const value of [0, 2, ['10.0.0.0/8', 'loopback'], '10.0.0.1, 10.0.0.2', null]) {
        const { configuration } = await boot(SCHEMAS, { http: { trustProxy: value } });
        expect(configuration.get('http.trustProxy'), JSON.stringify(value)).to.deep.eq(value);
      }
    });

    it('turns true into one hop, never trust-all', async () => {
      const { configuration } = await boot(SCHEMAS, { http: { trustProxy: true } });
      expect(configuration.get('http.trustProxy')).to.eq(1);
    });

    it('names http.trustProxy for a negative count, a fraction and an object', async () => {
      for (const value of [-1, 1.5, {}]) expect(await bad({ trustProxy: value }), JSON.stringify(value)).to.include('http.trustProxy');
    });
  });

  describe('cookie.secret', () => {
    it('refuses an empty secret and a null one (coerced to empty)', async () => {
      expect(await bad({ cookie: { secret: '' } })).to.include('http.cookie.secret');
      expect(await bad({ cookie: { secret: null } })).to.include('http.cookie.secret');
    });

    it('accepts a secret', async () => {
      expect(await bad({ cookie: { secret: 'k'.repeat(40) } })).to.deep.eq([]);
    });
  });

  describe('cors', () => {
    it('accepts no CORS, listed origins and the wildcard', async () => {
      for (const cors of [false, null, {}, { origins: [] }, { origins: null }, { origins: ['*', 'https://app.example.com:8443'] }, { origins: ['https://app.example.com/'], exposedHeaders: ['x-a'], allowedHeaders: 'x-b, x-c' }]) {
        expect(await bad({ cors }), JSON.stringify(cors)).to.deep.eq([]);
      }
    });

    it('names the bad origin entry', async () => {
      const entries = ['partner.example.org', 'https://partner.example.org/app', 'https://*.example.org', 'https://user@partner.example.org', 'null', ''];
      for (const entry of entries) expect(await bad({ cors: { origins: ['https://ok.example.com', entry] } }), JSON.stringify(entry)).to.include('http.cors.origins.1');
      expect(await bad({ cors: { origins: 'https://ok.example.com' } })).to.include('http.cors.origins');
    });
  });

  describe('throttle', () => {
    it('names the bad rule field', async () => {
      expect(await bad({ throttle: { rules: [{ path: '/a', limit: 0, windowSeconds: 60 }] } })).to.include('http.throttle.rules.0.limit');
      expect(await bad({ throttle: { rules: [{ path: '/a', limit: 5, windowSeconds: 1.5 }] } })).to.include('http.throttle.rules.0.windowSeconds');
      expect(await bad({ throttle: { rules: [{ path: '', limit: 5, windowSeconds: 60 }] } })).to.include('http.throttle.rules.0.path');
      expect(await bad({ throttle: { rules: [{ limit: 5, windowSeconds: 60 }] } })).to.include('http.throttle.rules.0.path');
      expect(await bad({ throttle: { enabled: 'maybe' } })).to.include('http.throttle.enabled');
    });
  });

  describe('socket', () => {
    const sound = { rate: { perSecond: 20, burst: 40 }, maxPayloadBytes: 1024, maxInFlightPerConnection: 32, maxInFlightEventsPerConnection: 128, auth: { required: false, revalidateMs: 0 }, transports: ['websocket'] };

    it('accepts the shipped shape', async () => {
      expect(await bad({ socket: sound })).to.deep.eq([]);
    });

    it('names the key of every range the limits check used to throw RangeError for', async () => {
      expect(await bad({ socket: { ...sound, rate: { perSecond: 0, burst: 40 } } })).to.include('http.socket.rate.perSecond');
      expect(await bad({ socket: { ...sound, maxPayloadBytes: 0 } })).to.include('http.socket.maxPayloadBytes');
      expect(await bad({ socket: { ...sound, maxInFlightPerConnection: 1.5 } })).to.include('http.socket.maxInFlightPerConnection');
      expect(await bad({ socket: { ...sound, auth: { revalidateMs: -1 } } })).to.include('http.socket.auth.revalidateMs');
      expect(await bad({ socket: { ...sound, transports: ['websocket', 'tcp'] } })).to.include('http.socket.transports.1');
      expect(await bad({ socket: { ...sound, transports: [] } })).to.include('http.socket.transports');
    });

    it('requires the event cap to be at least the burst ($data)', async () => {
      expect(await bad({ socket: { ...sound, rate: { perSecond: 1, burst: 200 } } })).to.include('http.socket.maxInFlightEventsPerConnection');
      expect(await bad({ socket: { ...sound, rate: { perSecond: 1, burst: 128 } } })).to.deep.eq([]);
    });
  });

  it('reports every violation, not the first', async () => {
    const found = await bad({ trustProxy: -1, cors: { origins: ['nope'] }, throttle: { rules: [{ path: '/a', limit: 0, windowSeconds: 60 }] } });
    expect(found).to.include.members(['http.trustProxy', 'http.cors.origins.0', 'http.throttle.rules.0.limit']);
  });
});

describe('HttpConfigBootstrapper', () => {
  const schemas = (): unknown[] => (DI.get(Array.ofType('__configurationSchema__' as never)) as unknown[] | null) ?? [];
  let saved: unknown[] = [];

  beforeEach(() => {
    saved = [...schemas()];
  });

  afterEach(() => {
    DI.uncache('__configurationSchema__' as never);
    for (const other of saved) DI.register(other as never).asValue('__configurationSchema__');
  });

  it('registers the http schema under __configurationSchema__', () => {
    new HttpConfigBootstrapper().bootstrap();
    expect(schemas()).to.include(HTTP_CONFIGURATION_SCHEMA);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd packages/http && npx ts-mocha -p tsconfig.json test/http-configuration-schema.test.ts`
Expected: FAIL to compile or load: `Cannot find module '../src/schemas/http.configuration.js'`. (After Step 1 alone, every case passes; the order here is test first, schema second, so write the test, see this failure, then add the files of Step 1.)

- [ ] **Step 4: Implement**

Create the schema file, the bootstrapper, the index export and the shipped-config deletion exactly as in Step 1. Nothing else in `packages/http/src` changes in this task: `RealIp`, `CorsMiddleware` and `ThrottleMiddleware` keep `Configuration.get` (Phase 6). Consequences to check, not to code:
- A `config.set('http.cors', bad)` after boot is not validated (the parent plan's out-of-scope item), so the tests that put a bad value in with `set` and expect `InvalidOption` from the middleware (`test/cors.test.ts`, `test/real-ip.test.ts`, which inject a fake `Configuration` property) stay green. A suite that puts a bad `http.*` value into the Configuration's `onLoad` and boots the root now fails with `InvalidConfiguration`: move that case into `http-configuration-schema.test.ts`.
- The Throttle middleware's `filter` of malformed rules and the `rules.length === 0` warning stay until Phase 6; the schema now refuses a malformed rule at boot, so the filter only sees valid rules.

- [ ] **Step 5: Run the tests and confirm they pass**

1. `cd packages/http && npx ts-mocha -p tsconfig.json test/http-configuration-schema.test.ts` then `npm test`. Expected: all pass (`shipped-config.test.ts` reads `lib/mjs/config/http.js`, which the `pretest` compile rebuilds).
2. Rebuild: `cd packages/http && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
3. Dependants, one after another (they read `http` from `lib/`): `for p in authn-http authn-oidc authn-token authn-totp authz-fs authz-http authz-http-admin configuration-http http-lazy-file-uploader http-socket http-swagger intl-http orm-http queue-http-progress telemetry users-http; do (cd packages/$p && npm test) || break; done`. A dependant that boots a root Configuration with an `http.*` value the schema refuses (a `cookie.secret` that is empty, a `cors.origins` entry without a scheme) fails with `InvalidConfiguration` naming the path; correct the fixture value, never the schema.

- [ ] **Step 6: Commit**

```bash
git add packages/http/src/schemas/http.configuration.ts packages/http/src/bootstrap.ts packages/http/src/index.ts packages/http/src/config/http.ts packages/http/test/support/config-boot.ts packages/http/test/http-configuration-schema.test.ts
git commit -m "feat(http): validate http.trustProxy, cookie.secret, cors, throttle and socket with a registered schema"
```

---

### Task 3.2: authn-session reuses the authn env helpers

Row: authn-session `appEnvOf`, `assertSessionCookieSecret`.

**Files:**
- Modify: `packages/authn/package.json` (exports map and `typesVersions`, lines 7-25)
- Modify: `packages/authn-session/src/cookie.ts:1-6` (imports), `:52-78` (the secret constant, `isRelaxedEnv`, `flagOn`, `appEnvOf`), `:86-93` (`assertSessionCookieSecret`)
- Modify: `packages/authn/test/boot/secrets.test.ts:85-105` (the two source-scan tests)
- Create: `packages/authn-session/test/env-shared.test.ts`

**Interfaces:**
- Consumes: `AUTHN_PUBLIC_COOKIE_SECRET`, `authnAppEnv`, `isLenientAuthnEnv` of `packages/authn/src/service/boot/env.ts` (identical logic to the two copies in `cookie.ts`, verified line by line: same four sources, same fallback rule; `authnAppEnv` additionally returns `undefined` for a non-string env).
- Produces: the subpath `@spinajs/authn/env` (no registration side effect: `env.ts` imports only `@spinajs/di` and `@spinajs/configuration`); `appEnvOf`, `PUBLIC_DEFAULT_COOKIE_SECRET`, `assertSessionCookieSecret` and `sessionCookie*` keep their exported names and behaviour. `@Config` does not apply: these are functions that take the secret and the env as arguments. What stays in code, and why: `assertSessionCookieSecret` keeps both its checks, "secret not set" (the `http` schema types the secret but cannot require it, because a config without an `http` block, as the isolated test configs are, must still boot) and "the public default outside development and test" (depends on the app env, which a schema cannot read).

- [ ] **Step 1: Schema additions**

None. Package export added instead, in `packages/authn/package.json`:

```json
    "./env": {
      "types": "./lib/mjs/service/boot/env.d.ts",
      "import": "./lib/mjs/service/boot/env.js",
      "require": "./lib/cjs/service/boot/env.js"
    }
```
after the `"./contracts"` entry of `exports`, and in `typesVersions["*"]` after `"contracts"`:

```json
      "env": [
        "lib/cjs/service/boot/env.d.ts"
      ]
```

- [ ] **Step 2: Write the failing tests**

`packages/authn-session/test/env-shared.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import type { Configuration } from '@spinajs/configuration-common';
import { AUTHN_PUBLIC_COOKIE_SECRET, authnAppEnv, isLenientAuthnEnv } from '@spinajs/authn/env';

import { PUBLIC_DEFAULT_COOKIE_SECRET, appEnvOf, sessionCookieOptions } from '../src/index.js';

const configOf = (appEnv: unknown, own?: string): Configuration => ({ Env: own, get: (path: string) => (path === 'process.env.APP_ENV' ? appEnv : undefined) }) as unknown as Configuration;

describe('authn-session shares the authn env helpers', () => {
  it('has one public cookie secret', () => {
    expect(PUBLIC_DEFAULT_COOKIE_SECRET).to.equal(AUTHN_PUBLIC_COOKIE_SECRET);
  });

  it('reads the app env as authn does', () => {
    for (const [env, own] of [['production', 'production'], ['development', 'development'], ['development', undefined], ['staging', 'staging'], [undefined, undefined]] as const) {
      expect(appEnvOf(configOf(env, own)), `${String(env)}/${String(own)}`).to.equal(authnAppEnv(configOf(env, own)));
    }
  });

  it('relaxes the cookie flags in exactly the envs where authn relaxes its secret checks', () => {
    for (const env of ['development', 'dev', 'test', 'production', 'prod', 'staging', 'qa', 'Development', 'TEST', '', undefined]) {
      expect(sessionCookieOptions({}, undefined, env).secure, String(env)).to.equal(!isLenientAuthnEnv(env));
    }
  });
});
```

Edit `packages/authn/test/boot/secrets.test.ts`: in the test "mirrors the public cookie secret of @spinajs/http and @spinajs/authn-session" delete the `session` line and its last `expect` (authn-session now re-exports the constant, and `env-shared.test.ts` pins it); in the test "uses the same lenient envs and env detection as @spinajs/authn-session" delete the whole test (lines 91-104 of the original: it scanned `authn-session/src/cookie.ts` for a copy that no longer exists) and rename the describe-level wording of the remaining one to "mirrors the public cookie secret of @spinajs/http".

- [ ] **Step 3: RED**

Build authn first so the subpath exists in lib: no, it must NOT exist yet: run `cd packages/authn-session && npx ts-mocha -p tsconfig.json test/env-shared.test.ts`
Expected: FAIL with `Cannot find module '@spinajs/authn/env'` (or TS2307 for the same specifier).

- [ ] **Step 4: Implement**

After the `package.json` change of Step 1, `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

`packages/authn-session/src/cookie.ts`:

1. Imports (lines 1-6) become:

```ts
import { DateTime } from 'luxon';
import { AUTHN_PUBLIC_COOKIE_SECRET, authnAppEnv, isLenientAuthnEnv } from '@spinajs/authn/env';
import type { Configuration } from '@spinajs/configuration-common';
import { InvalidOption } from '@spinajs/exceptions';
import type { ISession } from './contracts.js';
```

2. Replace lines 52-66 (the constant, `isRelaxedEnv`, `flagOn`) with:

```ts
/** Shipped in `@spinajs/http`'s default config, so anyone can forge signatures made with it. */
export const PUBLIC_DEFAULT_COOKIE_SECRET = AUTHN_PUBLIC_COOKIE_SECRET;

function flagOn(flag: SessionCookieFlag | undefined, env: string | undefined): boolean {
  if (flag === undefined || flag === 'auto') {
    return !isLenientAuthnEnv(env);
  }
  return flag !== false && flag !== 'false';
}
```

3. Replace the body of `appEnvOf` (lines 72-78) so the function is:

```ts
export function appEnvOf(config: Configuration): string | undefined {
  return authnAppEnv(config);
}
```
keeping its doc comment (lines 68-71).

4. In `assertSessionCookieSecret` replace `!isRelaxedEnv(env)` with `!isLenientAuthnEnv(env)`; both throws stay.

`DI` is no longer imported in this file; `normalizeEnvironment` is no longer imported. `package.json` of authn-session already depends on `@spinajs/authn`, `@spinajs/configuration-common` and `@spinajs/exceptions`.

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-session && npx ts-mocha -p tsconfig.json test/env-shared.test.ts test/session-cookie.test.ts` then `npm test`. The existing `appEnvOf`, `assertSessionCookieSecret` and cookie tests are the behaviour pin: they must pass unchanged.
2. `cd packages/authn && npm test` (the edited `secrets.test.ts`).
3. Rebuild authn-session: `cd packages/authn-session && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `for p in authn-http authn-oidc session-provider-db session-provider-dynamodb session-provider-redis; do (cd packages/$p && npm test) || break; done`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/package.json packages/authn/test/boot/secrets.test.ts packages/authn-session/src/cookie.ts packages/authn-session/test/env-shared.test.ts
git commit -m "refactor(authn-session): take the app env and the lenient envs from @spinajs/authn/env"
```

---

### Task 3.3: authn-token reads `authn.token.*` and `authn.jwt.issuers` from `@Config` and the schema

Row: authn-token `checkTokenFormat`, `checkInterval`, `positive()`, `JwtBearerStrategy.issuerOf`.

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:215-256` (the `token` and `jwt` blocks)
- Modify: `packages/authn-token/src/generator.ts:1-47`
- Modify: `packages/authn-token/src/strategy/TokenStrategy.ts:8-22` (import, `checkInterval`), `:36-56` (config fields, `resolve`), `:127` (`stamp`)
- Modify: `packages/authn-token/src/service/token-service.ts:10` (import), `:135-170` (fields, constructor, `resolve`), `:208-209` (the two TTL caps), `:563-569` (delete `positive`)
- Modify: `packages/authn-token/src/jwt/JwtBearerStrategy.ts:42-58` (constants), `:60-62` (helpers), `:143-262` (`Issuers`, `resolve`, `issuerOf`, `remoteOf`, `publicKeysOf`)
- Modify: `packages/authn-token/src/cli/CreateToken.ts:48`, `packages/authn-token/src/migrations/AuthnTokenScope_2026_10_02_00_00_00.ts:14-22`
- Test: create `packages/authn-token/test/support/config-boot.ts` (helper H) and `packages/authn-token/test/v3/config-schema.test.ts`; edit `packages/authn-token/test/v3/token-strategy.test.ts`, `packages/authn-token/test/v3/jwt-strategy.test.ts`, the fixtures that boot the root Configuration (`test/db-common.ts`, `test/v3/db.ts`)

**Interfaces:**
- Consumes: `@Config` (Task 1 of the parent plan), `AUTHN_CONFIGURATION_SCHEMA` (lib of `@spinajs/authn`, rebuilt in Step 4).
- Produces: schema defaults `authn.token.{prefix 'spt_', length 32, defaultTtlDays 30, headerName 'x-api-key', lastUsedUpdateInterval 60}`, `authn.jwt.issuers` default `[]`, issuer defaults `clockSkewSeconds 30`, `subjectClaim 'sub'`; `checkTokenSize(prefix, length)` (replaces `checkTokenFormat`).
- Stays in code, and why: (a) `prefix.length + ceil(length * 4 / 3) <= 1024` (a string length plus a byte count; `$data` cannot add); (b) the derived provider `jwt:<issuer>` (its length bound and its uniqueness against other issuers' providers: the schema sees only explicit `provider` values); (c) every check that needs crypto or a URL parse: `createPublicKey` validity, the RSA key size, "a key's type and curve fit one of the issuer's algorithms", and the `https` (or loopback `http`) rule of `jwksUri`; (d) `TokenStrategy` and `DbTokenService` keep their DI-built constructors.
- `@Config` caveat: `DbTokenService` called `this.resolve()` from its constructor. A DI-built instance has no hidden container key during construction, so a `@Config` read there would use the ROOT Configuration. The size check moves to the first `create()` (the generator and `checkGenerated` already re-check per mint); `TokenStrategy.resolve()` (an `AsyncService` boot hook) keeps the boot-time check.

- [ ] **Step 1: Schema additions**

In `authn.configuration.ts`, add above `AUTHN_CONFIGURATION_SCHEMA`:

```ts
const JWT_ISSUER_MEMBERS = ['issuer', 'audience', 'jwksUri', 'keys', 'algorithms', 'clockSkewSeconds', 'subjectClaim', 'provider', 'linking'];
// A private or symmetric member: never part of a verification key.
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

const PUBLIC_JWK = {
  type: 'object',
  required: ['kty'],
  properties: {
    kty: { enum: ['RSA', 'EC', 'OKP'] },
    use: { const: 'sig' },
    // A key that may also sign or encrypt is shared with another use (RFC 7517 section 4.3).
    key_ops: { type: 'array', minItems: 1, maxItems: 1, items: { const: 'verify' } },
    ext: { type: 'boolean' },
    // From the key, up to the issuer: key -> keys -> issuer.
    alg: { enum: { $data: '3/algorithms' } },
  },
  not: { anyOf: PRIVATE_JWK_MEMBERS.map((member) => ({ required: [member] })) },
};
```

Replace the `token` block (lines 215-232):

```ts
    token: {
      type: 'object',
      default: {},
      properties: {
        prefix: { type: 'string', minLength: 1, default: 'spt_', description: 'Lets secret scanners recognise a leaked token.' },
        length: { type: 'integer', minimum: 32, default: 32, description: 'Random bytes; at least 256 bits (A14). With the prefix a token stays within 1024 characters (a boot check).' },
        generation: {
          type: 'object',
          properties: {
            service: { type: 'string', minLength: 1 },
          },
        },
        maxTtlDays: { type: 'integer', minimum: 1, default: 90 },
        defaultTtlDays: { type: 'integer', minimum: 1, default: 30 },
        agentMaxTtlMinutes: { type: 'integer', minimum: 1, default: 1440 },
        headerName: { type: 'string', minLength: 1, default: 'x-api-key' },
        lastUsedUpdateInterval: { type: 'number', minimum: 0, default: 60, description: 'Seconds.' },
      },
    },
```

Replace the `jwt` block (lines 233-256). `linking` used `additionalProperties: false`, which the app Ajv would strip silently; it is a `propertyNames` rule now, as is the new unknown-member rule of an issuer:

```ts
    jwt: {
      type: 'object',
      properties: {
        issuers: {
          type: 'array',
          default: [],
          // Each issuer once, each explicit provider once (a derived provider is checked in code).
          uniqueItemProperties: ['issuer', 'provider'],
          items: {
            type: 'object',
            propertyNames: { enum: JWT_ISSUER_MEMBERS },
            properties: {
              issuer: { type: 'string', minLength: 1 },
              audience: { type: 'string', minLength: 1 },
              jwksUri: { type: 'string', format: 'uri' },
              keys: { type: 'array', minItems: 1, items: PUBLIC_JWK },
              algorithms: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: JWT_ALGORITHMS } },
              clockSkewSeconds: { type: 'integer', minimum: 0, maximum: 60, default: 30 },
              subjectClaim: { type: 'string', minLength: 1, default: 'sub' },
              provider: { type: 'string', minLength: 1, maxLength: 128, description: "The IdentityLink provider; default 'jwt:<issuer>'." },
              linking: { type: 'object', propertyNames: { enum: ['jit'] }, properties: { jit: { type: 'boolean' } } },
            },
            required: ['issuer', 'audience', 'algorithms'],
            oneOf: [{ required: ['jwksUri'] }, { required: ['keys'] }],
          },
        },
      },
    },
```

If Ajv refuses `$data` inside `enum` when the app validator compiles the schema (Step 5 shows it as a compile error of the authn tests), delete the `alg` line and put `if (key.alg !== undefined && !algorithms.includes(key.alg)) throw new Error(...)` back into `publicKeysOf` (Step 4); the test named "names a key whose alg is not one of the issuer's algorithms" then asserts the thrown message instead of the violation path.

- [ ] **Step 2: Write the failing tests**

Copy helper H to `packages/authn-token/test/support/config-boot.ts`. Create `packages/authn-token/test/v3/config-schema.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';
import { Configuration } from '@spinajs/configuration';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

import authnToken from '../../src/config/authn-token.js';
import { SecureRandomTokenProvider } from '../../src/generator.js';
import { JwtBearerStrategy } from '../../src/jwt/JwtBearerStrategy.js';
import { TokenStrategy } from '../../src/strategy/TokenStrategy.js';
import type { TokenService } from '@spinajs/authn/contracts';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const bad = (authn: Record<string, unknown>) => violationsOf(SCHEMAS, { authn });

const ISSUER = { issuer: 'https://id.example.com', audience: 'api', algorithms: ['ES256'], jwksUri: 'https://id.example.com/jwks' };
const issuers = (...items: Record<string, unknown>[]) => ({ jwt: { issuers: items } });

describe('authn.token and authn.jwt through the schema', () => {
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('fills authn.token in whole', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.token')).to.deep.include({ prefix: 'spt_', length: 32, maxTtlDays: 90, defaultTtlDays: 30, agentMaxTtlMinutes: 1440, headerName: 'x-api-key', lastUsedUpdateInterval: 60 });
    });

    it('equals the shipped package config', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      const shipped = authnToken.authn.token;
      for (const key of ['prefix', 'length', 'maxTtlDays', 'defaultTtlDays', 'agentMaxTtlMinutes', 'headerName', 'lastUsedUpdateInterval'] as const) {
        expect(configuration.get(`authn.token.${key}`), key).to.eq(shipped[key]);
      }
    });

    it('has no issuer by default, and gives an issuer its skew and subject claim', async () => {
      expect((await boot(SCHEMAS, {})).configuration.get('authn.jwt.issuers')).to.deep.eq([]);
      const { configuration } = await boot(SCHEMAS, { authn: issuers(ISSUER) });
      expect(configuration.get('authn.jwt.issuers.0')).to.deep.include({ clockSkewSeconds: 30, subjectClaim: 'sub' });
    });
  });

  describe('authn.token violations', () => {
    it('names the bad key', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ prefix: '' }, 'authn.token.prefix'],
        [{ length: 31 }, 'authn.token.length'],
        [{ length: 32.5 }, 'authn.token.length'],
        [{ maxTtlDays: 0 }, 'authn.token.maxTtlDays'],
        [{ defaultTtlDays: 0 }, 'authn.token.defaultTtlDays'],
        [{ agentMaxTtlMinutes: 0 }, 'authn.token.agentMaxTtlMinutes'],
        [{ headerName: '' }, 'authn.token.headerName'],
        [{ lastUsedUpdateInterval: -1 }, 'authn.token.lastUsedUpdateInterval'],
        [{ lastUsedUpdateInterval: 'sixty' }, 'authn.token.lastUsedUpdateInterval'],
      ];
      for (const [token, path] of cases) expect(await bad({ token }), JSON.stringify(token)).to.include(path);
    });
  });

  describe('authn.jwt.issuers violations', () => {
    it('names the bad member', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ ...ISSUER, audience: undefined }, 'authn.jwt.issuers.0.audience'],
        [{ ...ISSUER, issuer: '' }, 'authn.jwt.issuers.0.issuer'],
        [{ ...ISSUER, algorithms: ['HS256'] }, 'authn.jwt.issuers.0.algorithms.0'],
        [{ ...ISSUER, algorithms: [] }, 'authn.jwt.issuers.0.algorithms'],
        [{ ...ISSUER, clockSkewSeconds: 61 }, 'authn.jwt.issuers.0.clockSkewSeconds'],
        [{ ...ISSUER, subjectClaim: '' }, 'authn.jwt.issuers.0.subjectClaim'],
        [{ ...ISSUER, provider: 'p'.repeat(129) }, 'authn.jwt.issuers.0.provider'],
        [{ ...ISSUER, jwksUri: 'not a uri' }, 'authn.jwt.issuers.0.jwksUri'],
        [{ ...ISSUER, typo: 1 }, 'authn.jwt.issuers.0.typo'],
        [{ ...ISSUER, linking: { jit: true, byVerifiedEmail: true } }, 'authn.jwt.issuers.0.linking.byVerifiedEmail'],
        [{ ...ISSUER, linking: { jit: 'sometimes' } }, 'authn.jwt.issuers.0.linking.jit'],
        [{ ...ISSUER, keys: [{ kty: 'OKP' }] }, 'authn.jwt.issuers.0'],
        [{ ...ISSUER, jwksUri: undefined }, 'authn.jwt.issuers.0'],
      ];
      for (const [issuer, path] of cases) expect(await bad(issuers(issuer)), path).to.include(path);
    });

    it('refuses a repeated issuer and a repeated explicit provider', async () => {
      expect(await bad(issuers(ISSUER, { ...ISSUER, audience: 'other' }))).to.include('authn.jwt.issuers');
      const other = { ...ISSUER, issuer: 'https://other.example.com' };
      expect(await bad(issuers({ ...ISSUER, provider: 'shared' }, { ...other, provider: 'shared' }))).to.include('authn.jwt.issuers');
    });

    it('names a key that is private, symmetric, of another use or of an unknown type', async () => {
      const local = { ...ISSUER, jwksUri: undefined, algorithms: ['ES256'] };
      const key = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
      const cases: [Record<string, unknown>, string][] = [
        [{ ...key, d: 'secret' }, 'authn.jwt.issuers.0.keys.0'],
        [{ kty: 'oct', k: 'secret' }, 'authn.jwt.issuers.0.keys.0.kty'],
        [{ ...key, use: 'enc' }, 'authn.jwt.issuers.0.keys.0.use'],
        [{ ...key, key_ops: ['sign', 'verify'] }, 'authn.jwt.issuers.0.keys.0.key_ops'],
        [{ ...key, ext: 'maybe' }, 'authn.jwt.issuers.0.keys.0.ext'],
        [{ ...key, alg: 'ES384' }, 'authn.jwt.issuers.0.keys.0.alg'],
      ];
      for (const [jwk, path] of cases) expect(await bad(issuers({ ...local, keys: [jwk] })), path).to.include(path);
      expect(await bad(issuers({ ...local, keys: [{ ...key, use: 'sig', key_ops: ['verify'], alg: 'ES256' }] }))).to.deep.eq([]);
    });
  });

  describe('what the code still checks', () => {
    it('refuses a prefix and length that make a token over 1024 characters', async () => {
      const { child } = await boot(SCHEMAS, { authn: { token: { prefix: 'p'.repeat(1000), length: 300 } } });
      await child.resolve(Configuration);
      const provider = readingFrom(new SecureRandomTokenProvider(), child);
      let error: unknown;
      try {
        await provider.generate();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('longer than 1024');
      const strategy = readingFrom(new TokenStrategy({} as TokenService), child);
      let boot1: unknown;
      try {
        await strategy.resolve();
      } catch (e) {
        boot1 = e;
      }
      expect(String(boot1)).to.contain('longer than 1024');
    });

    it('reads the configured token format through @Config', async () => {
      const { child } = await boot(SCHEMAS, { authn: { token: { prefix: 'acme_', length: 48 } } });
      const token = await readingFrom(new SecureRandomTokenProvider(), child).generate();
      expect(token.Plaintext.startsWith('acme_')).to.eq(true);
      expect(token.Plaintext.length).to.eq('acme_'.length + Math.ceil((48 * 4) / 3));
    });

    it('refuses an issuer whose derived provider is another issuer\'s provider', async () => {
      const { child } = await boot(SCHEMAS, { authn: issuers({ ...ISSUER, provider: 'jwt:https://other.example.com' }, { ...ISSUER, issuer: 'https://other.example.com' }) });
      let error: unknown;
      try {
        await readingFrom(new JwtBearerStrategy(), child).resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.match(/provider jwt:https:\/\/other\.example\.com is used by another issuer/);
    });

    it('refuses an RSA key under 2048 bits and a key that fits none of the algorithms', async () => {
      const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
      const okp = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
      const local = { issuer: 'https://id.example.com', audience: 'api' };
      const fail = async (item: Record<string, unknown>): Promise<string> => {
        const { child } = await boot(SCHEMAS, { authn: issuers({ ...local, ...item }) });
        try {
          await readingFrom(new JwtBearerStrategy(), child).resolve();
          return '';
        } catch (e) {
          return String(e);
        }
      };
      expect(await fail({ algorithms: ['RS256'], keys: [small] })).to.contain('under 2048 bits');
      expect(await fail({ algorithms: ['ES256'], keys: [okp] })).to.contain('fits none of the issuer');
      expect(await fail({ algorithms: ['EdDSA'], keys: [okp] })).to.eq('');
    });

    it('refuses a jwksUri that is neither https nor a loopback http', async () => {
      const { child } = await boot(SCHEMAS, { authn: issuers({ ...ISSUER, jwksUri: 'http://id.example.com/jwks' }) });
      let error: unknown;
      try {
        await readingFrom(new JwtBearerStrategy(), child).resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('jwksUri must use https');
    });
  });
});
```

Delete from the existing suites the cases that assert a thrown message the schema now covers (grep `must be`, `unknown members`, `exactly one of`, `refuses to start` in `test/v3/token-strategy.test.ts`, `test/v3/jwt-strategy.test.ts`, `test/v3/token-service.test.ts`): the `prefix` and `length` weak-format loop and the `lastUsedUpdateInterval` refusal test of `token-strategy.test.ts` (lines ~119-153), and every `jwt-strategy.test.ts` case that sets a malformed issuer item (`algorithms`, `clockSkewSeconds`, `subjectClaim`, `provider` type, unknown member, both or neither key source, private or symmetric key, `use`, `key_ops`, `ext`, `alg`). Keep the cases about the derived provider, key size, key fit and `jwksUri` scheme; they now boot through `readingFrom(new JwtBearerStrategy(), child)`.

- [ ] **Step 3: RED**

Run: `cd packages/authn-token && npx ts-mocha -p tsconfig.json test/v3/config-schema.test.ts`
Expected: FAIL. The authn lib has no `token` defaults, so the "defaults" cases read `undefined`; the violation cases for `prefix`, `length` below the minimum pass today (only the new members, `provider` length, `linking.byVerifiedEmail`, `typo`, `keys.0.*` and the `defaultTtlDays` default fail), and the generator, strategy and JWT cases fail because the classes still read `Configuration` through `{ defaultValue }` and `checkTokenFormat` is the name that exists.

- [ ] **Step 4: Implement**

1. `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` after the Step 1 edit.

2. `generator.ts` (replace the whole file body after the imports):

```ts
import { randomBytes, createHash } from 'crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { AccessTokenGenerationProvider, IGeneratedToken } from './generation.js';

/** TokenStrategy treats a longer value as not a token, so nothing longer may be minted. */
export const MAX_TOKEN_LENGTH = 1024;

/** The schema bounds prefix and length one by one; their sum is a string length plus a byte count, which only code can add. */
export function checkTokenSize(prefix: string, length: number): void {
  if (prefix.length + Math.ceil((length * 4) / 3) > MAX_TOKEN_LENGTH) {
    throw new Error(`authn.token.prefix and authn.token.length make tokens longer than ${MAX_TOKEN_LENGTH} characters`);
  }
}

/**
 * Default token algorithm: `<prefix>` + N crypto-random bytes base64url encoded.
 * The stable prefix makes leaked tokens findable by secret scanners.
 */
@Injectable(AccessTokenGenerationProvider)
export class SecureRandomTokenProvider extends AccessTokenGenerationProvider {
  @Config('authn.token.prefix')
  protected Prefix: string;

  @Config('authn.token.length')
  protected Length: number;

  public async generate(): Promise<IGeneratedToken> {
    checkTokenSize(this.Prefix, this.Length);
    const plaintext = `${this.Prefix}${randomBytes(this.Length).toString('base64url')}`;
    return { Plaintext: plaintext, Hash: this.hash(plaintext) };
  }

  public hash(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }
}
```

3. `TokenStrategy.ts`: import `{ MAX_TOKEN_LENGTH, checkTokenSize } from '../generator.js'`; delete `checkInterval` (lines 17-22); the fields and `resolve` become:

```ts
  @Config('authn.token.prefix')
  protected Prefix: string;

  @Config('authn.token.length')
  protected Length: number;

  @Config('authn.token.lastUsedUpdateInterval')
  protected LastUsedUpdateInterval: number;

  @Logger('authn-token')
  protected Log: Log;

  constructor(protected readonly tokens: TokenService) {
    super();
  }

  /** Fails boot on a token format over the size cap. TokenService is injected, so a missing IdentityStore already failed. */
  public async resolve(): Promise<void> {
    checkTokenSize(this.Prefix, this.Length);
  }
```

and in `stamp` replace `const interval = checkInterval(this.LastUsedUpdateInterval);` with `const interval = this.LastUsedUpdateInterval;`.

4. `token-service.ts`: import `{ MAX_TOKEN_LENGTH, checkTokenSize } from '../generator.js'`; the four fields lose their `{ defaultValue }`; the constructor loses the trailing `this.resolve();` and its comment; `resolve()` and the first statement of `create()`:

```ts
  @Config('authn.token.maxTtlDays')
  protected MaxTtlDays: number;

  @Config('authn.token.agentMaxTtlMinutes')
  protected AgentMaxTtlMinutes: number;

  @Config('authn.token.prefix')
  protected Prefix: string;

  @Config('authn.token.length')
  protected Length: number;

  /** The format size cap; checked at the first create, because a constructor cannot read the container's Configuration. */
  public resolve(): void {
    checkTokenSize(this.Prefix, this.Length);
  }

  public async create(owner: IdentityRef, opts: TokenCreateOptions, ctx: AuthnContext): Promise<TokenCreateResult> {
    this.resolve();
    const now = this.nowOf(ctx);
```

and lines 208-209 become:

```ts
    const patCap = now + this.MaxTtlDays * DAY_MS;
    const cap = agent ? Math.min(patCap, now + this.AgentMaxTtlMinutes * MINUTE_MS) : patCap;
```

Delete `positive` (lines 563-568).

5. `CreateToken.ts:48`: `@Config('authn.token.defaultTtlDays')`. `AuthnTokenScope_...ts`: `@Config('authn.token.maxTtlDays')` and in `up()` replace the `typeof` guard block by `const maxTtlDays = this.MaxTtlDays;`.

6. `JwtBearerStrategy.ts`: delete the constants `ALGORITHMS`, `MEMBERS`, `PRIVATE_JWK_MEMBERS`, `KEY_TYPES` and the helper `isNonEmptyString`; keep `MAX_PROVIDER`, `isPlainObject` (the JWKS body check), `codeOf`. Replace `Issuers`, `resolve`, `issuerOf`, `remoteOf` and `publicKeysOf`:

```ts
/** An issuer item after the schema: its defaults are filled in. */
type ConfiguredIssuer = JwtIssuerConfig & Required<Pick<JwtIssuerConfig, 'clockSkewSeconds' | 'subjectClaim'>>;

  @Config('authn.jwt.issuers')
  protected Issuers: ConfiguredIssuer[];

  @Logger('authn-token')
  protected Log: Log;

  protected issuers = new Map<string, Issuer>();

  /** Fails boot on an issuer the schema cannot judge; builds one key resolver per issuer and keeps it, so its JWKS cache lives. */
  public async resolve(): Promise<void> {
    const issuers = new Map<string, Issuer>();
    const providers = new Set<string>();
    this.Issuers.forEach((item, i) => {
      const at = `authn.jwt.issuers[${i}]`;
      const issuer = this.issuerOf(item, at);
      // A shared provider would let one issuer claim the subjects, and so the links, of another; the schema sees only explicit providers.
      if (providers.has(issuer.provider)) {
        throw new Error(`${at}: provider ${issuer.provider} is used by another issuer`);
      }
      issuers.set(issuer.issuer, issuer);
      providers.add(issuer.provider);
    });
    this.issuers = issuers;
  }

  protected issuerOf(o: ConfiguredIssuer, at: string): Issuer {
    const provider = o.provider ?? `jwt:${o.issuer}`;
    // The schema bounds an explicit provider; a derived one is the issuer plus a prefix.
    if (provider.length > MAX_PROVIDER) {
      throw new Error(`${at}.provider must be at most ${MAX_PROVIDER} characters`);
    }
    const algorithms = [...o.algorithms];
    const keys = o.jwksUri !== undefined ? this.remoteOf(o.jwksUri, o.issuer, at) : createLocalJWKSet({ keys: this.publicKeysOf(o.keys ?? [], algorithms, at) });
    return { issuer: o.issuer, audience: o.audience, algorithms, clockSkewSeconds: o.clockSkewSeconds, subjectClaim: o.subjectClaim, provider, jit: o.linking?.jit === true, keys };
  }

  protected remoteOf(jwksUri: string, issuer: string, at: string): JWTVerifyGetKey {
    let url: URL;
    try {
      url = new URL(jwksUri);
    } catch {
      throw new Error(`${at}.jwksUri must be a URL`);
    }
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) {
      throw new Error(`${at}.jwksUri must use https (http only for a loopback host)`);
    }
    return remoteKeys(url, (err) => this.Log.warn(`Could not fetch the JWKS of JWT issuer ${issuer}: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Refuses a key jose would never select or verify with, so a config error does not look like an attack. The schema has judged the member shapes. */
  protected publicKeysOf(keys: JWK[], algorithms: readonly string[], at: string): JWK[] {
    return keys.map((key, j) => {
      const atKey = `${at}.keys[${j}]`;
      let modulusLength: number | undefined;
      try {
        modulusLength = createPublicKey({ key: key as NodeJwk, format: 'jwk' }).asymmetricKeyDetails?.modulusLength;
      } catch {
        throw new Error(`${atKey} is not a valid public JWK`);
      }
      if (key.kty === 'RSA' && !((modulusLength ?? 0) >= MIN_RSA_BITS)) {
        throw new Error(`${atKey} is an RSA key under ${MIN_RSA_BITS} bits`);
      }
      const candidates = key.alg !== undefined ? [key.alg] : algorithms;
      if (!candidates.some((alg) => algorithmFits(alg, key.kty, key.crv))) {
        throw new Error(`${atKey} fits none of the issuer's algorithms`);
      }
      return { ...key };
    });
  }
```

(`MIN_RSA_BITS`, `algorithmFits`, `isLoopback`, `remoteKeys`, `createPublicKey`, `NodeJwk` are already in the file.) `JwtIssuerConfig` is unchanged.

7. Test fixtures. Every fixture that resolves the ROOT Configuration (`grep -rn "resolve(Configuration)" packages/authn-token/test`) registers the schema first, because the code defaults are gone: in `test/db-common.ts` and `test/v3/db.ts` add `import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';` and, before the Configuration is resolved, `DI.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');`. The tests in `token-strategy.test.ts` that set `authn.token.*` through `config().set(...)` keep working (`@Config` reads at call time).

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-token && npx ts-mocha -p tsconfig.json test/v3/config-schema.test.ts`, then `npm test`.
2. `cd packages/authn && npm test` (the schema change: if `test/contracts/config-schema.test.ts` pins that `authn.token` has no default or that `linking` accepts an extra key, update those assertions to the new schema; add nothing else there).
3. Rebuild authn-token: `cd packages/authn-token && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `cd packages/authn-http && npm test`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn-token/src packages/authn-token/test
git commit -m "refactor(authn-token): authn.token and authn.jwt.issuers through @Config and the schema, no hand validation"
```

---

### Task 3.4: authn-totp reads `authn.mfa.totp`, `authn.mfa.encryptionKey` and `authn.freshAuth.maxAgeSeconds` from `@Config` and the schema; the `freshAuth` copy goes

Row: authn-totp `TotpMfaStep`, `TotpService`.

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:168-193` (`mfa.encryptionKey`, `mfa.totp`) and `:209-214` (`freshAuth`, only if Phase 2 has not given it a default)
- Create: `packages/authn/src/contracts/fresh.ts`; modify `packages/authn/src/contracts/index.ts` (add `export * from './fresh.js';`) and `packages/authn/src/freshauth/fresh-auth-check.ts:10-25` (delete `isFresh`, import it)
- Modify: `packages/authn-totp/src/step/options.ts` (whole file), `packages/authn-totp/src/step/totp-step.ts:1-60` and `:196-213`, `packages/authn-totp/src/cipher/key-ring.ts:38-60`, `packages/authn-totp/src/service/totp-service.ts:1-12`, `:49-63`, `:281-286`
- Delete: `packages/authn-totp/src/service/fresh-auth.ts`
- Test: create `packages/authn-totp/test/support/config-boot.ts` (helper H), `packages/authn-totp/test/v3/config-schema.test.ts`, `packages/authn-totp/test/v3/support/totp-defaults.ts`; edit `test/v3/totp-step.test.ts`, `test/v3/cipher.test.ts`, `test/v3/cli.test.ts`, `test/v3/harness.ts`, `test/v3/recovery.test.ts`, `test/v3/service.test.ts`, `test/v3/sqlite-step.test.ts`; `packages/authn/test/contracts/config-schema.test.ts:247,352`

**Interfaces:**
- Consumes: the `authn.mfa.*` and `authn.freshAuth` schema blocks; `isFresh` from `@spinajs/authn/contracts` (moved there so authn-totp stops carrying a copy: the copy existed because the `@spinajs/authn` root registers `DefaultAuthnService` as a side effect, and `contracts` does not).
- Produces: validated, defaulted `authn.mfa.totp` (`issuer 'SpinaJS'`, `algorithm 'SHA1'` of `SHA1|SHA256|SHA512`, `digits 6` in 6-10, `period 30` in 1-300, `window 1` in 0-10, `recoveryCodes 10` in 0-100) and `authn.mfa.encryptionKey` (`secret`: 32 bytes as 64 hex characters, base64 or base64url, or `null`; `previous`: a list of such keys); `TotpOptions` stays as the shape type; `totpOptions`, `DEFAULT_TOTP_OPTIONS`, `MAX_WINDOW`, `MAX_PERIOD`, `MAX_RECOVERY_CODES`, `TotpOptionsInput`, `freshAuthMaxAge` and the local `isFresh` are removed.
- Stays in code, and why: `mfaKeyRingFrom` still throws when `encryptionKey.secret` is null or absent, because that is only an error when a TOTP step is used (a schema cannot know that); `mfaKeyFrom` still rejects a key whose last base64 character has non-zero unused bits (several texts name one key), which a pattern cannot judge. The shipped package config keeps `authn.mfa.totp` (defaults equal the schema's; Step 2 pins that), and still ships no `encryptionKey`.
- The schema's `algorithm` was looser than the code (any name, "Any name otpauth accepts"); it is now the enum the code always enforced. Existing schema tests that accept `'sha-256'` change.

- [ ] **Step 1: Schema additions**

`authn.configuration.ts`: add above the schema constant:

```ts
// 32 bytes as 64 hex characters, base64 (44 characters, or 43 unpadded) or base64url (43). The cipher also refuses a
// base64 text with non-zero unused bits in its last character, which a pattern cannot express.
const MFA_KEY_PATTERN = '^([0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=?|[A-Za-z0-9_-]{43})$';
```

Replace `encryptionKey` and `totp` inside `mfa` (lines 175-191):

```ts
        encryptionKey: secretRef('AES-256-GCM key for stored MFA secrets; required when any step stores secrets.', {
          secret: { type: ['string', 'null'], pattern: MFA_KEY_PATTERN, description: '32 bytes as 64 hex characters, base64 or base64url.' },
          previous: { type: 'array', items: { type: 'string', pattern: MFA_KEY_PATTERN }, description: 'Earlier keys, so rows written under them still decrypt after a rotation.' },
        }),
        totp: {
          type: 'object',
          default: {},
          properties: {
            issuer: { type: 'string', minLength: 1, default: 'SpinaJS', description: 'Shown by authenticator apps; set your app name.' },
            algorithm: { type: 'string', enum: ['SHA1', 'SHA256', 'SHA512'], default: 'SHA1', description: 'SHA1 is what authenticator apps support.' },
            digits: { type: 'integer', minimum: 6, maximum: 10, default: 6 },
            period: { type: 'integer', minimum: 1, maximum: 300, default: 30, description: 'Seconds. A longer period lets one stolen code cover too much time (SR-15).' },
            window: { type: 'integer', minimum: 0, maximum: 10, default: 1, description: 'Time steps accepted on each side of the current one.' },
            recoveryCodes: { type: 'integer', minimum: 0, maximum: 100, default: 10, description: 'Issued at confirmation; every confirmation and regeneration hashes the whole set.' },
          },
        },
```

`freshAuth` (lines 209-214), skip when it already has `default: {}` and `maxAgeSeconds ... default: 300` (Phase 2):

```ts
    freshAuth: {
      type: 'object',
      default: {},
      properties: {
        maxAgeSeconds: { type: 'integer', minimum: 1, default: 300 },
      },
    },
```

Create `packages/authn/src/contracts/fresh.ts` (moved from `fresh-auth-check.ts`, same code):

```ts
import { InvalidArgument } from '@spinajs/exceptions';

import type { AuthnFacts } from './principal.js';

/**
 * True when `authenticatedAt` lies within `maxAgeSeconds` before `now`, the boundary included. A time after `now` or
 * an invalid one is not fresh, nor is an impersonation: the impersonator must not act on the target's credentials (M6).
 */
export function isFresh(facts: Pick<AuthnFacts, 'authenticatedAt' | 'impersonator'>, now: Date, maxAgeSeconds: number): boolean {
  if (typeof maxAgeSeconds !== 'number' || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new InvalidArgument('isFresh: maxAgeSeconds must be a positive number');
  }
  if (facts?.impersonator !== undefined) return false;
  const at = facts?.authenticatedAt;
  if (!(at instanceof Date) || !(now instanceof Date)) return false;
  const age = now.getTime() - at.getTime();
  return age >= 0 && age <= maxAgeSeconds * 1000;
}
```

`contracts/index.ts`: add `export * from './fresh.js';`. `fresh-auth-check.ts`: delete lines 10-25 (the `isFresh` function and its doc comment), add `import { isFresh } from '../contracts/fresh.js';`, and drop the now unused `AuthnFacts` import if nothing else uses it. The root `index.ts` already re-exports `./contracts/index.js`, so `isFresh` stays exported from `@spinajs/authn`; `freshauth/index.ts` must not re-export it again.

- [ ] **Step 2: Write the failing tests**

Copy helper H to `packages/authn-totp/test/support/config-boot.ts`. `packages/authn-totp/test/v3/support/totp-defaults.ts` (the complete options the tests used to get from `totpOptions()`):

```ts
import type { TotpOptions } from '../../../src/step/index.js';

export const TOTP_DEFAULTS: TotpOptions = Object.freeze({ issuer: 'SpinaJS', algorithm: 'SHA1', digits: 6, period: 30, window: 1, recoveryCodes: 10 });

export const totpOpts = (over: Partial<TotpOptions> = {}): TotpOptions => Object.freeze({ ...TOTP_DEFAULTS, ...over });
```

`packages/authn-totp/test/v3/config-schema.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { InvalidOption } from '@spinajs/exceptions';

import authnTotp from '../../src/config/authn-totp.js';
import { MemoryMfaSecretStore } from '../../src/store/index.js';
import { TotpMfaStep } from '../../src/step/index.js';
import { TotpService } from '../../src/service/index.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';
import { TOTP_DEFAULTS } from './support/totp-defaults.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const bad = (authn: Record<string, unknown>) => violationsOf(SCHEMAS, { authn });
const KEY = randomBytes(32).toString('hex');
const OLD = randomBytes(32).toString('base64url');

describe('authn.mfa.totp, authn.mfa.encryptionKey and authn.freshAuth through the schema', () => {
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('fills authn.mfa.totp and authn.freshAuth', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.mfa.totp')).to.deep.eq({ ...TOTP_DEFAULTS });
      expect(configuration.get('authn.freshAuth.maxAgeSeconds')).to.eq(300);
    });

    it('equals the shipped package config', () => {
      expect(authnTotp.authn.mfa.totp).to.deep.eq({ ...TOTP_DEFAULTS });
    });

    it('keeps a configured value and fills the rest', async () => {
      const { configuration } = await boot(SCHEMAS, { authn: { mfa: { totp: { issuer: 'Acme', digits: 8 } } } });
      expect(configuration.get('authn.mfa.totp')).to.deep.eq({ ...TOTP_DEFAULTS, issuer: 'Acme', digits: 8 });
    });
  });

  describe('violations', () => {
    it('names the bad totp key', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ issuer: '' }, 'authn.mfa.totp.issuer'],
        [{ algorithm: 'sha-256' }, 'authn.mfa.totp.algorithm'],
        [{ algorithm: 'MD5' }, 'authn.mfa.totp.algorithm'],
        [{ digits: 5 }, 'authn.mfa.totp.digits'],
        [{ digits: 11 }, 'authn.mfa.totp.digits'],
        [{ period: 0 }, 'authn.mfa.totp.period'],
        [{ period: 301 }, 'authn.mfa.totp.period'],
        [{ window: -1 }, 'authn.mfa.totp.window'],
        [{ window: 11 }, 'authn.mfa.totp.window'],
        [{ recoveryCodes: -1 }, 'authn.mfa.totp.recoveryCodes'],
        [{ recoveryCodes: 101 }, 'authn.mfa.totp.recoveryCodes'],
        [{ period: 30.5 }, 'authn.mfa.totp.period'],
      ];
      for (const [totp, path] of cases) expect(await bad({ mfa: { totp } }), JSON.stringify(totp)).to.include(path);
    });

    it('accepts the limits and the three algorithms', async () => {
      for (const totp of [{ digits: 6, period: 1, window: 0, recoveryCodes: 0 }, { digits: 10, period: 300, window: 10, recoveryCodes: 100 }, { algorithm: 'SHA256' }, { algorithm: 'SHA512' }]) {
        expect(await bad({ mfa: { totp } }), JSON.stringify(totp)).to.deep.eq([]);
      }
    });

    it('names the bad encryption key, current or previous', async () => {
      expect(await bad({ mfa: { encryptionKey: { secret: 'short' } } })).to.include('authn.mfa.encryptionKey.secret');
      expect(await bad({ mfa: { encryptionKey: { secret: 'g'.repeat(64) } } })).to.include('authn.mfa.encryptionKey.secret');
      expect(await bad({ mfa: { encryptionKey: { secret: KEY, previous: [OLD, 'short'] } } })).to.include('authn.mfa.encryptionKey.previous.1');
      expect(await bad({ mfa: { encryptionKey: { secret: KEY, previous: OLD } } })).to.include('authn.mfa.encryptionKey.previous');
    });

    it('accepts a key as hex, base64 or base64url, and null', async () => {
      const bytes = randomBytes(32);
      for (const secret of [KEY, bytes.toString('base64'), bytes.toString('base64url'), null]) {
        expect(await bad({ mfa: { encryptionKey: { secret, previous: [OLD] } } }), String(secret)).to.deep.eq([]);
      }
    });

    it('names a freshAuth lifetime that is not a positive integer', async () => {
      for (const maxAgeSeconds of [0, -5, 1.5]) expect(await bad({ freshAuth: { maxAgeSeconds } }), String(maxAgeSeconds)).to.include('authn.freshAuth.maxAgeSeconds');
    });
  });

  describe('through @Config', () => {
    it('TotpMfaStep builds its options and key ring from the booted configuration', async () => {
      const { child } = await boot(SCHEMAS, { authn: { mfa: { totp: { issuer: 'Acme', digits: 8 }, encryptionKey: { secret: KEY } } } });
      const step = readingFrom(new TotpMfaStep({ store: new MemoryMfaSecretStore(), identities: null }), child);
      const { provisioning } = await step.beginEnrolment({ type: 'user', id: 'u1' });
      expect(new URL(provisioning).searchParams.get('issuer')).to.eq('Acme');
      expect(new URL(provisioning).searchParams.get('digits')).to.eq('8');
    });

    it('TotpMfaStep refuses to work when no encryption key is set', async () => {
      const { child } = await boot(SCHEMAS, {});
      const step = readingFrom(new TotpMfaStep({ store: new MemoryMfaSecretStore(), identities: null }), child);
      let error: unknown;
      try {
        await step.beginEnrolment({ type: 'user', id: 'u1' });
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(InvalidOption);
      expect(String(error)).to.contain('authn.mfa.encryptionKey.secret');
    });

    it('TotpService reads the fresh-auth lifetime and lets deps override it', async () => {
      const { child } = await boot(SCHEMAS, { authn: { freshAuth: { maxAgeSeconds: 120 } } });
      const service = readingFrom(new TotpService(), child) as unknown as { need(key: string): Promise<unknown> };
      expect(await service.need('maxAgeSeconds')).to.eq(120);
      const seam = readingFrom(new TotpService({ maxAgeSeconds: 5 }), child) as unknown as { need(key: string): Promise<unknown> };
      expect(await seam.need('maxAgeSeconds')).to.eq(5);
    });
  });
});
```

Edits to the existing tests, which build complete options with the deleted `totpOptions()`:
- `test/v3/cipher.test.ts` lines ~117-126: the cases that feed `mfaKeyRingFrom` a malformed `previous` (not a list, a short key) move to the schema test above; keep the case for `secret` null or empty (`/authn.mfa.encryptionKey.secret is not set/`), the non-canonical base64 case, and the `previous[i]` message of a key that passes the pattern but fails the cipher.
- In `cli.test.ts`, `harness.ts`, `recovery.test.ts`, `service.test.ts`, `sqlite-step.test.ts`, `totp-step.test.ts`: replace `import { TotpMfaStep, totpOptions } from '../../src/step/index.js'` by `import { TotpMfaStep } from '../../src/step/index.js'; import { totpOpts } from './support/totp-defaults.js';` and every `totpOptions(` by `totpOpts(`; in `harness.ts` line 17 replace `Object.keys(DEFAULT_TOTP_OPTIONS)` by `Object.keys(TOTP_DEFAULTS)`, drop `TotpOptionsInput` for `Partial<TotpOptions>`.
- `totp-step.test.ts`: delete the `v3 step: totpOptions` describe (lines 123-141) and the test at ~353 that expects a constructor throw for out-of-range explicit options; in `v3 step: TotpMfaStep through DI` (lines ~530-575) keep the `StubConfiguration` but register the schema first (`DI.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__')` before `DI.resolve(Configuration)`), because the options the step reads no longer pass through a defaulting function.
- `cli.test.ts` lines ~126-131 ("the package config lists no MFA step and keeps its defaults"): replace the last `assert.deepStrictEqual({ ...totpOptions(...) }, ...)` by `assert.deepStrictEqual(mfa.totp, { ...TOTP_DEFAULTS })`.
- `packages/authn/test/contracts/config-schema.test.ts`: line 247 becomes `check({ mfa: { totp: { algorithm: 'SHA256' } } })` (and add `refused({ mfa: { totp: { algorithm: 'sha-256' } } }, '/mfa/totp/algorithm')` next to line 352).

- [ ] **Step 3: RED**

Run: `cd packages/authn-totp && npx ts-mocha -p tsconfig.json test/v3/config-schema.test.ts`
Expected: FAIL: the old authn lib has none of the `totp` defaults or ranges (violation cases return `[]`, default cases read `undefined`), `TotpMfaStep` and `TotpService` do not read the child's Configuration (they use `DI.get(Configuration)`), and `./support/totp-defaults.js` imports `TotpOptions` from the old `options.ts`, which still exports it (so the file loads and the failures are assertion failures, not import errors).

- [ ] **Step 4: Implement**

1. Step 1 edits, then `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

2. `packages/authn-totp/src/step/options.ts` (whole file):

```ts
export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** `authn.mfa.totp`, as the schema validates and defaults it. */
export interface TotpOptions {
  readonly issuer: string;
  readonly algorithm: TotpAlgorithm;
  readonly digits: number;
  readonly period: number;
  /** Time steps accepted on each side of the current one. */
  readonly window: number;
  /** Recovery codes issued at confirmation. */
  readonly recoveryCodes: number;
}
```

3. `totp-step.ts`: imports (lines 1-16) become

```ts
import * as OTPAuth from 'otpauth';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation, UnexpectedServerError } from '@spinajs/exceptions';
import { IdentityStore, MfaStep } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { mfaKeyRingFrom } from '../cipher/key-ring.js';
import type { MfaEncryptionKeyOptions, MfaKeyRing } from '../cipher/key-ring.js';
import { MfaSecretStore } from '../store/store.js';
import type { MfaRecord } from '../store/store.js';
import { identityKey } from '../store/identity.js';
import { registered } from '../support/registered.js';
import { TotpAlreadyEnrolled, TotpEnrolmentChanged, TotpInvalidCode, TotpNotBegun, TotpNotEnrolled, TotpRecoveryCodesNotIssued } from './errors.js';
import { newRecoveryCodeSet, normaliseRecoveryCode, showRecoveryCode } from './recovery-codes.js';
import type { TotpOptions } from './options.js';
```

and the class head and `resolve()`:

```ts
  private resolved: Resolved | null = null;

  @Config('authn.mfa.totp')
  protected TotpConfig: TotpOptions;

  @Config('authn.mfa.encryptionKey')
  protected EncryptionKey: MfaEncryptionKeyOptions | undefined;

  constructor(private readonly deps: TotpMfaStepDeps = {}) {
    super();
  }
```

```ts
  private async resolve(): Promise<Resolved> {
    if (this.resolved) {
      return this.resolved;
    }
    const store = this.deps.store ?? (registered(MfaSecretStore) ? await DI.resolve(MfaSecretStore) : null);
    if (!store) {
      throw new InvalidOperation('TotpMfaStep: no MfaSecretStore is registered; import "@spinajs/authn-totp/db" (DbMfaSecretStore) or register another MfaSecretStore');
    }
    const keys = this.deps.keys ?? mfaKeyRingFrom(this.EncryptionKey);
    const options = this.deps.options ?? this.TotpConfig;
    const identities = this.deps.identities !== undefined ? this.deps.identities : registered(IdentityStore) ? await DI.resolve(IdentityStore) : null;
    this.resolved = { store, keys, options, identities };
    return this.resolved;
  }
```

(`private readonly options` and the constructor's `totpOptions` call are gone.)

4. `key-ring.ts` `mfaKeyRingFrom`:

```ts
export function mfaKeyRingFrom(options: MfaEncryptionKeyOptions | undefined): MfaKeyRing {
  // Only an error when a TOTP step runs, which the schema cannot know.
  if (typeof options?.secret !== 'string' || options.secret.length === 0) {
    throw new InvalidOption('authn.mfa.encryptionKey.secret is not set');
  }
  return new MfaKeyRing(
    mfaKeyFrom(options.secret),
    (options.previous ?? []).map((p, i) => {
      try {
        return mfaKeyFrom(p);
      } catch {
        // authn-orm's message names `secret` whichever key failed.
        throw new InvalidOption(`authn.mfa.encryptionKey.previous[${i}] must be 32 bytes given as 64 hex characters, base64 or base64url`);
      }
    }),
  );
}
```

5. `totp-service.ts`: imports: replace `import { Configuration } from '@spinajs/configuration';` by `import { Config } from '@spinajs/configuration';`; delete `import { freshAuthMaxAge, isFresh } from './fresh-auth.js';`; add `isFresh` to the value import from `@spinajs/authn/contracts` (`import { AuthnEventSink, AuthnService, AuthnThrottle, MfaStep, SessionIssuer, isFresh } from '@spinajs/authn/contracts';`). The class head and constructor:

```ts
  private readonly cache: { -readonly [K in keyof Resolved]?: Resolved[K] } = {};

  @Config('authn.freshAuth.maxAgeSeconds')
  protected MaxAgeSeconds: number;

  constructor(private readonly deps: TotpServiceDeps = {}) {}
```

and in `lookup`:

```ts
      case 'maxAgeSeconds':
        return d.maxAgeSeconds ?? this.MaxAgeSeconds;
```

(`need` is the existing private cache accessor; its visibility is widened in the test by a cast.) Delete `packages/authn-totp/src/service/fresh-auth.ts`.

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-totp && npx ts-mocha -p tsconfig.json test/v3/config-schema.test.ts`, then `npm test` (it runs the v3 and the legacy-v2 configs).
2. `cd packages/authn && npm test` (the schema, `isFresh` move and the edited `config-schema.test.ts`; `test/freshauth/fresh-auth.test.ts` imports `isFresh` from the root and must still pass unchanged).
3. Rebuild authn-totp: `cd packages/authn-totp && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `for p in authn-http users-http; do (cd packages/$p && npm test) || break; done`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/src/contracts packages/authn/src/freshauth packages/authn/test packages/authn-totp/src packages/authn-totp/test
git commit -m "refactor(authn-totp): authn.mfa.totp, encryptionKey and freshAuth through @Config and the schema; isFresh moves to authn contracts"
```

---

### Task 3.5: authn-orm `DbAuthnThrottle` takes `authn.throttle` and `authn.audit.hashKey.secret` from `@Config`; its copy of authn's throttle parameters goes

Row: authn-orm `DbAuthnThrottle`.

**Files:**
- Modify: `packages/authn/src/contracts/throttle.ts` (append the moved declarations), `packages/authn/src/throttle/params.ts:1-45` (replace the moved declarations by imports), `packages/authn/src/throttle/memory-throttle.ts:11` (import path)
- Delete: `packages/authn-orm/src/throttle/params.ts`
- Modify: `packages/authn-orm/src/throttle/db-throttle.ts:1-17` (imports), `:80-108` (members, constructor, `params`), `:376-392` (`load`), `packages/authn-orm/src/throttle/index.ts`
- Test: create `packages/authn-orm/test/support/config-boot.ts` (helper H) and `packages/authn-orm/test/throttle-config.test.ts`; delete `packages/authn-orm/test/throttle-params.test.ts`; edit `packages/authn-orm/test/db-throttle.test.ts:104-107`, `packages/authn-orm/test/support/db.ts` (register the authn schema in the child container)

**Interfaces:**
- Consumes: the `authn.throttle` schema block (already complete: `default: {}`, per-flow defaults, `propertyNames`, backoff fields `required`) and `authn.audit.hashKey.secret` (the pilot's block).
- Produces: `@spinajs/authn/contracts` exports `BackoffParams`, `ThrottleFlowParams`, `ThrottleParams`, `THROTTLE_FLOWS`, `DEFAULT_THROTTLE_PARAMS`, `backoffDelayMs` (moved verbatim from `packages/authn/src/throttle/params.ts`; the root keeps exporting them through `export * from './contracts/index.js'`). authn-orm's own copy (`params.ts`, "so this file can give way to that export") is deleted, along with `readThrottleConfig` and `checkThrottleParams`: explicit `params` passed to the constructor are now trusted, as Phase 2 does for `MemoryAuthnThrottle`, and `authn.throttle` is validated and filled by the schema.
- Behaviour change to expect: the old reader merged a partial backoff over the defaults (`login.account: { free: 2 }`); the schema, which was always in force at boot, requires all three fields of a backoff, so a partial one now fails the boot with `authn.throttle.login.account.baseDelayMs`. Fixtures that relied on the merge supply complete backoffs.
- `@Config` caveat, and how the seams stay: `DbAuthnThrottle` is a root singleton, so DI gives it the root's Configuration. `DbThrottleOptions.container` (tests, a non-root container) is a seam: a `new` instance has no injected container, so the constructor sets the hidden `CONFIGURATION_CONTAINER_KEY` to `options.container`. The constructor `params`, `options.hashKey` and `driver` seams stay (`this.fixedParams ?? this.ConfiguredParams`). What stays in code: `init()` still resolves the container's `Configuration` first (a `@Config` read needs a resolved Configuration) and resolves the Orm connection (a DI lookup); the "hash key not set" warning stays (it is a runtime advisory, not a value check).

- [ ] **Step 1: Schema additions**

None for authn-orm: `authn.throttle` already fills every flow (`default: {}`, `flow(...)` defaults, `resetAfterSeconds` 86400, `global: null`), and `maxRows` and `service` are accepted keys. The authn change is a code move, not a schema change. Append to `packages/authn/src/contracts/throttle.ts`:

```ts
export interface BackoffParams {
  readonly free: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** A key kind without params does not gate in that flow. */
export interface ThrottleFlowParams {
  readonly account?: BackoffParams;
  readonly ip?: BackoffParams;
}

export interface ThrottleParams {
  readonly login: ThrottleFlowParams;
  readonly mfa: ThrottleFlowParams;
  readonly reset: ThrottleFlowParams;
  readonly reauth: ThrottleFlowParams;
  readonly resetAfterSeconds: number;
  /** Off (null) unless configured: one attacker could slow every login. */
  readonly global?: BackoffParams | null;
}

export const THROTTLE_FLOWS: readonly ThrottleFlow[] = Object.freeze(['login', 'mfa', 'reset', 'reauth']);

const backoff = (free: number, baseDelayMs: number, maxDelayMs: number): BackoffParams => Object.freeze({ free, baseDelayMs, maxDelayMs });

/** Design §22.5 `authn.throttle`; the schema defaults equal it (test/boot/config-defaults.test.ts). */
export const DEFAULT_THROTTLE_PARAMS: ThrottleParams = Object.freeze({
  login: Object.freeze({ account: backoff(5, 1000, 60000), ip: backoff(20, 1000, 300000) }),
  mfa: Object.freeze({ account: backoff(3, 1000, 300000), ip: backoff(20, 1000, 300000) }),
  reset: Object.freeze({ account: backoff(1, 60000, 3600000), ip: backoff(5, 10000, 900000) }),
  reauth: Object.freeze({ account: backoff(3, 1000, 300000) }),
  resetAfterSeconds: 86400,
  global: null,
});

/** The wait after counted attempt n (1-based): 0 until n reaches free, then min(baseDelayMs × 2^(n − free), maxDelayMs). */
export function backoffDelayMs(p: BackoffParams, n: number): number {
  return n < p.free ? 0 : Math.min(p.baseDelayMs * 2 ** (n - p.free), p.maxDelayMs);
}
```

In `packages/authn/src/throttle/params.ts` replace lines 1-45 (the imports and everything up to and including `backoffDelayMs`) by:

```ts
import { InvalidOption } from '@spinajs/exceptions';

import { DEFAULT_THROTTLE_PARAMS, THROTTLE_FLOWS } from '../contracts/throttle.js';
import type { BackoffParams, ThrottleFlow, ThrottleFlowParams, ThrottleParams } from '../contracts/throttle.js';
```

and in `memory-throttle.ts:11` take `THROTTLE_FLOWS` and `backoffDelayMs` from `'../contracts/throttle.js'` instead of `'./params.js'` (keep `DEFAULT_THROTTLE_MAX_ROWS, checkMaxRows, checkThrottleParams, readThrottleConfig` from `./params.js` until Phase 2 deletes them). Run `grep -rn "from './params.js'\|from '../throttle/params.js'" packages/authn/src` and repoint any other moved name the same way.

- [ ] **Step 2: Write the failing tests**

Copy helper H to `packages/authn-orm/test/support/config-boot.ts`. `packages/authn-orm/test/throttle-config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { createHmac } from 'node:crypto';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { DEFAULT_THROTTLE_PARAMS, THROTTLE_FLOWS, backoffDelayMs } from '@spinajs/authn/contracts';
import type { ThrottleKey } from '@spinajs/authn/contracts';
import type { OrmDriver } from '@spinajs/orm';

import { DbAuthnThrottle } from '../src/index.js';
import { boot, disposeBooted, violationsOf } from './support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const HASH_KEY = 'k'.repeat(40);
const bad = (authn: Record<string, unknown>) => violationsOf(SCHEMAS, { authn });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('DbAuthnThrottle configuration', () => {
  afterEach(disposeBooted);

  it('uses authn core\'s throttle parameters, not a copy', () => {
    expect(THROTTLE_FLOWS).to.deep.eq(['login', 'mfa', 'reset', 'reauth']);
    expect(DEFAULT_THROTTLE_PARAMS.login.account).to.deep.eq({ free: 5, baseDelayMs: 1000, maxDelayMs: 60000 });
    expect([1, 4, 5, 6, 7, 11, 12].map((n) => backoffDelayMs({ free: 5, baseDelayMs: 1000, maxDelayMs: 60000 }, n))).to.deep.eq([0, 0, 1000, 2000, 4000, 60000, 60000]);
  });

  it('reads the schema defaults when authn.throttle is not configured', async () => {
    const { child } = await boot(SCHEMAS, {});
    const throttle = new DbAuthnThrottle({} as OrmDriver, undefined, { container: child });
    await throttle.init();
    expect(clone(throttle.params)).to.deep.eq(clone(DEFAULT_THROTTLE_PARAMS));
  });

  it('reads authn.throttle at call time', async () => {
    const { child, configuration } = await boot(SCHEMAS, {});
    const throttle = new DbAuthnThrottle({} as OrmDriver, undefined, { container: child });
    await throttle.init();
    expect(throttle.params.login.account?.free).to.eq(5);
    configuration.set('authn.throttle.login.account.free', 9);
    expect(throttle.params.login.account?.free).to.eq(9);
  });

  it('takes explicit params as given, without a container', () => {
    const throttle = new DbAuthnThrottle({} as OrmDriver, DEFAULT_THROTTLE_PARAMS);
    expect(throttle.params).to.eq(DEFAULT_THROTTLE_PARAMS);
  });

  it('keys rows with authn.audit.hashKey.secret from the container\'s configuration', async () => {
    const { child } = await boot(SCHEMAS, { authn: { audit: { hashKey: { secret: HASH_KEY } } } });
    const throttle = new DbAuthnThrottle({} as OrmDriver, undefined, { container: child });
    await throttle.init();
    const key: ThrottleKey = { kind: 'account', value: 'keyed@example.test' };
    expect(throttle.rowKey('login', key)).to.eq(createHmac('sha256', HASH_KEY).update('login|account|keyed@example.test', 'utf8').digest('base64url'));
  });

  it('names the bad key instead of merging or throwing from the reader', async () => {
    expect(await bad({ throttle: { logins: {} } })).to.include('authn.throttle.logins');
    expect(await bad({ throttle: { login: { acount: {} } } })).to.include('authn.throttle.login.acount');
    expect(await bad({ throttle: { login: { account: { free: -1, baseDelayMs: 1, maxDelayMs: 1 } } } })).to.include('authn.throttle.login.account.free');
    expect(await bad({ throttle: { resetAfterSeconds: 0 } })).to.include('authn.throttle.resetAfterSeconds');
    expect(await bad({ throttle: { global: { free: 1 } } })).to.include.members(['authn.throttle.global.baseDelayMs', 'authn.throttle.global.maxDelayMs']);
    expect(await bad({ throttle: { login: { account: { free: 2 } } } })).to.include('authn.throttle.login.account.baseDelayMs');
  });
});
```

Delete `packages/authn-orm/test/throttle-params.test.ts` (its cases are the deleted reader's; the `backoffDelayMs` case is in the new file). In `db-throttle.test.ts` delete the test "throws InvalidOption on explicit params with an unknown key" (lines 104-107) and the now unused `InvalidOption` and `ThrottleParams` imports if nothing else uses them. In `test/support/db.ts`, next to `container.register(configurationFor(...)).as(Configuration)` (line ~154), add `container.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');` with `import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';`; and wherever `options.config` (grep `throttle:` in `test/`) holds a partial backoff such as `login: { account: { free: 2 } }`, complete it to `{ free: 2, baseDelayMs: 1000, maxDelayMs: 60000 }`.

- [ ] **Step 3: RED**

Run: `cd packages/authn-orm && npx ts-mocha -p tsconfig.json test/throttle-config.test.ts`
Expected: FAIL. `THROTTLE_FLOWS`, `DEFAULT_THROTTLE_PARAMS` and `backoffDelayMs` are not exported by `@spinajs/authn/contracts` yet (the first test, and a compile error for the named imports), and once they are, "reads authn.throttle at call time" still fails because `DbAuthnThrottle` snapshots the parameters in `init()`.

- [ ] **Step 4: Implement**

1. Apply the Step 1 authn edits, then `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
2. Delete `packages/authn-orm/src/throttle/params.ts`. `packages/authn-orm/src/throttle/index.ts`:

```ts
export type { BackoffParams, ThrottleFlowParams, ThrottleParams } from '@spinajs/authn/contracts';
export { DbAuthnThrottle } from './db-throttle.js';
export type { DbThrottleOptions } from './db-throttle.js';
```

3. `db-throttle.ts` imports (lines 4-17):

```ts
import { createHmac } from 'node:crypto';

import { AuthnThrottle, DEFAULT_THROTTLE_PARAMS, THROTTLE_FLOWS, backoffDelayMs } from '@spinajs/authn/contracts';
import type { AuthnContext, BackoffParams, ThrottleFlow, ThrottleFlowParams, ThrottleKey, ThrottleParams } from '@spinajs/authn/contracts';
import { CONFIGURATION_CONTAINER_KEY, Config, Configuration } from '@spinajs/configuration';
import { DI, IContainer, Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { Orm, OrmDriver } from '@spinajs/orm';
import type { RawQuery, WhereBuilder } from '@spinajs/orm';

import { checkedMs, columnText, driverDialect, isDuplicate, rowsAffected, selectTime, sqlTime, textMs } from '../support/sql.js';
import type { Dialect } from '../support/sql.js';
```

4. Members, constructor and `params` (replace from `private readonly explicitParams` through the end of the `params` getter):

```ts
  @Config('authn.throttle')
  protected ConfiguredParams: ThrottleParams;

  @Config('authn.audit.hashKey.secret')
  protected ConfiguredHashSecret: string | null | undefined;

  /** Complete params given to the constructor, or the §22.5 defaults when there is a driver and no container to read them from. */
  private readonly fixedParams: ThrottleParams | undefined;
  private configurationLoaded = false;
  private hmacKey: Buffer | undefined;
  private dialect: Dialect = 'other';
  private loading: Promise<void> | undefined;
  private attempts = 0;

  /**
   * DI passes nothing: the `'default'` connection, `authn.throttle` and `authn.audit.hashKey.secret` come from the
   * container on first use (`init`). With a driver and no container nothing is read from the configuration:
   * `params` default to §22.5 and the hash key to `options.hashKey`.
   */
  constructor(private driver?: OrmDriver, params?: ThrottleParams, private readonly options: DbThrottleOptions = {}) {
    super();
    if (options.container) {
      // An instance built with `new` has no injected container, so @Config would read the root Configuration.
      Object.defineProperty(this, CONFIGURATION_CONTAINER_KEY, { value: options.container, configurable: true, writable: true });
    }
    this.fixedParams = params ?? (this.usesConfiguration() ? undefined : DEFAULT_THROTTLE_PARAMS);
    if (!this.usesConfiguration()) {
      this.hmacKey = hashKeyOf(this.options.hashKey);
    }
  }

  public get params(): ThrottleParams {
    if (this.fixedParams) return this.fixedParams;
    if (!this.configurationLoaded) throw new InvalidOption('DbAuthnThrottle: params are read from the configuration; await init() first');
    return this.ConfiguredParams;
  }
```

(`THROTTLE_FLOWS` and `backoffDelayMs` keep their uses further down the file; `readThrottleConfig` and `checkThrottleParams` are gone.)

5. `load()`:

```ts
  private async load(): Promise<void> {
    const container = this.options.container ?? DI.RootContainer;
    if (this.usesConfiguration()) {
      // A @Config read needs the container's Configuration resolved.
      await container.resolve(Configuration);
      const secret = this.options.hashKey !== undefined ? this.options.hashKey : this.ConfiguredHashSecret;
      this.hmacKey = hashKeyOf(secret);
      this.configurationLoaded = true;
      if (typeof secret !== 'string' || secret.length === 0) {
        warnOnce('DbAuthnThrottle: authn.audit.hashKey.secret is not set, so throttle row keys are hashed under a public constant; anyone reading authn_throttle can test guessed logins and IPs against them');
      }
    }
    if (!this.driver) {
      const orm = await container.resolve(Orm);
      const driver = orm.Connections.get('default');
      if (!driver) throw new InvalidOption("DbAuthnThrottle: the Orm has no 'default' connection");
      this.driver = driver;
    }
    this.dialect = driverDialect(this.driver);
  }
```

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-orm && npx ts-mocha -p tsconfig.json test/throttle-config.test.ts test/db-throttle.test.ts test/throttle-conformance.test.ts`, then `npm test`.
2. `cd packages/authn && npm test` (the moved declarations; every authn throttle test is the behaviour pin).
3. Rebuild authn-orm: `cd packages/authn-orm && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `for p in authn-oidc authn-totp; do (cd packages/$p && npm test) || break; done`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/contracts/throttle.ts packages/authn/src/throttle packages/authn-orm/src packages/authn-orm/test
git commit -m "refactor(authn-orm): DbAuthnThrottle reads authn.throttle through @Config; the copy of authn's throttle params goes"
```

---

### Task 3.6: authn-local classes take `authn.local.*` from the schema alone

Row: authn-local `Argon2PasswordHasher`, `LocalPasswordPolicy`, `PasswordExpirationJob` (and `LocalPasswordService`, whose four defaults are the same kind of code default).

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:72-138` (the `local` block)
- Modify: `packages/authn-local/src/hasher.ts:52`, `:58-66`, `:158-199` (`buildSettings`, `checkVersion`)
- Modify: `packages/authn-local/src/policy.ts:22`, `:76-96` (fields), `:143-155` (`generate`), `:225-262` (`buildSettings`)
- Modify: `packages/authn-local/src/expiration.ts:45-50` (fields), `:57-64` (`run`)
- Modify: `packages/authn-local/src/service.ts:82-94` (four fields)
- Test: create `packages/authn-local/test/support/config-boot.ts` (helper H) and `packages/authn-local/test/config-schema.test.ts`; edit `test/argon2-hasher.test.ts` (~line 284), `test/policy.test.ts` (~lines 80-90, 363), `test/strategy.test.ts` (~611), `test/expiry.test.ts`, `test/kit-harness.ts`

**Interfaces:**
- Consumes: `AUTHN_CONFIGURATION_SCHEMA` (rebuilt in Step 4).
- Produces: schema defaults `authn.local.hasher.maxConcurrent 8`, `pepper { secret: null, version: 1 }`, `policy.minLength 8`, `policy.maxLength 128` (with `minimum: { $data: '1/minLength' }`), `policy.rule null`, `policy.blocklist null`, `generator { length 16, characters [lower, upper, digits] }`, `reset { ttlSeconds 3600, url '', revokeTokens true }`, `invite.ttlSeconds 900`, `expiration { enabled false, maxAgeDays 31 }`; `pepper.version` and `previous[].version` at most 999999999.
- Stays in code, and why: the pepper version of a `previous` entry must differ from the CURRENT `version` (a rule across two values that a schema cannot state; `uniqueItemProperties` covers previous against previous); the policy `rule` is compiled with Ajv (a compile, not a value check); `blocklist` is a DI name lookup; `generate()` keeps "generator.length lies within the policy bounds" (it throws `UnexpectedServerError`, a fault no caller can fix, by design). The constructor `Options`/`Deps` seams stay as they are and keep bypassing the configuration: `this.Options ? seamValue : this.ConfiguredValue`; the literals a seam falls back to (`8`, `31`, `false`) are the seam's own and are pinned equal to the schema defaults by the new test.
- Phase 2 note: Phase 2's schema work adds `pepper.version` maximum 999999999 and unique previous versions to the same block; every fragment below is marked "skip when present". The shipped authn-local config keeps `hasher`, `pepper`, `policy.{minLength, maxLength, blocklist}` and `reset.revokeTokens`; the `rule`, `description`, `generator` and `expiration` keys have no shipped values, because `@spinajs/users` ships 2.x values under those paths (its `generator.characters` array would be concatenated with ours); a schema default fills only an ABSENT value, so that constraint is kept.

- [ ] **Step 1: Schema additions**

Replace the `local` block (lines 72-138) with the following (unchanged members are copied; the changes are the `default`s, the two version maxima, `maxLength`'s `$data` minimum, `maxAgeDays` and the `generator` per-field defaults):

```ts
    local: {
      type: 'object',
      properties: {
        hasher: {
          type: 'object',
          default: {},
          description: 'No argon2 cost keys: the cost is the library default (H30).',
          propertyNames: { enum: ['service', 'maxConcurrent'] },
          properties: {
            service: { type: 'string', minLength: 1 },
            maxConcurrent: { type: 'integer', minimum: 1, default: 8, description: 'Argon2 operations at once; the rest queue.' },
          },
        },
        pepper: {
          ...secretRef('HMAC-SHA256 pepper applied before argon2.', {
            version: { type: 'integer', minimum: 1, maximum: 999999999, default: 1, description: 'Stored in the hash prefix so the pepper can rotate.' },
            previous: {
              type: 'array',
              description: 'Older peppers, so a hash made under one still verifies and is rehashed (A03). Each version differs from the others (here) and from `version` (checked at boot).',
              uniqueItemProperties: ['version'],
              items: {
                type: 'object',
                properties: {
                  secret: { type: 'string', minLength: 1 },
                  version: { type: 'integer', minimum: 1, maximum: 999999999 },
                },
                required: ['secret', 'version'],
              },
            },
          }),
          default: { secret: null, version: 1 },
        },
        policy: {
          type: 'object',
          default: {},
          properties: {
            minLength: { type: 'integer', minimum: 8, maximum: 128, default: 8, description: 'Passwords are 8–128 characters everywhere (A04).' },
            maxLength: { type: 'integer', minimum: { $data: '1/minLength' }, maximum: 128, default: 128 },
            rule: { type: ['object', 'null'], default: null, description: 'A JSON schema the password must match.' },
            description: { type: 'string' },
            blocklist: { type: ['string', 'null'], default: null, description: 'PasswordBlocklist service.' },
          },
        },
        generator: {
          type: 'object',
          default: {},
          properties: {
            length: { type: 'integer', minimum: 1, default: 16 },
            characters: { ...stringList, minItems: 1, default: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'], description: 'Concatenated into one pool.' },
          },
        },
        reset: {
          type: 'object',
          default: {},
          properties: {
            ttlSeconds: { type: 'integer', minimum: 1, default: 3600 },
            url: { type: 'string', default: '' },
            revokeTokens: { type: 'boolean', default: true },
          },
        },
        invite: {
          type: 'object',
          default: {},
          properties: {
            ttlSeconds: { type: 'integer', minimum: 1, default: 900 },
          },
        },
        expiration: {
          type: 'object',
          default: {},
          properties: {
            enabled: { type: 'boolean', default: false },
            maxAgeDays: { type: 'number', exclusiveMinimum: 0, default: 31 },
          },
        },
      },
    },
```

`policy.maxLength` loses its separate `minimum: 8`: `minLength` already has `minimum: 8`, so `maxLength >= minLength >= 8` holds. `policy.description` is new (the class already read it; before, it had no schema entry).

- [ ] **Step 2: Write the failing tests**

Copy helper H to `packages/authn-local/test/support/config-boot.ts`. `packages/authn-local/test/config-schema.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

import authnLocal from '../src/config/authn-local.js';
import { Argon2PasswordHasher } from '../src/hasher.js';
import { LocalPasswordPolicy } from '../src/policy.js';
import { PasswordExpirationJob } from '../src/expiration.js';
import { boot, disposeBooted, readingFrom, violationsOf } from './support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const bad = (local: Record<string, unknown>) => violationsOf(SCHEMAS, { authn: { local } });

describe('authn.local through the schema', function () {
  this.timeout(30000);
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('fills every key the classes used to default in code', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.local.hasher.maxConcurrent')).to.eq(8);
      expect(configuration.get('authn.local.pepper')).to.deep.eq({ secret: null, version: 1 });
      expect(configuration.get('authn.local.policy')).to.deep.eq({ minLength: 8, maxLength: 128, rule: null, blocklist: null });
      expect(configuration.get('authn.local.generator.length')).to.eq(16);
      expect(configuration.get('authn.local.generator.characters')).to.have.length(3);
      expect(configuration.get('authn.local.reset')).to.deep.eq({ ttlSeconds: 3600, url: '', revokeTokens: true });
      expect(configuration.get('authn.local.invite.ttlSeconds')).to.eq(900);
      expect(configuration.get('authn.local.expiration')).to.deep.eq({ enabled: false, maxAgeDays: 31 });
    });

    it('keeps the shipped package config equal to the schema defaults it repeats', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      const shipped = authnLocal.authn.local;
      expect(configuration.get('authn.local.hasher.maxConcurrent')).to.eq(shipped.hasher.maxConcurrent);
      expect(configuration.get('authn.local.pepper.version')).to.eq(shipped.pepper.version);
      expect(configuration.get('authn.local.policy.minLength')).to.eq(shipped.policy.minLength);
      expect(configuration.get('authn.local.policy.maxLength')).to.eq(shipped.policy.maxLength);
      expect(configuration.get('authn.local.reset.revokeTokens')).to.eq(shipped.reset.revokeTokens);
    });

    it('fills a partial generator and keeps a configured value', async () => {
      const { configuration } = await boot(SCHEMAS, { authn: { local: { generator: { length: 20 } } } });
      expect(configuration.get('authn.local.generator.length')).to.eq(20);
      expect(configuration.get('authn.local.generator.characters')).to.have.length(3);
    });
  });

  describe('violations', () => {
    it('names the bad key', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ hasher: { maxConcurrent: 0 } }, 'authn.local.hasher.maxConcurrent'],
        [{ hasher: { maxConcurrent: 1.5 } }, 'authn.local.hasher.maxConcurrent'],
        [{ hasher: { cost: 4 } }, 'authn.local.hasher.cost'],
        [{ pepper: { secret: 'x', version: 0 } }, 'authn.local.pepper.version'],
        [{ pepper: { secret: 'x', version: 1_000_000_000 } }, 'authn.local.pepper.version'],
        [{ pepper: { secret: 'x', version: 1, previous: [{ secret: 'y', version: 1_000_000_000 }] } }, 'authn.local.pepper.previous.0.version'],
        [{ pepper: { secret: 'x', version: 3, previous: [{ secret: 'y', version: 1 }, { secret: 'z', version: 1 }] } }, 'authn.local.pepper.previous'],
        [{ pepper: { secret: 'x', previous: [{ secret: '', version: 1 }] } }, 'authn.local.pepper.previous.0.secret'],
        [{ policy: { minLength: 7 } }, 'authn.local.policy.minLength'],
        [{ policy: { minLength: 129 } }, 'authn.local.policy.minLength'],
        [{ policy: { maxLength: 129 } }, 'authn.local.policy.maxLength'],
        [{ policy: { minLength: 20, maxLength: 10 } }, 'authn.local.policy.maxLength'],
        [{ policy: { rule: 'a-string' } }, 'authn.local.policy.rule'],
        [{ generator: { length: 0 } }, 'authn.local.generator.length'],
        [{ generator: { characters: [] } }, 'authn.local.generator.characters'],
        [{ reset: { ttlSeconds: 0 } }, 'authn.local.reset.ttlSeconds'],
        [{ invite: { ttlSeconds: 0 } }, 'authn.local.invite.ttlSeconds'],
        [{ expiration: { maxAgeDays: 0 } }, 'authn.local.expiration.maxAgeDays'],
        [{ expiration: { maxAgeDays: -3 } }, 'authn.local.expiration.maxAgeDays'],
      ];
      for (const [local, path] of cases) expect(await bad(local), JSON.stringify(local)).to.include(path);
    });

    it('accepts equal bounds, a fractional expiry and a rotation', async () => {
      expect(await bad({ policy: { minLength: 12, maxLength: 12 } })).to.deep.eq([]);
      expect(await bad({ expiration: { enabled: true, maxAgeDays: 0.5 } })).to.deep.eq([]);
      expect(await bad({ pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 1 }] } })).to.deep.eq([]);
    });
  });

  describe('through @Config', () => {
    it('LocalPasswordPolicy reads its bounds and rule from the booted configuration', async () => {
      const { child } = await boot(SCHEMAS, { authn: { local: { policy: { minLength: 10, maxLength: 20, rule: { type: 'string', pattern: '[0-9]' }, description: 'needs a digit' } } } });
      const policy = readingFrom(new LocalPasswordPolicy(), child);
      policy.resolve();
      expect(policy.policy()).to.deep.include({ minLength: 10, maxLength: 20, pattern: '[0-9]', description: 'needs a digit' });
      expect(await policy.check('abcdefghij')).to.deep.eq(['rule']);
      expect(await policy.check('abcdefghi1')).to.deep.eq([]);
    });

    it('LocalPasswordPolicy still refuses a rule that does not compile and a blocklist that is not registered', async () => {
      const compile = await boot(SCHEMAS, { authn: { local: { policy: { rule: { type: 'no-such-type' } } } } });
      expect(() => readingFrom(new LocalPasswordPolicy(), compile.child).resolve()).to.throw(/does not compile/);
      const blocklist = await boot(SCHEMAS, { authn: { local: { policy: { blocklist: 'NoSuchBlocklist' } } } });
      expect(() => readingFrom(new LocalPasswordPolicy(), blocklist.child).resolve()).to.throw(/not registered as a PasswordBlocklist/);
    });

    it('LocalPasswordPolicy generates within the policy bounds and refuses a generator outside them', async () => {
      const ok = await boot(SCHEMAS, {});
      expect(readingFrom(new LocalPasswordPolicy(), ok.child).generate()).to.have.length(16);
      const outside = await boot(SCHEMAS, { authn: { local: { policy: { minLength: 20 }, generator: { length: 16 } } } });
      expect(() => readingFrom(new LocalPasswordPolicy(), outside.child).generate()).to.throw(/outside authn.local.policy bounds/);
    });

    it('Argon2PasswordHasher refuses a previous pepper that reuses the current version', async () => {
      const { child } = await boot(SCHEMAS, { authn: { local: { pepper: { secret: 'current', version: 2, previous: [{ secret: 'old', version: 2 }] } } } });
      let error: unknown;
      try {
        await readingFrom(new Argon2PasswordHasher(), child).resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.match(/previous\[0\]\.version 2 is already used by another pepper/);
    });

    it('Argon2PasswordHasher hashes under the configured pepper and verifies a hash made under a previous one', async () => {
      const old = await boot(SCHEMAS, { authn: { local: { pepper: { secret: 'old-pepper', version: 1 } } } });
      const oldHasher = readingFrom(new Argon2PasswordHasher(), old.child);
      await oldHasher.resolve();
      const stored = await oldHasher.hash('correct horse battery');
      expect(stored.startsWith('$sp1$')).to.eq(true);

      const rotated = await boot(SCHEMAS, { authn: { local: { pepper: { secret: 'new-pepper', version: 2, previous: [{ secret: 'old-pepper', version: 1 }] } } } });
      const hasher = readingFrom(new Argon2PasswordHasher(), rotated.child);
      await hasher.resolve();
      expect(await hasher.verify(stored, 'correct horse battery')).to.eq(true);
      expect(hasher.needsRehash(stored)).to.eq(true);
    });

    it('PasswordExpirationJob reads enabled and maxAgeDays; the Deps seam keeps its own literals equal to the schema defaults', async () => {
      const { child, configuration } = await boot(SCHEMAS, { authn: { local: { expiration: { enabled: true, maxAgeDays: 7 } } } });
      const job = readingFrom(new PasswordExpirationJob(), child) as unknown as { Enabled: boolean; MaxAgeDays: number };
      expect([job.Enabled, job.MaxAgeDays]).to.deep.eq([true, 7]);
      expect(configuration.get('authn.local.expiration.maxAgeDays')).to.eq(7);
      const defaults = (await boot(SCHEMAS, {})).configuration;
      expect([defaults.get('authn.local.expiration.enabled'), defaults.get('authn.local.expiration.maxAgeDays')]).to.deep.eq([false, 31]);
    });
  });
});
```

Delete from the existing suites the cases the schema now owns (grep `InvalidOption` in each): `test/argon2-hasher.test.ts` ~line 284 (the loop that builds a hasher from bad `maxConcurrent`, `secret` and `version` options and expects `InvalidOption`; keep any case about a previous pepper reusing the current version), `test/policy.test.ts` ~lines 80-90 (bounds, `minLength > maxLength`, wrong types) and ~363 (a `rule` that is not an object), `test/strategy.test.ts` ~611 and `test/expiry.test.ts` (a non-positive `maxAgeDays` through `Deps`). Keep the rule-compile cases at `policy.test.ts` ~110-112 (`'('` pattern, `no-such-type`, a non-schema string: all still raise `InvalidOption` from the compile). Fixtures that boot the ROOT Configuration (`grep -rn "resolve(Configuration)\|FrameworkConfiguration" test`, notably `test/kit-harness.ts`) register `AUTHN_CONFIGURATION_SCHEMA` first (`DI.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__')`) because the code defaults are gone.

- [ ] **Step 3: RED**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/config-schema.test.ts`
Expected: FAIL. The old authn lib has none of these defaults (the "defaults" cases read `undefined`), `hasher.cost`, `previous[].version` over 999999999 and `maxLength < minLength` are not refused, and `maxAgeDays: 0.5` is refused by the old `minimum: 1`.

- [ ] **Step 4: Implement**

1. Apply the Step 1 schema, then `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

2. `hasher.ts`: the fields lose their defaults and `buildSettings` loses every check the schema owns; `checkVersion` is deleted (lines 194-199):

```ts
  @Config('authn.local.hasher.maxConcurrent')
  protected MaxConcurrent: number;

  @Config('authn.local.pepper')
  protected Pepper: PepperConfig;
```

```ts
  private buildSettings(options: Argon2PasswordHasherOptions): HasherSettings {
    const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    const pepper = options.pepper;
    const peppers = new Map<number, PepperEntry>();
    let current: PepperEntry | null = null;

    if (pepper?.secret) {
      current = { secret: pepper.secret, version: pepper.version };
      peppers.set(current.version, current);
    }

    for (const [i, entry] of (pepper?.previous ?? []).entries()) {
      // The schema keeps previous versions apart from each other; a clash with the current one is a rule across two values.
      if (peppers.has(entry.version)) {
        throw new InvalidOption(`authn.local.pepper.previous[${i}].version ${entry.version} is already used by another pepper`);
      }
      peppers.set(entry.version, { secret: entry.secret, version: entry.version });
    }

    return { maxConcurrent, current, peppers };
  }
```

`DEFAULT_MAX_CONCURRENT` stays only as the seam's fallback (comment on its line: `// The Options seam's fallback; equals the schema default.`).

3. `policy.ts`: the fields lose their defaults (`DEFAULT_GENERATOR` stays for the `Options` seam):

```ts
  @Config('authn.local.policy.minLength')
  protected MinLength: number;

  @Config('authn.local.policy.maxLength')
  protected MaxLength: number;

  @Config('authn.local.policy.rule')
  protected Rule: object | null;

  @Config('authn.local.policy.description')
  protected Description: string | undefined;

  @Config('authn.local.generator')
  protected Generator: GeneratorConfig;

  // A name read here and resolved below rather than @AutoinjectService, which logs a warning on every boot for the default null.
  @Config('authn.local.policy.blocklist')
  protected BlocklistName: string | null;
```

(delete the two comment lines above `Generator`: the schema, not code, now holds its default). `generate()` lines 143-155 become:

```ts
  public generate(): string {
    const { minLength, maxLength } = this.settings;
    const { length, characters } = this.Options ? { ...DEFAULT_GENERATOR, ...this.Options.generator } : this.Generator;
    const pool = [...new Set([...characters.join('')])];

    if (length < minLength || length > maxLength) {
      throw new UnexpectedServerError(`authn.local.generator.length ${length} is outside authn.local.policy bounds ${minLength}–${maxLength}`);
    }
```

and `buildSettings` (lines 225-262) keeps only the compile and the derived fields:

```ts
  private buildSettings(options: LocalPasswordPolicyOptions): PolicySettings {
    const minLength = options.minLength ?? PASSWORD_MIN_LENGTH;
    const maxLength = options.maxLength ?? PASSWORD_MAX_LENGTH;

    const schema = options.rule ?? null;
    let rule: ValidateFunction | null = null;
    if (schema !== null) {
      try {
        rule = new Ajv().compile(schema);
      } catch (err) {
        throw new InvalidOption(`authn.local.policy.rule does not compile: ${(err as Error).message}`);
      }
    }

    const pattern = (schema as { pattern?: unknown } | null)?.pattern;
    const description = options.description;

    return {
      minLength,
      maxLength,
      rule,
      ...(typeof pattern === 'string' ? { pattern } : {}),
      ...(typeof description === 'string' && description.trim() !== '' ? { description } : {}),
    };
  }
```

4. `expiration.ts`: `@Config('authn.local.expiration.enabled')` and `@Config('authn.local.expiration.maxAgeDays')` (delete the two defaults and the "Code defaults" comment), and in `run` delete the `typeof maxAgeDays` guard (lines 62-64) and with it the `InvalidOption` import if unused.

5. `service.ts` lines 82-94: `@Config('authn.local.reset.revokeTokens')`, `@Config('authn.local.reset.ttlSeconds')`, `@Config('authn.local.reset.url')`, `@Config('authn.local.invite.ttlSeconds')`; delete the "Code defaults" comment.

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/config-schema.test.ts`, then `npm test`.
2. `cd packages/authn && npm test` (if `test/contracts/config-schema.test.ts` pins the old `maxAgeDays` minimum of 1 or the absence of a `policy.description` key, update it to the new rules).
3. Rebuild authn-local: `cd packages/authn-local && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `for p in email users; do (cd packages/$p && npm test) || break; done`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn-local/src packages/authn-local/test
git commit -m "refactor(authn-local): authn.local.* defaults and ranges move into the schema, no hand validation"
```

---

### Task 3.7: authn-keys reads `authn.keys` from `@Config` and the schema; `keysOptions` goes

Row: authn-keys `configuredKeysOptions` + 4 strategies (`DefaultKeyRegistry`, `JwsAssertionStrategy`, `KeyChallengeStrategy`, `HttpSignatureStrategy`).

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:257-278` (the `keys` block)
- Modify: `packages/authn-keys/src/options/options.ts` (whole file)
- Modify: `packages/authn-keys/src/registry/registry.ts:7-8`, `:60-76`; `packages/authn-keys/src/strategies/assertion.ts:9-50`, `:83`; `packages/authn-keys/src/strategies/challenge.ts:7-34`; `packages/authn-keys/src/strategies/httpsig.ts:9-49`
- Modify: `packages/authn-keys/src/config/authn-keys.ts:108-110` (a comment)
- Test: create `packages/authn-keys/test/support/config-boot.ts` (helper H), `packages/authn-keys/test/support/keys-options.ts`, `packages/authn-keys/test/config-schema.test.ts`; edit `test/harness.ts:9,60`, `test/assertion.test.ts:9,175`, `test/challenge.test.ts:8,101`, `test/httpsig.test.ts:9,128,135`, `test/registry.test.ts:9,19,41,184,194`

**Interfaces:**
- Consumes: `AUTHN_CONFIGURATION_SCHEMA` (Step 4 rebuilds it).
- Produces: `KeysConfig` (what the schema yields), `keysOptionsOf(config): KeysOptions` (pure and cached per config object: it freezes, and resolves `challenge.audience ?? assertion.audience`), and the schema defaults `algorithms ['EdDSA','ES256']`, `challenge.ttlSeconds 120` (1-3600), `challenge.audience null`, `assertion.{typ 'spinajs-client+jwt', audience null, maxLifetimeSeconds 300, skewSeconds 30 (0-300)}`, `httpSignature.{maxAgeSeconds 300, skewSeconds 30 (0-300), requiredComponents ['@method','@target-uri','content-digest']}`. Removed: `keysOptions`, `configuredKeysOptions`, `DEFAULT_KEYS_OPTIONS`, `KeysOptionsInput`, `MAX_LIFETIME_SECONDS`.
- Stays in code, and why: the audience requirements (`assertion.audience` for `JwsAssertionStrategy`, `challenge.audience` or the assertion one for `KeyChallengeStrategy` and challenge issuing) depend on WHICH strategies are listed, so they stay boot checks; the `challenge.audience` fallback to `assertion.audience` is a default derived from another key. Because a `@Config` read cannot happen in a constructor (a DI-built instance has no hidden container key yet, so it would read the ROOT Configuration), the strategies' constructor throws move to `resolve()` (they are `AsyncService`s, so DI runs it at boot) and the audience becomes a getter. The `options?: KeysOptions` constructor seam stays: `this.Options ?? keysOptionsOf(this.KeysConfig)`.
- `coerceTypes` note: `audience: ''` is coerced to `null` (the type list includes `null`), so an empty audience reads as "not set" and the strategy then refuses to boot, instead of the old "must be a non-empty string or null" message.

- [ ] **Step 1: Schema additions**

Replace the `keys` block (lines 257-278) with:

```ts
    keys: {
      type: 'object',
      default: {},
      properties: {
        algorithms: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['EdDSA', 'ES256'] }, default: ['EdDSA', 'ES256'] },
        challenge: {
          type: 'object',
          default: {},
          properties: {
            ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 120 },
            audience: { type: ['string', 'null'], minLength: 1, default: null, description: "What clients put in a challenge's signing input; default: assertion.audience. Challenges need one of them." },
          },
        },
        assertion: {
          type: 'object',
          default: {},
          properties: {
            typ: { type: 'string', minLength: 1, default: 'spinajs-client+jwt' },
            audience: { type: ['string', 'null'], minLength: 1, default: null, description: 'Required once a strategy that reads assertions is listed.' },
            maxLifetimeSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 300 },
            skewSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 30 },
          },
        },
        httpSignature: {
          type: 'object',
          default: {},
          properties: {
            maxAgeSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 300 },
            skewSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 30 },
            requiredComponents: { ...stringList, default: ['@method', '@target-uri', 'content-digest'] },
          },
        },
      },
    },
```

- [ ] **Step 2: Write the failing tests**

Copy helper H to `packages/authn-keys/test/support/config-boot.ts`. `packages/authn-keys/test/support/keys-options.ts` (the complete options the tests used to get from `keysOptions()`; pinned to the schema by the new test):

```ts
import { keysOptionsOf } from '../../src/options/index.js';
import type { KeysConfig, KeysOptions } from '../../src/options/index.js';

export const TEST_KEYS_CONFIG: KeysConfig = {
  algorithms: ['EdDSA', 'ES256'],
  challenge: { ttlSeconds: 120, audience: null },
  assertion: { typ: 'spinajs-client+jwt', audience: null, maxLifetimeSeconds: 300, skewSeconds: 30 },
  httpSignature: { maxAgeSeconds: 300, skewSeconds: 30, requiredComponents: ['@method', '@target-uri', 'content-digest'] },
};

export interface KeysOverrides {
  readonly algorithms?: KeysConfig['algorithms'];
  readonly challenge?: Partial<KeysConfig['challenge']>;
  readonly assertion?: Partial<KeysConfig['assertion']>;
  readonly httpSignature?: Partial<KeysConfig['httpSignature']>;
}

export const keysOptionsFor = (over: KeysOverrides = {}): KeysOptions =>
  keysOptionsOf({
    algorithms: over.algorithms ?? TEST_KEYS_CONFIG.algorithms,
    challenge: { ...TEST_KEYS_CONFIG.challenge, ...over.challenge },
    assertion: { ...TEST_KEYS_CONFIG.assertion, ...over.assertion },
    httpSignature: { ...TEST_KEYS_CONFIG.httpSignature, ...over.httpSignature },
  });
```

`packages/authn-keys/test/config-schema.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { MemorySecretStore, FakeBackoffThrottle, throttleParams } from '@spinajs/authn-testing';

import { keysOptionsOf } from '../src/options/index.js';
import type { KeysConfig } from '../src/options/index.js';
import { MemoryKeyNonceStore } from '../src/nonce/index.js';
import { DefaultKeyRegistry, MemoryKeyStore } from '../src/registry/index.js';
import { HttpSignatureStrategy, JwsAssertionStrategy, KeyChallengeStrategy } from '../src/strategies/index.js';
import { StrictJwsVerifier } from '../src/jws/index.js';
import { boot, disposeBooted, readingFrom, violationsOf } from './support/config-boot.js';
import { TEST_KEYS_CONFIG } from './support/keys-options.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const bad = (keys: Record<string, unknown>) => violationsOf(SCHEMAS, { authn: { keys } });
const AUD = 'https://keys.example.test';

async function parts(keys: Record<string, unknown>) {
  const { child, configuration } = await boot(SCHEMAS, { authn: { keys } });
  const registry = readingFrom(new DefaultKeyRegistry(new MemoryKeyStore(), new MemorySecretStore(), new FakeBackoffThrottle(throttleParams()), []), child);
  return { child, configuration, registry };
}

describe('authn.keys through the schema', () => {
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('fills the whole block, equal to the test fixture', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.keys')).to.deep.eq({ ...TEST_KEYS_CONFIG });
    });

    it('keeps a configured value and fills the rest of its block', async () => {
      const { configuration } = await boot(SCHEMAS, { authn: { keys: { assertion: { audience: AUD, skewSeconds: 10 } } } });
      expect(configuration.get('authn.keys.assertion')).to.deep.eq({ ...TEST_KEYS_CONFIG.assertion, audience: AUD, skewSeconds: 10 });
      expect(configuration.get('authn.keys.httpSignature.skewSeconds')).to.eq(30);
    });
  });

  describe('violations', () => {
    it('names the bad key', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ algorithms: [] }, 'authn.keys.algorithms'],
        [{ algorithms: ['RS256'] }, 'authn.keys.algorithms.0'],
        [{ algorithms: ['EdDSA', 'EdDSA'] }, 'authn.keys.algorithms'],
        [{ challenge: { ttlSeconds: 0 } }, 'authn.keys.challenge.ttlSeconds'],
        [{ challenge: { ttlSeconds: 3601 } }, 'authn.keys.challenge.ttlSeconds'],
        [{ challenge: { audience: 42 } }, 'authn.keys.challenge.audience'],
        [{ assertion: { typ: '' } }, 'authn.keys.assertion.typ'],
        [{ assertion: { maxLifetimeSeconds: 301 } }, 'authn.keys.assertion.maxLifetimeSeconds'],
        [{ assertion: { maxLifetimeSeconds: 0 } }, 'authn.keys.assertion.maxLifetimeSeconds'],
        [{ assertion: { skewSeconds: 301 } }, 'authn.keys.assertion.skewSeconds'],
        [{ assertion: { skewSeconds: -1 } }, 'authn.keys.assertion.skewSeconds'],
        [{ httpSignature: { maxAgeSeconds: 301 } }, 'authn.keys.httpSignature.maxAgeSeconds'],
        [{ httpSignature: { skewSeconds: 301 } }, 'authn.keys.httpSignature.skewSeconds'],
        [{ httpSignature: { requiredComponents: ['@method', ''] } }, 'authn.keys.httpSignature.requiredComponents.1'],
      ];
      for (const [keys, path] of cases) expect(await bad(keys), JSON.stringify(keys)).to.include(path);
    });

    it('accepts the limits', async () => {
      expect(await bad({ challenge: { ttlSeconds: 3600 }, assertion: { maxLifetimeSeconds: 300, skewSeconds: 300 }, httpSignature: { maxAgeSeconds: 1, skewSeconds: 0 } })).to.deep.eq([]);
    });
  });

  describe('keysOptionsOf', () => {
    it('falls back to the assertion audience for challenges, and keeps an explicit challenge audience', () => {
      const withAssertion: KeysConfig = { ...TEST_KEYS_CONFIG, assertion: { ...TEST_KEYS_CONFIG.assertion, audience: AUD } };
      expect(keysOptionsOf(withAssertion).challenge.audience).to.eq(AUD);
      expect(keysOptionsOf({ ...withAssertion, challenge: { ttlSeconds: 120, audience: 'other' } }).challenge.audience).to.eq('other');
      expect(keysOptionsOf(TEST_KEYS_CONFIG).challenge.audience).to.eq(null);
    });

    it('freezes the result and returns the same object for the same config', () => {
      const options = keysOptionsOf(TEST_KEYS_CONFIG);
      expect(Object.isFrozen(options) && Object.isFrozen(options.assertion) && Object.isFrozen(options.httpSignature.requiredComponents)).to.eq(true);
      expect(keysOptionsOf(TEST_KEYS_CONFIG)).to.eq(options);
    });
  });

  describe('through @Config', () => {
    it('DefaultKeyRegistry reads authn.keys from its container and refuses a challenge without an audience', async () => {
      const without = await parts({});
      let error: unknown;
      try {
        await without.registry.challenge({ purpose: 'login', kid: 'k' }, { now: new Date(), purpose: 'login' });
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('authn.keys.challenge.audience');
      const configured = await parts({ assertion: { audience: AUD } });
      const challenge = await configured.registry.challenge({ purpose: 'login', kid: 'k' }, { now: new Date(), purpose: 'login' });
      expect(challenge).to.be.an('object');
    });

    it('JwsAssertionStrategy and KeyChallengeStrategy fail their boot without an audience', async () => {
      const { child, registry } = await parts({});
      const assertion = readingFrom(new JwsAssertionStrategy(registry, new StrictJwsVerifier(), new MemoryKeyNonceStore()), child);
      let error: unknown;
      try {
        await assertion.resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('authn.keys.assertion.audience');
      const challenge = readingFrom(new KeyChallengeStrategy(registry, new MemorySecretStore()), child);
      error = undefined;
      try {
        await challenge.resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('authn.keys.challenge.audience');
    });

    it('the strategies boot with an audience, and HttpSignatureStrategy needs none', async () => {
      const { child, registry } = await parts({ assertion: { audience: AUD } });
      await readingFrom(new JwsAssertionStrategy(registry, new StrictJwsVerifier(), new MemoryKeyNonceStore()), child).resolve();
      await readingFrom(new KeyChallengeStrategy(registry, new MemorySecretStore()), child).resolve();
      await readingFrom(new HttpSignatureStrategy(registry, new MemoryKeyNonceStore()), child).resolve();
    });
  });
});
```

Edits to the existing tests (all build complete options through the deleted `keysOptions`):
- In `harness.ts`, `assertion.test.ts`, `challenge.test.ts`, `httpsig.test.ts`, `registry.test.ts` replace `import { keysOptions } from '../src/options/index.js';` by `import { keysOptionsFor } from './support/keys-options.js';` and every `keysOptions(` by `keysOptionsFor(`.
- `assertion.test.ts:175` and `challenge.test.ts:101` (the "cannot be built without an audience" asserts): replace `assert.throws(() => new X(...), /audience/)` by `await assert.rejects(new X(...).resolve(), /audience/)`.
- `registry.test.ts`: the `world(keysOptionsFor())` cases at 184 stay (the registry throws at `challenge()` time, as before).

- [ ] **Step 3: RED**

Run: `cd packages/authn-keys && npx ts-mocha -p tsconfig.json test/config-schema.test.ts`
Expected: FAIL to compile: `keysOptionsOf` and `KeysConfig` are not exported by `../src/options/index.js`, and `./support/keys-options.js` imports them.

- [ ] **Step 4: Implement**

1. Apply the Step 1 schema, then `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

2. `packages/authn-keys/src/options/options.ts` (whole file):

```ts
import type { KeyAlgorithm } from '@spinajs/authn/contracts';

/** `authn.keys` as the schema validates and defaults it. */
export interface KeysConfig {
  readonly algorithms: readonly KeyAlgorithm[];
  readonly challenge: { readonly ttlSeconds: number; readonly audience: string | null };
  readonly assertion: { readonly typ: string; readonly audience: string | null; readonly maxLifetimeSeconds: number; readonly skewSeconds: number };
  readonly httpSignature: { readonly maxAgeSeconds: number; readonly skewSeconds: number; readonly requiredComponents: readonly string[] };
}

/** `authn.keys` (design §22.5) after defaults. */
export interface KeysOptions {
  readonly algorithms: readonly KeyAlgorithm[];
  readonly challenge: {
    readonly ttlSeconds: number;
    /** What clients put in a challenge's signing input; default: assertion.audience. Challenges need one of them. */
    readonly audience: string | null;
  };
  readonly assertion: {
    readonly typ: string;
    /** Required once a strategy that reads assertions is listed. */
    readonly audience: string | null;
    readonly maxLifetimeSeconds: number;
    readonly skewSeconds: number;
  };
  readonly httpSignature: {
    readonly maxAgeSeconds: number;
    readonly skewSeconds: number;
    readonly requiredComponents: readonly string[];
  };
}

const derived = new WeakMap<object, KeysOptions>();

/** The options of a validated `authn.keys`: frozen, with the challenge audience falling back to the assertion audience. Cached per config object, so a reloaded configuration gives fresh options. */
export function keysOptionsOf(config: KeysConfig): KeysOptions {
  let options = derived.get(config);
  if (!options) {
    options = Object.freeze({
      algorithms: Object.freeze([...config.algorithms]),
      challenge: Object.freeze({ ttlSeconds: config.challenge.ttlSeconds, audience: config.challenge.audience ?? config.assertion.audience }),
      assertion: Object.freeze({ ...config.assertion }),
      httpSignature: Object.freeze({ ...config.httpSignature, requiredComponents: Object.freeze([...config.httpSignature.requiredComponents]) }),
    });
    derived.set(config, options);
  }
  return options;
}
```

3. `registry.ts`: imports `import { Config } from '@spinajs/configuration';` and `import { keysOptionsOf } from '../options/options.js'; import type { KeysConfig, KeysOptions } from '../options/options.js';`; the class head:

```ts
export class DefaultKeyRegistry extends KeyRegistry {
  @Config('authn.keys')
  protected KeysConfig: KeysConfig;

  private readonly stamped = new Map<string, number>();

  constructor(
    protected readonly store: KeyStore,
    protected readonly secrets: SecretStore,
    protected readonly throttle: AuthnThrottle,
    /** Read at publish time, so a sink may be added after the registry is built. */
    protected readonly sinks: readonly AuthnEventSink[],
    /** A test seam: complete options that bypass the configuration. */
    protected readonly Options?: KeysOptions,
  ) {
    super();
  }

  protected get options(): KeysOptions {
    return this.Options ?? keysOptionsOf(this.KeysConfig);
  }
```

4. `assertion.ts` (imports as above; the class body up to `verify`):

```ts
  @Config('authn.keys')
  protected KeysConfig: KeysConfig;

  constructor(protected readonly registry: KeyRegistry, protected readonly verifier: JwsVerifier, protected readonly nonces: KeyNonceStore, protected readonly Options?: KeysOptions) {
    super();
  }

  protected get options(): KeysOptions {
    return this.Options ?? keysOptionsOf(this.KeysConfig);
  }

  /** The audience the assertions name; which strategies are listed decides that one is required, so this is a boot check, not a schema rule. */
  protected get audience(): string {
    const audience = this.options.assertion.audience;
    if (audience === null) {
      throw new Error('authn.keys.assertion.audience must be set to accept JWS assertions');
    }
    return audience;
  }

  public async resolve(): Promise<void> {
    void this.audience;
    await super.resolve();
  }
```

(delete the `protected readonly options` and `protected readonly audience` fields).

5. `challenge.ts`:

```ts
  @Config('authn.keys')
  protected KeysConfig: KeysConfig;

  constructor(protected readonly registry: KeyRegistry, protected readonly secrets: SecretStore, protected readonly Options?: KeysOptions) {
    super();
  }

  protected get audience(): string {
    const audience = (this.Options ?? keysOptionsOf(this.KeysConfig)).challenge.audience;
    if (audience === null) {
      throw new Error('authn.keys.challenge.audience (or authn.keys.assertion.audience) must be set for key challenge logins');
    }
    return audience;
  }

  public async resolve(): Promise<void> {
    void this.audience;
    await super.resolve();
  }
```

6. `httpsig.ts`: `@Config('authn.keys') protected KeysConfig: KeysConfig;` the constructor `(registry, nonces, protected readonly Options?: KeysOptions) { super(); }` and `protected get options(): KeysOptions { return this.Options ?? keysOptionsOf(this.KeysConfig); }` (delete the `options` field).

7. `src/config/authn-keys.ts` lines 108-110: change the comment to `// Only the CLI scan dir. A non-empty system.dirs.migrations would replace the orm's defaults in every app (see authn-token's config); the migration and the models register through their decorators. The authn.keys defaults live in the authn schema.`

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-keys && npx ts-mocha -p tsconfig.json test/config-schema.test.ts`, then `npm test`. The fixtures that boot a root Configuration (`test/db.ts`, `k5-throttle.test.ts`'s own `configurationOf`) register `AUTHN_CONFIGURATION_SCHEMA` in the container before resolving it.
2. `cd packages/authn && npm test` (the existing `config-schema.test.ts` case at line ~103 pins `assertion` as `{ typ, audience: null, maxLifetimeSeconds: 300, skewSeconds: 30 }`, which the schema now produces; update any case that asserted `keys` has no default).
3. Rebuild authn-keys: `cd packages/authn-keys && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. No package depends on authn-keys.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn-keys/src packages/authn-keys/test
git commit -m "refactor(authn-keys): authn.keys through @Config and the schema; keysOptions and configuredKeysOptions go"
```

---

### Task 3.8: authn-http credential extractors read `authn.token.*`, `authn.keys.assertion.typ` and `authn.http.publicOrigin` from `@Config`

Row: authn-http `AuthorizationBearerExtractor`, `ApiKeyHeaderExtractor`, `HttpSignatureExtractor`.

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts` (the `http` block: add `publicOrigin`; a new `ORIGIN_PATTERN` constant above the schema)
- Modify: `packages/authn-http/src/extractors/bearer.ts` (whole file), `packages/authn-http/src/extractors/signature.ts` (whole file)
- Modify: `packages/authn-http/src/middleware/authn.ts:11`, `:16`, `:83` (the one use of `signaturePublicOrigin`; the rest of that file belongs to Task 3.9, and this step keeps it compiling)
- Test: create `packages/authn-http/test/support/config-boot.ts` (helper H) and `packages/authn-http/test/v3/extractors-config.test.ts`; edit `packages/authn-http/test/v3/authn-middleware.test.ts:870-876` and `:914`

**Interfaces:**
- Consumes: the schema defaults `authn.token.prefix` (`'spt_'`) and `authn.token.headerName` (`'x-api-key'`) from Task 3.3, and `authn.keys.assertion.typ` (`'spinajs-client+jwt'`) from Task 3.7.
- Produces: `authn.http.publicOrigin` in the authn schema (an origin: `scheme://host[:port]`, an optional trailing `/`, no path, query, credentials or wildcard); `publicOriginOf(value): string | undefined` in `extractors/signature.ts` (replaces `signaturePublicOrigin(config)`, which read the Configuration itself); the three extractors with `@Config` properties.
- Stays in code, and why: `publicOriginOf` still normalises through `parseOrigin` (case, default port, trailing slash) and throws `InvalidOption` for what a pattern cannot judge (a port above 65535, a broken IPv6 literal); the value is read per request, so a `Configuration.set` is honoured, and the normalised origin is memoised per raw value. The JWS `typ` sniff (`jwsTyp`) and every credential rule are unchanged.
- The old `typeof prefix === 'string' && prefix !== ''` and `typeof name === 'string'` guards go: the schema gives `prefix` and `headerName` `minLength: 1` and defaults.

- [ ] **Step 1: Schema additions**

Above the schema constant add (same text as in `packages/http`; `@spinajs/authn` does not depend on `@spinajs/http`):

```ts
// Scheme, host and optional port; no path, query, credentials, wildcard, backslash or space. Consumers still normalise it with
// @spinajs/http's parseOrigin, which also refuses a port above 65535 and a broken IPv6 literal.
const ORIGIN_PATTERN = '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#*@\\\\\\s]+/?$';
```

In the `http` block, inside `properties`, add before `trustProxy`:

```ts
        publicOrigin: {
          type: 'string',
          pattern: ORIGIN_PATTERN,
          description: "The origin clients put in an HTTP message signature's @target-uri (scheme://host[:port]); never taken from Host. Unset: signed requests get no principal.",
        },
```

- [ ] **Step 2: Write the failing tests**

Copy helper H to `packages/authn-http/test/support/config-boot.ts`. `packages/authn-http/test/v3/extractors-config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import type { Credentials, SignedRequest } from '@spinajs/authn/contracts';

import { ApiKeyHeaderExtractor, AuthorizationBearerExtractor } from '../../src/extractors/bearer.js';
import { HttpSignatureExtractor, publicOriginOf } from '../../src/extractors/signature.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const sreq = (headers: Record<string, string>, over: Partial<SignedRequest> = {}): SignedRequest => ({ method: 'GET', targetUri: '/x', headers, ...over });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwsOf = (typ: string) => `${b64({ alg: 'EdDSA', typ })}.${b64({ iss: 'k' })}.sig`;
const SIGNED = { signature: 'sig=:abc:', 'signature-input': 'sig=("@method");created=1' };

describe('credential extractors through @Config', () => {
  afterEach(disposeBooted);

  describe('schema', () => {
    it('gives the extractors their defaults', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.token.prefix')).to.eq('spt_');
      expect(configuration.get('authn.token.headerName')).to.eq('x-api-key');
      expect(configuration.get('authn.keys.assertion.typ')).to.eq('spinajs-client+jwt');
      expect(configuration.get('authn.http.publicOrigin')).to.eq(undefined);
    });

    it('names a publicOrigin that is not an origin', async () => {
      for (const value of ['app.example.com', 'https://app.example.com/app', 'https://user@app.example.com', 'https://*.example.com', 'https://app.example.com?x=1', '', 'null']) {
        expect(await violationsOf(SCHEMAS, { authn: { http: { publicOrigin: value } } }), JSON.stringify(value)).to.include('authn.http.publicOrigin');
      }
      for (const value of ['https://app.example.com', 'http://localhost:3000', 'HTTPS://App.Example.com:443/']) {
        expect(await violationsOf(SCHEMAS, { authn: { http: { publicOrigin: value } } }), value).to.deep.eq([]);
      }
    });

    it('names an empty prefix and header name', async () => {
      expect(await violationsOf(SCHEMAS, { authn: { token: { prefix: '' } } })).to.include('authn.token.prefix');
      expect(await violationsOf(SCHEMAS, { authn: { token: { headerName: '' } } })).to.include('authn.token.headerName');
    });
  });

  describe('AuthorizationBearerExtractor', () => {
    it('reads the default prefix and assertion typ', async () => {
      const { child } = await boot(SCHEMAS, {});
      const e = readingFrom(new AuthorizationBearerExtractor(), child);
      expect(e.extract(sreq({ authorization: 'Bearer spt_a.b.c' }))).to.deep.eq({ kind: 'bearer', token: 'spt_a.b.c' });
      const assertion = jwsOf('spinajs-client+jwt');
      expect(e.extract(sreq({ authorization: `Bearer ${assertion}` }))).to.deep.eq({ kind: 'jws-assertion', jws: assertion });
      expect(e.extract(sreq({ authorization: 'Bearer opaque' }))).to.eq(null);
    });

    it('honours a configured prefix and typ', async () => {
      const { child } = await boot(SCHEMAS, { authn: { token: { prefix: 'tok_' }, keys: { assertion: { typ: 'custom+jwt' } } } });
      const e = readingFrom(new AuthorizationBearerExtractor(), child);
      expect(e.extract(sreq({ authorization: 'Bearer tok_x' }))).to.deep.eq({ kind: 'bearer', token: 'tok_x' });
      expect(e.extract(sreq({ authorization: 'Bearer spt_x' }))).to.eq(null);
      expect(e.extract(sreq({ authorization: `Bearer ${jwsOf('custom+jwt')}` }))?.kind).to.eq('jws-assertion');
      expect(e.extract(sreq({ authorization: `Bearer ${jwsOf('spinajs-client+jwt')}` }))?.kind).to.eq('bearer');
    });

    it('reads the prefix at call time', async () => {
      const { child, configuration } = await boot(SCHEMAS, {});
      const e = readingFrom(new AuthorizationBearerExtractor(), child);
      configuration.set('authn.token.prefix', 'new_');
      expect(e.extract(sreq({ authorization: 'Bearer new_k' }))).to.deep.eq({ kind: 'bearer', token: 'new_k' });
    });
  });

  describe('ApiKeyHeaderExtractor', () => {
    it('reads the default header and prefix, and a configured header name', async () => {
      const def = readingFrom(new ApiKeyHeaderExtractor(), (await boot(SCHEMAS, {})).child);
      expect(def.extract(sreq({ 'x-api-key': 'spt_k' }))).to.deep.eq({ kind: 'bearer', token: 'spt_k' });
      expect(def.extract(sreq({ 'x-api-key': 'other_k' }))).to.eq(null);
      const named = readingFrom(new ApiKeyHeaderExtractor(), (await boot(SCHEMAS, { authn: { token: { headerName: 'X-Token' } } })).child);
      expect(named.extract(sreq({ 'x-token': 'spt_k' }))).to.deep.eq({ kind: 'bearer', token: 'spt_k' });
      expect(named.extract(sreq({ 'x-api-key': 'spt_k' }))).to.eq(null);
    });
  });

  describe('HttpSignatureExtractor', () => {
    const request = (e: HttpSignatureExtractor): Credentials | null => e.extract(sreq(SIGNED));

    it('prefixes the signed target with the normalised public origin', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { publicOrigin: 'HTTPS://App.Example.com:443/' } } });
      expect(request(readingFrom(new HttpSignatureExtractor(), child))).to.deep.include({ kind: 'http-signature' });
      expect((request(readingFrom(new HttpSignatureExtractor(), child)) as { request: { targetUri: string } }).request.targetUri).to.eq('https://app.example.com/x');
    });

    it('gives nothing without a public origin, and honours a later set', async () => {
      const { child, configuration } = await boot(SCHEMAS, {});
      const e = readingFrom(new HttpSignatureExtractor(), child);
      expect(request(e)).to.eq(null);
      configuration.set('authn.http.publicOrigin', 'https://later.example.com');
      expect((request(e) as { request: { targetUri: string } }).request.targetUri).to.eq('https://later.example.com/x');
    });

    it('still refuses an origin the pattern cannot judge', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { publicOrigin: 'https://app.example.com:99999' } } });
      expect(() => request(readingFrom(new HttpSignatureExtractor(), child))).to.throw(InvalidOption, 'authn.http.publicOrigin');
      expect(publicOriginOf(undefined)).to.eq(undefined);
      expect(publicOriginOf(null)).to.eq(undefined);
      expect(publicOriginOf('https://a.example.com/')).to.eq('https://a.example.com');
    });
  });
});
```

Edit `packages/authn-http/test/v3/authn-middleware.test.ts`: add `import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration';` and `import { fakeContainer } from '../support/config-boot.js';`; replace the `extractor` helper (lines 870-876) by

```ts
    // The schema defaults, which a stand-in container does not apply; extractors-config.test.ts pins them to the schema.
    const EXTRACTOR_DEFAULTS = { 'authn.token.prefix': 'spt_', 'authn.token.headerName': 'x-api-key', 'authn.keys.assertion.typ': 'spinajs-client+jwt' };
    const extractor = <T extends object>(E: new () => T, values: Record<string, unknown> = {}) => {
      const e = new E();
      Object.defineProperty(e, CONFIGURATION_CONTAINER_KEY, { value: fakeContainer({ ...EXTRACTOR_DEFAULTS, ...values }) });
      return e as T & { extract(r: SignedRequest): Credentials | null };
    };
```

and delete line 914 (`expect(extractor(ApiKeyHeaderExtractor, { 'authn.token.prefix': '' })...`: an empty prefix is a schema violation now, asserted above).

- [ ] **Step 3: RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/extractors-config.test.ts`
Expected: FAIL. `publicOriginOf` is not exported (compile error), and once stubbed the extractors throw `Cannot read properties of undefined (reading 'get')` because they use `@Autoinject(Configuration)`, which a `new` instance does not have.

- [ ] **Step 4: Implement**

1. Add the Step 1 schema lines, then `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

2. `packages/authn-http/src/extractors/bearer.ts`:

```ts
import { PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { CredentialExtractor } from '@spinajs/authn/contracts';
import type { Credentials, SignedRequest } from '@spinajs/authn/contracts';

// RFC 6750 b64token. A header sent twice reaches the extractors joined with ", ", which never matches.
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;
const MALFORMED_BEARER = /^Bearer +(.+)$/is;

function jwsTyp(header: string): unknown {
  try {
    return (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { typ?: unknown } | null)?.typ;
  } catch {
    return undefined;
  }
}

/**
 * `Authorization: Bearer <value>` (scheme in any case): an `authn.token.prefix` token ⇒ bearer; a three-part value ⇒
 * jws-assertion when its JWS header `typ` is `authn.keys.assertion.typ`, else bearer (a JWT). Any other value is
 * someone else's token (a telemetry service token, say) and gives no credentials, so no strategy runs and no failure
 * counts. A malformed or repeated header ⇒ null, unless its value starts with the token prefix: that is a bad credential
 * of ours, a bearer that fails, so resolution stops there and never falls through to `x-api-key`.
 */
@PerChildInstance()
export class AuthorizationBearerExtractor extends CredentialExtractor {
  public readonly order: number = 20;

  @Config('authn.token.prefix')
  protected Prefix: string;

  @Config('authn.keys.assertion.typ')
  protected AssertionTyp: string;

  public extract(req: SignedRequest): Credentials | null {
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : undefined;
    if (header === undefined) return null;
    const ours = (value: string) => value.startsWith(this.Prefix);

    const token = BEARER.exec(header)?.[1];
    if (token === undefined) {
      const value = MALFORMED_BEARER.exec(header)?.[1];
      return value !== undefined && ours(value) ? { kind: 'bearer', token: value } : null;
    }
    if (ours(token)) return { kind: 'bearer', token };

    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => p === '')) return null;
    return jwsTyp(parts[0]) === this.AssertionTyp ? { kind: 'jws-assertion', jws: token } : { kind: 'bearer', token };
  }
}

/**
 * The `authn.token.headerName` header (default `x-api-key`) ⇒ bearer, only for an `authn.token.prefix` token: the header
 * name is common, so any other value is someone else's key and gives no credentials. A malformed or repeated value ⇒
 * null. An opaque `Authorization` bearer gives null first, so a prefix token here still authenticates, as in 2.x.
 */
@PerChildInstance()
export class ApiKeyHeaderExtractor extends CredentialExtractor {
  public readonly order: number = 30;

  @Config('authn.token.headerName')
  protected HeaderName: string;

  @Config('authn.token.prefix')
  protected Prefix: string;

  public extract(req: SignedRequest): Credentials | null {
    const value = req.headers[this.HeaderName.toLowerCase()];
    const token = typeof value === 'string' ? value.trim() : '';
    return TOKEN.test(token) && token.startsWith(this.Prefix) ? { kind: 'bearer', token } : null;
  }
}
```

3. `packages/authn-http/src/extractors/signature.ts`:

```ts
import { PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { parseOrigin } from '@spinajs/http';
import { CredentialExtractor } from '@spinajs/authn/contracts';
import type { Credentials, SignedRequest } from '@spinajs/authn/contracts';

/**
 * `authn.http.publicOrigin` normalised to an origin: the one clients put in a signature's `@target-uri`, never taken from
 * Host. undefined when unset. The schema judges the shape; `parseOrigin` still refuses a port above 65535 or a broken IPv6
 * literal, which a pattern cannot.
 */
export function publicOriginOf(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const origin = parseOrigin(value);
  if (origin === undefined) throw new InvalidOption(`authn.http.publicOrigin must be an origin (scheme://host[:port]); got ${JSON.stringify(value)}`);
  return origin;
}

/**
 * `signature` + `signature-input` headers ⇒ http-signature. `req.targetUri` is the origin-form target (path and
 * query); the credential's target is `authn.http.publicOrigin` plus that path. null without the setting, and for any
 * other target form (absolute-form, `*`), which no client signs.
 */
@PerChildInstance()
export class HttpSignatureExtractor extends CredentialExtractor {
  public readonly order: number = 10;

  @Config('authn.http.publicOrigin')
  protected PublicOrigin: string | null | undefined;

  private memo: { readonly raw: string | null | undefined; readonly origin: string | undefined } | undefined;

  protected get origin(): string | undefined {
    const raw = this.PublicOrigin;
    if (this.memo === undefined || this.memo.raw !== raw) this.memo = { raw, origin: publicOriginOf(raw) };
    return this.memo.origin;
  }

  public extract(req: SignedRequest): Credentials | null {
    if (typeof req.headers.signature !== 'string' || typeof req.headers['signature-input'] !== 'string' || !req.targetUri.startsWith('/')) return null;
    const origin = this.origin;
    if (origin === undefined) return null;
    return { kind: 'http-signature', request: { method: req.method, targetUri: `${origin}${req.targetUri}`, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) } };
  }
}
```

4. `packages/authn-http/src/middleware/authn.ts`: line 16 `import { publicOriginOf } from '../extractors/signature.js';` and line 83 `if (publicOriginOf(this.Configuration.get<string | null | undefined>('authn.http.publicOrigin')) === undefined) {` (Task 3.9 replaces this read with `@Config`).

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/extractors-config.test.ts test/v3/authn-middleware.test.ts`, then `npm test` (it runs the default suite and the `v3-app` one; the root-booting fixtures `test/token-common.ts` and `test/v3-app/app.ts` register `AUTHN_CONFIGURATION_SCHEMA` before they resolve the Configuration).
2. `cd packages/authn && npm test` (the `http.publicOrigin` addition; add the origin cases to `test/contracts/config-schema.test.ts` only if it enumerates the `http` block keys).
3. Rebuild authn-http: `cd packages/authn-http && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Dependants, sequentially: `for p in authn-oidc users-http; do (cd packages/$p && npm test) || break; done` (neither imports `signaturePublicOrigin`, the one exported name this task removes).

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn-http/src/extractors packages/authn-http/src/middleware/authn.ts packages/authn-http/test
git commit -m "refactor(authn-http): the credential extractors read authn.token, assertion typ and publicOrigin through @Config and the schema"
```

---

### Task 3.9: `AuthnMiddleware`, `ClientIp` and `CsrfOriginGuard` read their keys from `@Config`; one shared trust parser

Row: authn-http `AuthnMiddleware`, `ClientIp`, `CsrfOriginGuard`.

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts` (the `session.cookie` and `http` blocks)
- Modify: `packages/authn-http/src/middleware/client-ip.ts` (whole file), `packages/authn-http/src/middleware/csrf.ts:1-47`, `:98-125`, `packages/authn-http/src/middleware/authn.ts:1-12`, `:55-92`, `packages/authn-http/src/index.ts` (one export)
- Test: create `packages/authn-http/test/v3/http-config.test.ts`; edit `test/v3/client-ip.test.ts:53-57`, `test/v3/csrf-origin-guard.test.ts:96-100` and `:276-295`, `test/v3/authn-middleware.test.ts:715-732` and `:873`, `test/v3/sr16-cookie-pin.test.ts`

**Interfaces:**
- Consumes: `HTTP_CONFIGURATION_SCHEMA` (Task 3.1; `http.trustProxy`, `http.cookie.secret`), the authn `http`, `session.cookie` schema blocks.
- Produces: schema defaults `authn.http.csrf { enabled: true, allowedOrigins: [] }` (as `{ enum: [true, false] }`, see below), `authn.http.trustProxy` unchanged, `authn.session.cookie { name: 'ssid', hostPrefix: 'auto', secure: 'auto', sameSite: 'strict' }`; `proxyTrustOf(own, shared): ProxyTrust` (exported from `@spinajs/authn-http`, replacing the internal `authnProxyTrust(config)`; authn-oidc reuses it in Task 3.11); `ClientIp`, `CsrfOriginGuard`, `AuthnMiddleware` with `@Config` properties.
- The shared parser: `proxyTrustOf` only chooses between the two settings (`authn.http.trustProxy`, else `http.trustProxy` when the former is null or absent); the compile step stays `parseTrustProxy` of `@spinajs/http` (CIDR arithmetic into a `BlockList`, which a schema cannot do). Origin lists keep `parseOrigin` for normalisation.
- Stays in code, and why: (a) the compile of trust settings and the origin normalisation (above); (b) `appEnvOf(this.Configuration)` in `AuthnMiddleware.resolve()`: the SR-16 "no env named" rule reads the Configuration's `Env`, so `@Autoinject(Configuration)` stays for that single call, and `@Config` does not apply to it; (c) `assertSessionCookieSecret` (Task 3.2): secret presence and the env-dependent "public default" refusal; (d) the `authn.http.publicOrigin` and `PUBLIC_DEFAULT_COOKIE_SECRET` warnings, which are advisories.
- Why `csrf.enabled` is `{ enum: [true, false] }` and not `type: 'boolean'`: `coerceTypes` turns `null` (and `0`, `''`) into `false` for a boolean, which would switch the CSRF guard OFF for a value that used to mean "default on". An `enum` is not coerced, so `null` or `'false'` fails the boot, exactly as the old `typeof enabled !== 'boolean'` check threw.

- [ ] **Step 1: Schema additions**

In the `session.cookie` block add `default: {}` to `cookie` and the three defaults (the shipped authn-session config has the same four values):

```ts
        cookie: {
          type: 'object',
          default: {},
          description: "'auto': on unless the env is development or test.",
          properties: {
            name: { type: 'string', minLength: 1, default: 'ssid' },
            // No `type`, so nothing is coerced: with coerceTypes a null would become false. String booleans (env values) are kept as given.
            hostPrefix: { enum: [true, false, 'auto', 'true', 'false'], default: 'auto' },
            secure: { enum: [true, false, 'auto', 'true', 'false'], default: 'auto' },
            // What the 2.x cookie builder and express accept: booleans and any letter case.
            sameSite: { anyOf: [{ enum: [true, false] }, { type: 'string', pattern: '^([Ss][Tt][Rr][Ii][Cc][Tt]|[Ll][Aa][Xx]|[Nn][Oo][Nn][Ee])$' }], default: 'strict' },
          },
        },
```

In the `http` block add `default: {}` to `http` itself, make `csrf` default and tighten it, and leave `trustProxy`, `publicOrigin` and `routes` as they are:

```ts
        csrf: {
          type: 'object',
          default: {},
          properties: {
            // Not `type: 'boolean'`: coerceTypes would turn a null into false and switch the guard off.
            enabled: { enum: [true, false], default: true },
            allowedOrigins: { type: 'array', default: [], items: { type: 'string', pattern: ORIGIN_PATTERN }, description: 'Besides the same origin, which is always allowed.' },
          },
        },
```

- [ ] **Step 2: Write the failing tests**

`packages/authn-http/test/v3/http-config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { HTTP_CONFIGURATION_SCHEMA } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { PUBLIC_DEFAULT_COOKIE_SECRET } from '@spinajs/authn-session';

import { ClientIp, CsrfOriginGuard, AuthnMiddleware, proxyTrustOf } from '../../src/index.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];
const STRONG = 'unit-' + 'Zx8q'.repeat(10);
const bad = (values: Record<string, unknown>) => violationsOf(SCHEMAS, values);

const reqFrom = (peer: string, headers: Record<string, string> = {}, method = 'GET') => ({ method, headers, socket: { remoteAddress: peer }, storage: {} as Record<string, unknown> }) as never;

function run(handler: (req: never, res: never, next: () => void) => void, req: never): { passed: boolean; status?: number } {
  let passed = false;
  const res = { statusCode: 0, status(code: number) { this.statusCode = code; return this; }, json() { return this; } };
  handler(req, res as never, () => { passed = true; });
  return { passed, status: res.statusCode || undefined };
}

describe('authn http middlewares through @Config and the schemas', () => {
  afterEach(disposeBooted);

  describe('schema', () => {
    it('fills the csrf and session cookie defaults', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.http.csrf')).to.deep.eq({ enabled: true, allowedOrigins: [] });
      expect(configuration.get('authn.session.cookie')).to.deep.include({ name: 'ssid', hostPrefix: 'auto', secure: 'auto', sameSite: 'strict' });
    });

    it('names the bad csrf, trust and secret key', async () => {
      expect(await bad({ authn: { http: { csrf: { enabled: null } } } })).to.include('authn.http.csrf.enabled');
      expect(await bad({ authn: { http: { csrf: { enabled: 'false' } } } })).to.include('authn.http.csrf.enabled');
      expect(await bad({ authn: { http: { csrf: { allowedOrigins: ['https://ok.example.org', 'partner.example.org'] } } } })).to.include('authn.http.csrf.allowedOrigins.1');
      expect(await bad({ authn: { http: { csrf: { allowedOrigins: 'https://ok.example.org' } } } })).to.include('authn.http.csrf.allowedOrigins');
      expect(await bad({ authn: { http: { trustProxy: -1 } } })).to.include('authn.http.trustProxy');
      expect(await bad({ http: { cookie: { secret: '' } } })).to.include('http.cookie.secret');
    });

    it('accepts csrf off', async () => {
      expect(await bad({ authn: { http: { csrf: { enabled: false } } } })).to.deep.eq([]);
    });
  });

  describe('proxyTrustOf', () => {
    it('takes authn.http.trustProxy, else http.trustProxy when the former is null or absent', () => {
      expect(proxyTrustOf(2, 5)).to.deep.eq({ hops: 2 });
      expect(proxyTrustOf(null, 3)).to.deep.eq({ hops: 3 });
      expect(proxyTrustOf(undefined, undefined)).to.deep.eq({ hops: 0 });
      expect(proxyTrustOf(0, 3)).to.deep.eq({ hops: 0 });
    });

    it('names the key whose setting does not compile', () => {
      expect(() => proxyTrustOf(['10.0.0.0/33'], null)).to.throw(InvalidOption, 'authn.http.trustProxy');
      expect(() => proxyTrustOf(null, ['nope'])).to.throw(InvalidOption, 'http.trustProxy');
    });
  });

  describe('ClientIp', () => {
    it('takes the client behind the trusted proxies of its container\'s configuration', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { trustProxy: ['10.0.0.0/8'] } } });
      const handler = readingFrom(new ClientIp(), child).before()!;
      const req = reqFrom('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' });
      handler(req, {} as never, () => undefined);
      expect((req as { storage: { ClientIp?: string } }).storage.ClientIp).to.eq('203.0.113.7');
    });

    it('falls back to http.trustProxy and reads the socket address with neither', async () => {
      const shared = readingFrom(new ClientIp(), (await boot(SCHEMAS, { http: { trustProxy: 1 } })).child).before()!;
      const a = reqFrom('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' });
      shared(a, {} as never, () => undefined);
      expect((a as { storage: { ClientIp?: string } }).storage.ClientIp).to.eq('203.0.113.7');
      const none = readingFrom(new ClientIp(), (await boot(SCHEMAS, {})).child).before()!;
      const b = reqFrom('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' });
      none(b, {} as never, () => undefined);
      expect((b as { storage: { ClientIp?: string } }).storage.ClientIp).to.eq('10.0.0.5');
    });

    it('still refuses a CIDR the schema cannot judge when the middleware is built', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { trustProxy: ['10.0.0.0/33'] } } });
      expect(() => readingFrom(new ClientIp(), child).before()).to.throw(InvalidOption, 'authn.http.trustProxy');
    });
  });

  describe('CsrfOriginGuard', () => {
    const cookieHeaders = (origin: string) => ({ cookie: 'ssid=x', origin, host: 'app.example.org' });
    const guardOf = (child: Parameters<typeof readingFrom>[1]) => {
      const guard = readingFrom(new CsrfOriginGuard(), child);
      Object.defineProperty(guard, 'Log', { value: { warn: () => undefined } });
      return guard;
    };

    it('refuses a cross-origin unsafe request carrying the session cookie, passes a listed and the own origin', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { csrf: { allowedOrigins: ['HTTPS://Partner.Example.Org:443/'] } } } });
      const handler = guardOf(child).before()!;
      expect(run(handler, reqFrom('10.0.0.5', cookieHeaders('https://evil.example.org'), 'POST')), 'foreign').to.deep.eq({ passed: false, status: 403 });
      expect(run(handler, reqFrom('10.0.0.5', cookieHeaders('https://partner.example.org'), 'POST')).passed, 'listed, normalised').to.eq(true);
      expect(run(handler, reqFrom('10.0.0.5', cookieHeaders('http://app.example.org'), 'POST')).passed, 'own').to.eq(true);
    });

    it('is off only for enabled: false, and takes the session cookie name from authn.session.cookie', async () => {
      expect(guardOf((await boot(SCHEMAS, { authn: { http: { csrf: { enabled: false } } } })).child).before()).to.eq(null);
      const { child } = await boot(SCHEMAS, { authn: { session: { cookie: { name: 'sid2' } } } });
      const handler = guardOf(child).before()!;
      expect(run(handler, reqFrom('10.0.0.5', { cookie: 'ssid=x', origin: 'https://evil.example.org', host: 'app.example.org' }, 'POST')).passed, 'another cookie').to.eq(true);
      expect(run(handler, reqFrom('10.0.0.5', { cookie: 'sid2=x', origin: 'https://evil.example.org', host: 'app.example.org' }, 'POST')).passed).to.eq(false);
    });

    it('still refuses an allowed origin the pattern cannot judge, naming the key', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { csrf: { allowedOrigins: ['https://partner.example.org:99999'] } } } });
      expect(() => guardOf(child).before()).to.throw(InvalidOption, 'authn.http.csrf.allowedOrigins');
    });
  });

  describe('AuthnMiddleware boot', () => {
    const middleware = async (values: Record<string, unknown>, env: string) => {
      const { child, configuration } = await boot(SCHEMAS, values, env);
      const mw = readingFrom(new AuthnMiddleware(), child) as unknown as Record<string, unknown>;
      const warnings: string[] = [];
      Object.defineProperty(mw, 'Configuration', { value: configuration });
      Object.defineProperty(mw, 'Log', { value: { warn: (m: string) => warnings.push(m) } as unknown as Log });
      Object.defineProperty(mw, 'Container', { value: { resolve: async (t: unknown) => ((t as { Type?: unknown }).Type ? [] : { restore: async () => null }) } });
      return { mw: mw as unknown as AuthnMiddleware, warnings };
    };

    it('refuses the public default secret outside development and test, and a missing secret anywhere', async () => {
      await middleware({ http: { cookie: { secret: STRONG } } }, 'production').then(({ mw }) => mw.resolve());
      let error: unknown;
      try {
        await (await middleware({ http: { cookie: { secret: PUBLIC_DEFAULT_COOKIE_SECRET } } }, 'production')).mw.resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('public default');
      error = undefined;
      try {
        await (await middleware({}, 'test')).mw.resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('http.cookie.secret is not set');
    });

    it('warns about the public secret in test and about a missing publicOrigin', async () => {
      const { mw, warnings } = await middleware({ http: { cookie: { secret: PUBLIC_DEFAULT_COOKIE_SECRET } } }, 'test');
      await mw.resolve();
      expect(warnings.join('\n')).to.contain('public default').and.to.contain('authn.http.publicOrigin is not set');
      const set = await middleware({ http: { cookie: { secret: STRONG } }, authn: { http: { publicOrigin: 'https://app.example.org' } } }, 'test');
      await set.mw.resolve();
      expect(set.warnings).to.deep.eq([]);
    });

    it('takes the cookie name from authn.session.cookie and the env flags from the app env', async () => {
      const prod = await middleware({ http: { cookie: { secret: STRONG } } }, 'production');
      await prod.mw.resolve();
      expect((prod.mw as unknown as { CookieName: string }).CookieName).to.eq('__Host-ssid');
      const dev = await middleware({ http: { cookie: { secret: STRONG } }, authn: { session: { cookie: { name: 'sid2' } } } }, 'test');
      await dev.mw.resolve();
      expect((dev.mw as unknown as { CookieName: string }).CookieName).to.eq('sid2');
    });
  });
});
```

Edits to existing tests, which fake the Configuration through a `Configuration` property on the instance:
- `client-ip.test.ts:53-57` (`unitClientIp`) and `csrf-origin-guard.test.ts:96-100` (`unitGuard`): replace `Object.defineProperty(mw, 'Configuration', { value: { get: ... } })` by `Object.defineProperty(mw, CONFIGURATION_CONTAINER_KEY, { value: fakeContainer({ ...BASE, ...values }) })` with `import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration'; import { fakeContainer } from '../support/config-boot.js';` and `BASE = { 'authn.http.csrf.enabled': true, 'authn.http.csrf.allowedOrigins': [], 'authn.session.cookie': { name: 'ssid' }, 'authn.http.trustProxy': null, 'http.trustProxy': null }` (the schema defaults, pinned by the new test); in `csrf-origin-guard.test.ts` lines 276-295 delete the `bad allowedOrigins entry` and `enabled` shape cases that now come from the schema (keep the normalisation case and add the port-99999 one shown above).
- `authn-middleware.test.ts` `unit()` (lines 715-732) and the second use at line 873: besides `Object.defineProperty(mw, 'Configuration', { value: config(values) })` (still read by `appEnvOf`), add `Object.defineProperty(mw, CONFIGURATION_CONTAINER_KEY, { value: fakeContainer({ 'authn.session.cookie': { name: 'ssid' }, ...values }) })`.
- Fixtures that boot the ROOT Configuration (`test/token-common.ts`, `test/v3-app/app.ts`, `test/v3-app/behaviour/harness.ts`) register `AUTHN_CONFIGURATION_SCHEMA` and `HTTP_CONFIGURATION_SCHEMA` before they resolve it (`DI.register(...).asValue('__configurationSchema__')`); `test/v3-app/behaviour/harness.ts:430` builds `secret: null` for its "missing" case: the boot now fails with `InvalidConfiguration` naming `http.cookie.secret` instead of `InvalidOption`; adjust the expectation in that harness to match either type.

- [ ] **Step 3: RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/http-config.test.ts`
Expected: FAIL: `proxyTrustOf` is not exported (compile error); with a stub, the middlewares throw `Cannot read properties of undefined (reading 'get')` on their `@Autoinject(Configuration)` property, and `csrf.enabled: null` is not refused by the current schema (`type: 'boolean'` coerces it).

- [ ] **Step 4: Implement**

1. Apply Step 1, then `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

2. `packages/authn-http/src/middleware/client-ip.ts` (whole file):

```ts
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { ServerMiddleware, parseTrustProxy, trustedClientAddress } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';
import type * as express from 'express';

/**
 * authn.http.trustProxy, else http.trustProxy (only when the former is null or absent). The schemas judge the types;
 * `parseTrustProxy` compiles the setting and throws, naming the key, for an entry that is no address or CIDR.
 */
export function proxyTrustOf(own: unknown, shared: unknown): ProxyTrust {
  return own === null || own === undefined ? parseTrustProxy(shared, 'http.trustProxy') : parseTrustProxy(own, 'authn.http.trustProxy');
}

/**
 * Order 1. Writes req.storage.ClientIp: the socket address, or the client address behind trusted proxy hops only
 * (authn.http.trustProxy, else http.trustProxy; none ⇒ the socket address) (A05).
 */
@Injectable(ServerMiddleware)
export class ClientIp extends ServerMiddleware {
  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  constructor() {
    super();
    this.Order = 1;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    const trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      req.storage.ClientIp = trustedClientAddress(req.socket?.remoteAddress, req.headers['x-forwarded-for'], trust);
      next();
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }
}
```

and in `index.ts` change `export { ClientIp } from './middleware/client-ip.js';` to `export { ClientIp, proxyTrustOf } from './middleware/client-ip.js';`.

3. `csrf.ts`: imports (lines 1-11) lose `Autoinject`, `Configuration`, `SESSION_COOKIE_BASE_NAME` and gain `Config`; replace lines 25-47 (`allowedOrigins` and `isEnabled`) by:

```ts
/** The schema judges the shape of each entry; `parseOrigin` normalises it and still refuses what a pattern cannot (a port above 65535). */
function normalisedOrigins(list: readonly string[]): ReadonlySet<string> {
  return new Set(
    list.map((entry) => {
      const origin = parseOrigin(entry);
      if (origin === undefined) throw new InvalidOption(`${ALLOWED_ORIGINS_KEY} entry ${JSON.stringify(entry)} is not an origin (scheme://host[:port])`);
      return origin;
    }),
  );
}
```

and the class head and `before()` prologue (lines 98-125):

```ts
@Injectable(ServerMiddleware)
export class CsrfOriginGuard extends ServerMiddleware {
  @Config('authn.http.csrf.enabled')
  protected Enabled: boolean;

  @Config('authn.http.csrf.allowedOrigins')
  protected AllowedOrigins: string[];

  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  @Config('authn.session.cookie')
  protected SessionCookie: ISessionCookieConfig;

  @Logger('authn-http')
  protected Log!: Log;

  constructor() {
    super();
    this.Order = 4;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    // Built before the enabled check, so a bad setting fails the boot even while the guard is off.
    const allowed = normalisedOrigins(this.AllowedOrigins);
    const trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    if (!this.Enabled) return null;

    // Until AuthnMiddleware replaces the 2.x session code, that code and authn-session can disagree on the
    // __Host- prefix, so both forms count as the session cookie.
    const base = this.SessionCookie.name as string;
    const sessionCookies = [base, `__Host-${base}`];
    const warnings = new RefusalWarnings(() => this.Log);
```

(the returned handler and `after()` are unchanged; `import { proxyTrustOf } from './client-ip.js';` replaces the `authnProxyTrust` import).

4. `authn.ts` imports (lines 1-12): drop `Autoinject` only if no longer used (the `@Autoinject(Configuration)` and `@Autoinject(Container)` stay); add `import { Config } from '@spinajs/configuration';` next to the `Configuration` import. Class members and `resolve()`:

```ts
  // Stays an injected Configuration: appEnvOf reads its Env for the SR-16 "no env named" rule, which @Config cannot express.
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Config('http.cookie.secret')
  protected ConfiguredCookieSecret: string;

  @Config('authn.session.cookie')
  protected SessionCookie: ISessionCookieConfig;

  @Config('authn.http.publicOrigin')
  protected PublicOrigin: string | null | undefined;
```

```ts
  public async resolve(): Promise<void> {
    const env = appEnvOf(this.Configuration);
    const secret = this.ConfiguredCookieSecret;
    assertSessionCookieSecret(secret, env);
    if (secret === PUBLIC_DEFAULT_COOKIE_SECRET) {
      this.Log.warn('http.cookie.secret is the public default shipped with @spinajs/http; session cookies can be forged. Set a secret of your own');
    }
    if (publicOriginOf(this.PublicOrigin) === undefined) {
      this.Log.warn('authn.http.publicOrigin is not set: requests signed with HTTP message signatures get no principal');
    }
    this.CookieSecret = secret;
    this.CookieName = sessionCookieName(this.SessionCookie, env);
    this.Sessions = await this.Container.resolve(SessionIssuer);
    this.Extractors = [...(await this.Container.resolve(Array.ofType(CredentialExtractor)))].sort(byOrder);
    this.Resolvers = [...(await this.Container.resolve(Array.ofType(AuthnPrincipalResolver)))].sort(byOrder);
    await super.resolve();
  }
```

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/http-config.test.ts test/v3/client-ip.test.ts test/v3/csrf-origin-guard.test.ts test/v3/authn-middleware.test.ts test/v3/sr16-cookie-pin.test.ts`, then `npm test`.
2. `cd packages/authn && npm test` (if `test/contracts/config-schema.test.ts` asserts `csrf.enabled: 'yes'` is refused it still is; if it asserts a null `enabled` is accepted, change it to refused).
3. Rebuild authn-http: `cd packages/authn-http && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `for p in authn-oidc users-http; do (cd packages/$p && npm test) || break; done` (authn-oidc still has its own `trustedPeer` until Task 3.11).

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn-http/src packages/authn-http/test
git commit -m "refactor(authn-http): AuthnMiddleware, ClientIp and CsrfOriginGuard through @Config and the schemas; one trust chooser"
```

---

### Task 3.10: authn-http reads `authn.mfa.policy.service` from `@Config`; the `?? 'DefaultMfaPolicy'` fallbacks go

Row: authn-http `MfaSatisfied`, `pendingSteps`, `mfaPolicyOf`.

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts` (the `mfa.policy` block, only if Phase 2 has not given `service` its default)
- Modify: `packages/authn-http/src/policies/v3/mfa.ts:1-42`, `packages/authn-http/src/v3/routes.ts:2`, `:105-112`, `packages/authn-http/src/v3/controllers/AuthnLoginController.ts:1-3`, `:30-33`, `:93`, `packages/authn-http/src/v3/controllers/AuthnMfaController.ts` (imports, one `@Config` field, line ~55)
- Test: create `packages/authn-http/test/v3/mfa-policy-config.test.ts`

**Interfaces:**
- Consumes: the schema default `authn.mfa.policy.service` = `'DefaultMfaPolicy'` (Phase 2's `mfa.policy.service` row; the shipped `authn` config already ships the same value).
- Produces: `mfaPolicyOf(container, name: string)`, `pendingSteps(container, session, policyService: string)`, `MfaSatisfied.PolicyService`.
- `@Config` cannot apply to `mfaPolicyOf` and `pendingSteps`: they are plain functions that take a container. Chosen alternative: the two controllers that call `pendingSteps` get their own `@Config('authn.mfa.policy.service')` property and pass it in; `MfaSatisfied` is a class and gets the property itself.
- Stays in code, and why: the lookup of the registered `MfaPolicy` by name and the `required()` duck-type check (DI lookups, with their own `InvalidOption` messages).

- [ ] **Step 1: Schema additions**

Skip when `mfa.policy` already reads `default: {}` and `service` already has `default: 'DefaultMfaPolicy'`. Otherwise in the `mfa.policy` block:

```ts
        policy: {
          type: 'object',
          default: {},
          properties: {
            service: { type: 'string', minLength: 1, default: 'DefaultMfaPolicy' },
            force: { type: 'boolean', description: "Requires a step on logins whose strategy reports method 'password' only (D13): key and OIDC logins get none." },
            forceForRoles: stringList,
          },
        },
```

- [ ] **Step 2: Write the failing tests**

`packages/authn-http/test/v3/mfa-policy-config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { MfaPolicy } from '@spinajs/authn/contracts';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { SESSION_PENDING_STEPS_KEY } from '@spinajs/authn-session';

import { MfaSatisfied, mfaPolicyOf } from '../../src/policies/v3/mfa.js';
import { pendingSteps } from '../../src/v3/routes.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];

const policy = { required: async () => ['totp'] };
const named = { CustomPolicy: () => policy }.CustomPolicy;

const session = (stored?: unknown) => ({ data: new Map([[SESSION_PENDING_STEPS_KEY, stored]]), identity: { type: 'user', id: 'u1' }, facts: { method: 'password', strategy: 'local' } }) as never;

describe('authn.mfa.policy.service through @Config', () => {
  afterEach(disposeBooted);

  it('defaults to DefaultMfaPolicy and names an empty service', async () => {
    const { configuration } = await boot(SCHEMAS, {});
    expect(configuration.get('authn.mfa.policy.service')).to.eq('DefaultMfaPolicy');
    expect(await violationsOf(SCHEMAS, { authn: { mfa: { policy: { service: '' } } } })).to.include('authn.mfa.policy.service');
  });

  it('MfaSatisfied reads the configured name from its container', async () => {
    const { child } = await boot(SCHEMAS, { authn: { mfa: { policy: { service: 'CustomPolicy' } } } });
    expect((readingFrom(new MfaSatisfied(), child) as unknown as { PolicyService: string }).PolicyService).to.eq('CustomPolicy');
    const { child: other } = await boot(SCHEMAS, {});
    expect((readingFrom(new MfaSatisfied(), other) as unknown as { PolicyService: string }).PolicyService).to.eq('DefaultMfaPolicy');
  });

  it('mfaPolicyOf finds the registration by the name it is given, with no fallback of its own', async () => {
    const { child } = await boot(SCHEMAS, {});
    child.register(named).as(MfaPolicy as never);
    expect(await mfaPolicyOf(child, 'CustomPolicy')).to.eq(policy);
    let error: unknown;
    try {
      await mfaPolicyOf(child, 'Missing');
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidOption);
    expect(String(error)).to.contain('no MfaPolicy is registered');
  });

  it('pendingSteps asks the named policy unless the session stored its steps', async () => {
    const { child } = await boot(SCHEMAS, {});
    child.register(named).as(MfaPolicy as never);
    expect(await pendingSteps(child, session(undefined), 'CustomPolicy')).to.deep.eq(['totp']);
    expect(await pendingSteps(child, session(['recovery']), 'CustomPolicy')).to.deep.eq(['recovery']);
  });
});
```

- [ ] **Step 3: RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/mfa-policy-config.test.ts`
Expected: FAIL to compile: `pendingSteps` takes two arguments, and `mfaPolicyOf(child, 'CustomPolicy')` type-checks only as `unknown`, but `MfaSatisfied.PolicyService` is `undefined` (it resolves the Configuration itself).

- [ ] **Step 4: Implement**

1. `policies/v3/mfa.ts` head and `MfaSatisfied`:

```ts
import { Autoinject, Container, isFactory } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { MfaPolicy } from '@spinajs/authn/contracts';

import { refused, unauthenticated } from './errors.js';
import { authenticatedPrincipal } from './principal.js';

/** The policy DefaultAuthnService asks at login: the registration named `name` (authn.mfa.policy.service) nearest to `container`. */
export async function mfaPolicyOf(container: IContainer, name: string): Promise<MfaPolicy> {
  const types = container.getRegisteredTypes(Array.chainOf(MfaPolicy)) ?? [];
  const type = [...types].reverse().find((t) => t.name === name);
  if (!type) throw new InvalidOption(`authn.mfa.policy.service ${JSON.stringify(name)}: no MfaPolicy is registered under that name`);
  const policy = (isFactory(type) ? await (type as Factory<unknown>)(container) : await container.resolve(type as Class<unknown>)) as MfaPolicy | null;
  if (typeof policy?.required !== 'function') throw new InvalidOption(`authn.mfa.policy.service ${JSON.stringify(name)}: the registration is not an MfaPolicy (no required())`);
  return policy;
}

/** Passes when MfaPolicy requires no step for the principal, or its authn.assurance is aal2 (A20, D2). */
export class MfaSatisfied extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.mfa.policy.service')
  protected PolicyService: string;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    const principal = authenticatedPrincipal(req);
    const authn = principal.authn;
    if (authn?.assurance === 'aal2') return;
    if (!authn) throw refused('mfa_required', 'this route needs a second factor');
    const policy = await mfaPolicyOf(this.Container, this.PolicyService);
    const steps = await policy.required({ type: principal.type, id: principal.id }, { method: authn.method, strategy: authn.strategy });
    if (steps.length > 0) throw refused('mfa_required', 'this route needs a second factor');
  }
}
```

(`PendingMfaEnrolment` below it is unchanged.)

2. `routes.ts`: delete `import { Configuration } from '@spinajs/configuration';` (line 2) and replace `pendingSteps`:

```ts
/** The steps a pending session waits for; a migrated 2.x row keeps none, so the MFA policy `policyService` (authn.mfa.policy.service) is asked as completeMfa asks it. */
export async function pendingSteps(container: IContainer, session: Restored, policyService: string): Promise<string[]> {
  const stored = session.data.get(SESSION_PENDING_STEPS_KEY);
  if (Array.isArray(stored) && stored.length > 0 && stored.every((s) => typeof s === 'string')) return [...stored];
  const policy = await mfaPolicyOf(container, policyService);
  return [...(await policy.required(session.identity, { method: session.facts.method, strategy: session.facts.strategy }))];
}
```

3. `AuthnLoginController.ts`: add `import { Config } from '@spinajs/configuration';`, the property after `Container`:

```ts
  @Config('authn.mfa.policy.service')
  protected MfaPolicyService: string;
```

and line 93 `await pendingSteps(this.Container, session, this.MfaPolicyService)`. Do the same in `AuthnMfaController.ts` (the call near line 55).

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/mfa-policy-config.test.ts`, then `npm test`. Tests that call `pendingSteps(container, session)` or `mfaPolicyOf(container, undefined)` (grep `test/`) pass `'DefaultMfaPolicy'`.
2. If the schema step was needed: `cd packages/authn && npm test` after the edit, and rebuild authn first (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`).
3. Rebuild authn-http (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`) and run the dependants, sequentially: `for p in authn-oidc users-http; do (cd packages/$p && npm test) || break; done`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn-http/src packages/authn-http/test
git commit -m "refactor(authn-http): the MFA policy name comes from @Config and the schema default, not a fallback in code"
```

---

### Task 3.11: authn-oidc registers its own schema and reads `authn.oidc`, `authn.linking`, the trust setting and the session cookie through `@Config`

Row: authn-oidc `OidcProviders`, `OidcBootstrapper`, `OidcController`, `FetchOidcHttpClient`.

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts` (delete the `oidc` block; give `linking` defaults)
- Modify: `packages/authn-oidc/src/options/schema.ts:35-113` (provider and module schema), `packages/authn-oidc/src/options/options.ts` (whole file), `packages/authn-oidc/src/providers.ts:1-17`, `:24-47`, `:89-92`, `packages/authn-oidc/src/bootstrap.ts` (whole file), `packages/authn-oidc/src/origin.ts` (whole file), `packages/authn-oidc/src/controllers/OidcController.ts:2-3`, `:8`, `:16`, `:58-64`, `:115-138`
- No change: `packages/authn-oidc/src/http/client.ts` (see Interfaces)
- Test: create `packages/authn-oidc/test/support/config-boot.ts` (helper H), `packages/authn-oidc/test/support/oidc-config.ts`, `packages/authn-oidc/test/config-schema.test.ts`; rewrite `packages/authn-oidc/test/origin.test.ts`; edit `test/config.test.ts`, `test/hardening.test.ts`, `test/presets.test.ts`, `test/sr16-env.test.ts`, `test/contracts.test.ts:30-38`, `test/core.test.ts`, `test/support/harness.ts`, `test/support/world.ts`; edit `packages/authn/test/contracts/config-schema.test.ts` (the `oidc` cases at lines ~116, ~183, ~409-417)

**Interfaces:**
- Consumes: `registerConfigurationSchema` (`@spinajs/configuration`); `proxyTrustOf` from `@spinajs/authn-http` (Task 3.9); `isTrustedPeer` and `parseTrustProxy` from `@spinajs/http` (the shared parser: the oidc copy `trustedPeer` is deleted, so `authn.http.trustProxy`, else `http.trustProxy`, is parsed in one place for the CSRF guard, the client IP and the OIDC origin); `AUTHN_CONFIGURATION_SCHEMA` (for `authn.linking` and `authn.session.cookie`) and `HTTP_CONFIGURATION_SCHEMA` (`http.trustProxy`).
- Produces: `AUTHN_OIDC_CONFIGURATION_SCHEMA` with `$id: 'spinajs/authn-oidc.configuration.schema.json'` and `$configurationModule: 'authn.oidc'`, registered by `OidcBootstrapper`; the provider schema in place of the authn schema's `{ type: 'object' }` stub (the `authn.oidc` block leaves `AUTHN_CONFIGURATION_SCHEMA`: two schemas on one path would report every redirect violation twice); schema defaults `clockSkewSeconds 30`, `algorithms` (all of `OIDC_SIGNING_ALGORITHMS`), `requiredClaims {}`, `authorizationParams {}`, `linking { jit: false, byVerifiedEmail: false }`, `redirects { success: '/', failure: '/' }`; `buildOidcOptions(config, env, extra)` replaces `readOidcOptions` (the exported names `readOidcOptions` and `trustedPeer` go; `contracts.test.ts` pins the export list and changes with them).
- The schema rewrite that the app Ajv forces: the existing provider schema uses `additionalProperties: false` (provider, `clientSecret`, `claims`, `linking`, the module, `redirects`), which `removeAdditional: true` would delete silently, and was compiled by its own strict Ajv. Each becomes `propertyNames: { enum: [...] }`, so an unknown key is a violation named by its full path (`authn.oidc.providers.corp.flow`). The strict standalone Ajv and `checkProviderShape` go. `OIDC_APP_PATH_PATTERN` (strict: one leading `/`, no `//`, `/\`, control character, space or backslash) is now the only redirect rule; the authn stub's weaker pattern leaves with its block.
- Stays in code, and why: (a) the https-or-development rule for `issuer`, `baseUrl` and `redirectUri` (it reads the app env, which a schema cannot, and the SR-16 "no env named means production" rule); (b) the mutable-subject check (`email`, `upn`, `preferred_username`, `login`, `name`), because the subject mapping is the preset's merged with the provider's; (c) the preset merge (scopes, claims, endpoints, token endpoint auth), the secret redaction and the deep freeze; (d) the "provider linking is on but `authn.linking` is off" warning; (e) `registerOidcStrategies` (DI registration) and the `resolve()` that builds each provider and strategy. `checkFinite` (a `requiredClaims` number must be finite) goes: a JSON config cannot hold `NaN` or `Infinity`, and Ajv's `number` type refuses them in a JS config file.
- `FetchOidcHttpClient`: `@Config` cannot apply. Its only configuration read is the app env, which needs the Configuration object (`authnAppEnv` reads `Env` and the process env sources for the SR-16 fallback); it keeps `DI.get(Configuration)` plus `appEnvOf` of authn-session, which Task 3.2 made a thin call to the shared authn helper. Not changed.
- Behaviour notes: `isTrustedPeer` with a hop count requires a peer that is an IP address (the oidc copy trusted any peer for a count); that is stricter and equals what the CSRF guard and `ClientIp` already do. A schema violation of a provider now fails the Configuration boot (`InvalidConfiguration`, every violation named) instead of failing `OidcProviders.resolve()` with the first `InvalidOption`. An `if`/`then` branch that fails also reports one extra violation at the provider path (`must match "then" schema`) next to the key-level ones; tests use `include`.

- [ ] **Step 1: Schema additions**

`packages/authn/src/schemas/authn.configuration.ts`: delete the `oidc` block (the last property of `properties`, from `oidc: {` to its closing `},`). Give `linking` defaults (skip when Phase 2 already did):

```ts
    linking: {
      type: 'object',
      default: {},
      properties: {
        jit: { type: 'boolean', default: false },
        byVerifiedEmail: { type: 'boolean', default: false },
      },
    },
```

`packages/authn-oidc/src/options/schema.ts`: keep lines 1-33 (the constants and `only`, `branch`); replace lines 35-113 with:

```ts
const PROVIDER_MEMBERS = [
  'preset', 'issuer', 'tenant', 'baseUrl', 'realm', 'domain', 'authorizationServer', 'host', 'clientId', 'clientSecret', 'tokenEndpointAuth',
  'redirectUri', 'scopes', 'claims', 'algorithms', 'clockSkewSeconds', 'userinfo', 'requiredClaims', 'authorizationParams', 'linking',
];

/** One authn.oidc.providers.<name> entry (OidcProviderConfig). The https rule, the subject rule and the env are checked by buildOidcOptions. */
export const AUTHN_OIDC_PROVIDER_SCHEMA = {
  type: 'object',
  propertyNames: { enum: PROVIDER_MEMBERS },
  required: ['clientId', 'clientSecret'],
  properties: {
    preset: { type: 'string', enum: [...OIDC_PRESET_IDS] },
    issuer: { type: 'string', minLength: 1 },
    tenant: { type: 'string', pattern: OIDC_ENTRA_TENANT_PATTERN },
    baseUrl: { type: 'string', minLength: 1 },
    realm: { type: 'string', pattern: OIDC_SEGMENT_PATTERN },
    domain: { type: 'string', pattern: OIDC_HOST_PATTERN },
    authorizationServer: { anyOf: [{ type: 'string', pattern: OIDC_SEGMENT_PATTERN }, { type: 'null' }] },
    host: { type: 'string', pattern: OIDC_HOST_PATTERN },

    clientId: { type: 'string', minLength: 1 },
    clientSecret: {
      type: 'object',
      propertyNames: { enum: ['secret'] },
      required: ['secret'],
      properties: { secret: { type: 'string', minLength: 1 } },
    },
    tokenEndpointAuth: { type: 'string', enum: ['client_secret_basic', 'client_secret_post'] },
    redirectUri: { type: 'string', minLength: 1 },
    scopes: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: SCOPE_TOKEN_PATTERN } },
    claims: {
      type: 'object',
      propertyNames: { enum: ['subject', 'email', 'emailVerified', 'name', 'groups'] },
      properties: { subject: claimPath, email: optionalClaimPath, emailVerified: optionalClaimPath, name: optionalClaimPath, groups: optionalClaimPath },
    },
    algorithms: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...OIDC_SIGNING_ALGORITHMS] }, default: [...OIDC_SIGNING_ALGORITHMS] },
    clockSkewSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 30 },
    userinfo: { type: 'boolean' },
    requiredClaims: { type: 'object', default: {}, additionalProperties: { type: ['string', 'number', 'boolean'] } },
    authorizationParams: {
      type: 'object',
      default: {},
      propertyNames: { not: { enum: [...OIDC_RESERVED_PARAMS] } },
      additionalProperties: { type: 'string' },
    },
    linking: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['jit', 'byVerifiedEmail'] },
      properties: { jit: { type: 'boolean', default: false }, byVerifiedEmail: { type: 'boolean', default: false } },
    },
  },
  allOf: [
    {
      if: { type: 'object', not: { required: ['preset'] } },
      then: { type: 'object', required: ['issuer'], properties: only('issuer') },
    },
    branch('google', { properties: only() }),
    branch('entra', { required: ['tenant'], properties: only('tenant') }),
    branch('keycloak', { required: ['baseUrl', 'realm'], properties: only('baseUrl', 'realm') }),
    branch('auth0', { required: ['domain'], properties: only('domain') }),
    branch('okta', { required: ['domain'], properties: only('domain', 'authorizationServer') }),
    branch('github', { properties: { ...only('host'), userinfo: { const: true } } }),
  ],
};

/** authn.oidc (OidcConfig), a module of its own: the app's configuration validates it and fills the defaults. */
export const AUTHN_OIDC_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-oidc.configuration.schema.json',
  $configurationModule: 'authn.oidc',
  description: 'OpenID Connect providers and redirects (authn.oidc.*)',
  type: 'object',
  propertyNames: { enum: ['providers', 'redirects'] },
  properties: {
    providers: {
      type: 'object',
      default: {},
      propertyNames: { pattern: OIDC_PROVIDER_NAME_PATTERN },
      additionalProperties: AUTHN_OIDC_PROVIDER_SCHEMA,
    },
    redirects: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['success', 'failure'] },
      properties: {
        success: { type: 'string', pattern: OIDC_APP_PATH_PATTERN, default: '/' },
        failure: { type: 'string', pattern: OIDC_APP_PATH_PATTERN, default: '/' },
      },
    },
  },
};
```

(`as const` is dropped: the defaults are arrays.)

- [ ] **Step 2: Write the failing tests**

Copy helper H to `packages/authn-oidc/test/support/config-boot.ts`. `packages/authn-oidc/test/support/oidc-config.ts` (what the tests that exercise `buildOidcOptions` feed it: the shape the schema produces; the schema test pins it):

```ts
import { OIDC_SIGNING_ALGORITHMS } from '../../src/contracts.js';
import { buildOidcOptions } from '../../src/options/options.js';
import type { BuildOidcOptionsExtra, ConfiguredOidc, OidcOptions } from '../../src/options/options.js';

/** `raw` as the schema would hand it over: defaults filled. test/config-schema.test.ts pins this function to the schema. */
export function withSchemaDefaults(raw: unknown): ConfiguredOidc {
  const input = (raw ?? {}) as { providers?: Record<string, Record<string, unknown>>; redirects?: Record<string, string> };
  const providers = Object.fromEntries(
    Object.entries(input.providers ?? {}).map(([name, p]) => [
      name,
      { clockSkewSeconds: 30, algorithms: [...OIDC_SIGNING_ALGORITHMS], requiredClaims: {}, authorizationParams: {}, ...p, linking: { jit: false, byVerifiedEmail: false, ...(p.linking as object | undefined) } },
    ]),
  );
  return { providers, redirects: { success: '/', failure: '/', ...input.redirects } } as unknown as ConfiguredOidc;
}

/** The old `readOidcOptions(raw, env, extra)` entry the build tests use, over defaulted input. */
export function readOidcOptions(raw: unknown, env: string | undefined, extra: BuildOidcOptionsExtra = {}): OidcOptions {
  return buildOidcOptions(withSchemaDefaults(raw), env, extra);
}
```

`packages/authn-oidc/test/config-schema.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

import { OidcBootstrapper } from '../src/bootstrap.js';
import { OIDC_SIGNING_ALGORITHMS } from '../src/contracts.js';
import { buildOidcOptions } from '../src/options/options.js';
import { AUTHN_OIDC_CONFIGURATION_SCHEMA } from '../src/options/schema.js';
import { boot, configurationOf, disposeBooted, violationsOf } from './support/config-boot.js';
import { withSchemaDefaults } from './support/oidc-config.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_OIDC_CONFIGURATION_SCHEMA];
const SECRET = 'SUPER-SECRET-VALUE-42';
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const ISSUER = 'https://idp.example.test/realms/corp';

const client = (over: Record<string, unknown> = {}) => ({ clientId: 'canvas', clientSecret: { secret: SECRET }, ...over });
const generic = (over: Record<string, unknown> = {}) => client({ issuer: ISSUER, ...over });
const oidc = (providers: Record<string, unknown>, redirects?: Record<string, unknown>) => ({ authn: { oidc: { providers, ...(redirects ? { redirects } : {}) } } });
const bad = (providers: Record<string, unknown>, redirects?: Record<string, unknown>) => violationsOf(SCHEMAS, oidc(providers, redirects));
const at = (name: string, key: string) => `authn.oidc.providers.${name}.${key}`;

describe('authn.oidc through its own schema', () => {
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('gives an unconfigured authn.oidc no providers and the default redirects', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.oidc')).to.deep.eq({ providers: {}, redirects: { success: '/', failure: '/' } });
    });

    it('fills every default of a provider, equal to the fixture the build tests use', async () => {
      const raw = { providers: { corp: generic() }, redirects: { success: '/app' } };
      const { configuration } = await boot(SCHEMAS, { authn: { oidc: raw } });
      expect(configuration.get('authn.oidc')).to.deep.eq(withSchemaDefaults(raw));
      expect(configuration.get('authn.oidc.providers.corp.algorithms')).to.deep.eq([...OIDC_SIGNING_ALGORITHMS]);
      expect(configuration.get('authn.oidc.providers.corp.clockSkewSeconds')).to.eq(30);
      expect(configuration.get('authn.oidc.redirects.failure')).to.eq('/');
    });

    it('fills the global linking switches', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.linking')).to.deep.eq({ jit: false, byVerifiedEmail: false });
    });
  });

  describe('violations', () => {
    it('names the provider, its name and its shape', async () => {
      expect(await bad({ 'Corp IdP': generic() })).to.include('authn.oidc.providers.Corp IdP');
      expect(await bad({ ['a'.repeat(60)]: generic() })).to.include(`authn.oidc.providers.${'a'.repeat(60)}`);
      expect(await bad({ corp: 'https://idp.example.test' })).to.include('authn.oidc.providers.corp');
      expect(await bad({ corp: { issuer: ISSUER, clientSecret: { secret: SECRET } } })).to.include(at('corp', 'clientId'));
      expect(await bad({ corp: { issuer: ISSUER, clientId: 'c' } })).to.include(at('corp', 'clientSecret'));
      expect(await bad({ corp: generic({ clientSecret: { secret: '' } }) })).to.include(at('corp', 'clientSecret.secret'));
      expect(await bad({ corp: generic({ clientSecret: { secret: SECRET, other: 1 } }) })).to.include(at('corp', 'clientSecret.other'));
      expect(await bad({ corp: generic({ flow: 'implicit' }) })).to.include(at('corp', 'flow'));
    });

    it('names the key an unknown authn.oidc member or redirect would be', async () => {
      expect(await violationsOf(SCHEMAS, { authn: { oidc: { providers: {}, flow: 'implicit' } } })).to.include('authn.oidc.flow');
      expect(await bad({}, { other: '/x' })).to.include('authn.oidc.redirects.other');
    });

    it('names the source key a preset refuses or lacks', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [client({}), at('corp', 'issuer')],
        [client({ preset: 'myidp', issuer: ISSUER }), at('corp', 'preset')],
        [client({ preset: 'google', issuer: ISSUER }), at('corp', 'issuer')],
        [client({ preset: 'entra' }), at('corp', 'tenant')],
        [client({ preset: 'entra', tenant: 'common' }), at('corp', 'tenant')],
        [client({ preset: 'keycloak', baseUrl: 'https://kc.example.test' }), at('corp', 'realm')],
        [client({ preset: 'keycloak', baseUrl: 'https://kc.example.test', realm: '..' }), at('corp', 'realm')],
        [client({ preset: 'auth0', domain: 'https://corp.auth0.com' }), at('corp', 'domain')],
        [client({ preset: 'okta', domain: 'corp.okta.com', authorizationServer: '../x' }), at('corp', 'authorizationServer')],
        [client({ preset: 'github', userinfo: false }), at('corp', 'userinfo')],
        [client({ preset: 'github', issuer: ISSUER }), at('corp', 'issuer')],
      ];
      for (const [provider, path] of cases) expect(await bad({ corp: provider }), JSON.stringify(provider)).to.include(path);
    });

    it('accepts one sound config per preset', async () => {
      const sound = [
        client({ preset: 'google' }),
        client({ preset: 'entra', tenant: TENANT }),
        client({ preset: 'keycloak', baseUrl: 'https://kc.example.test', realm: 'corp' }),
        client({ preset: 'auth0', domain: 'corp.auth0.com' }),
        client({ preset: 'okta', domain: 'corp.okta.com', authorizationServer: null }),
        client({ preset: 'github', host: 'ghe.example.test', userinfo: true }),
        generic(),
      ];
      for (const provider of sound) expect(await bad({ corp: provider }), JSON.stringify(provider)).to.deep.eq([]);
    });

    it('names the bad option', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ tokenEndpointAuth: 'none' }, 'tokenEndpointAuth'],
        [{ scopes: ['openid', 'openid'] }, 'scopes'],
        [{ scopes: ['bad scope'] }, 'scopes.0'],
        [{ algorithms: ['HS256'] }, 'algorithms.0'],
        [{ algorithms: [] }, 'algorithms'],
        [{ clockSkewSeconds: 301 }, 'clockSkewSeconds'],
        [{ requiredClaims: { tier: {} } }, 'requiredClaims.tier'],
        [{ authorizationParams: { state: 'x' } }, 'authorizationParams.state'],
        [{ authorizationParams: { ui_locales: {} } }, 'authorizationParams.ui_locales'],
        [{ claims: { typo: 'x' } }, 'claims.typo'],
        [{ claims: { subject: '' } }, 'claims.subject'],
        [{ linking: { typo: true } }, 'linking.typo'],
        [{ redirectUri: '' }, 'redirectUri'],
      ];
      for (const [over, key] of cases) expect(await bad({ corp: generic(over) }), JSON.stringify(over)).to.include(at('corp', key));
    });

    it('names a redirect that is not an app-relative path', async () => {
      for (const value of ['//evil.example.com', '/\\evil.example.com', 'https://evil.example.com', '/\t/evil.example', 'relative']) {
        expect(await bad({}, { success: value }), JSON.stringify(value)).to.include('authn.oidc.redirects.success');
      }
      expect(await bad({}, { failure: '//evil.example.com' })).to.include('authn.oidc.redirects.failure');
      expect(await bad({}, { success: '/app?x=1&y=%20', failure: '/' })).to.deep.eq([]);
    });

    it('never puts a configured value into the error', async () => {
      let error: unknown;
      try {
        await boot(SCHEMAS, oidc({ corp: generic({ clockSkewSeconds: 999 }) }));
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(InvalidConfiguration);
      expect((error as Error).message).to.not.contain(SECRET);
      expect(JSON.stringify((error as InvalidConfiguration).violations)).to.not.contain(SECRET);
    });
  });

  describe('what buildOidcOptions still checks', () => {
    const configOf = async (providers: Record<string, unknown>) => (await boot(SCHEMAS, oidc(providers))).configuration.get<never>('authn.oidc');

    it('refuses http endpoints outside development and test, naming the key', async () => {
      const cfg = await configOf({ corp: generic({ issuer: 'http://idp.example.test/realms/corp' }) });
      for (const env of ['production', 'staging', undefined]) {
        expect(() => buildOidcOptions(cfg, env), String(env)).to.throw(InvalidOption, 'authn.oidc.providers.corp.issuer');
      }
      for (const env of ['development', 'test']) expect(buildOidcOptions(cfg, env).providers.get('corp')!.issuer).to.eq('http://idp.example.test/realms/corp');
    });

    it('refuses a redirectUri with a fragment', async () => {
      const cfg = await configOf({ corp: generic({ redirectUri: 'https://app.example.test/cb#x' }) });
      expect(() => buildOidcOptions(cfg, 'production')).to.throw(InvalidOption, 'authn.oidc.providers.corp.redirectUri');
    });

    it('refuses a mutable subject claim, preset or not', async () => {
      for (const subject of ['email', 'upn', ['profile', 'preferred_username']]) {
        const cfg = await configOf({ corp: generic({ claims: { subject } }) });
        expect(() => buildOidcOptions(cfg, 'production'), JSON.stringify(subject)).to.throw(InvalidOption, 'immutable subject');
      }
    });

    it('warns when a provider switch has no global switch behind it, and redacts the secret', async () => {
      const cfg = await configOf({ corp: generic({ linking: { jit: true } }) });
      const warnings: string[] = [];
      const options = buildOidcOptions(cfg, 'production', { linking: { jit: false, byVerifiedEmail: false }, log: { warn: (m) => warnings.push(m) } });
      expect(warnings.join('\n')).to.contain('authn.oidc.providers.corp.linking.jit').and.to.contain('authn.linking.jit');
      const provider = options.providers.get('corp')!;
      expect(provider.clientSecret.secret).to.eq(SECRET);
      expect(JSON.stringify(provider)).to.not.contain(SECRET);
      expect(Object.isFrozen(provider)).to.eq(true);
    });
  });

  describe('OidcBootstrapper', () => {
    const schemas = (): unknown[] => (DI.get(Array.ofType('__configurationSchema__' as never)) as unknown[] | null) ?? [];
    const Spec = configurationOf({ authn: { oidc: { providers: {} } } });
    let saved: unknown[] = [];

    before(() => {
      saved = [...schemas()];
      DI.register(Spec).as(Configuration);
    });

    after(() => {
      DI.unregister(Spec);
      DI.uncache(Configuration);
      DI.uncache('__configurationSchema__' as never);
      for (const other of saved) DI.register(other as never).asValue('__configurationSchema__');
    });

    it('registers the authn.oidc schema before the Configuration boots', async () => {
      await new OidcBootstrapper().bootstrap();
      expect(schemas()).to.include(AUTHN_OIDC_CONFIGURATION_SCHEMA);
    });
  });
});
```

`packages/authn-oidc/test/origin.test.ts` (whole file; `trustedPeer` is deleted, so the same cases now go through the shared `parseTrustProxy` and `isTrustedPeer`, which proves the reuse):

```ts
import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { isTrustedPeer, parseTrustProxy } from '@spinajs/http';

import { requestOrigin } from '../src/origin.js';

const trusted = (setting: unknown) => {
  const trust = parseTrustProxy(setting, 'http.trustProxy');
  return (peer: string | undefined) => isTrustedPeer(trust, peer);
};

const facts = (over: Partial<Parameters<typeof requestOrigin>[0]> = {}) => ({ encrypted: false, peer: '10.0.0.5', host: 'app.example.test', forwardedProto: 'https', forwardedHost: 'public.example.test', ...over });

describe('authn-oidc request origin', () => {
  it('ignores forwarded headers without a trusted proxy', () => {
    for (const setting of [undefined, null, false, 0, []] as const) {
      expect(requestOrigin(facts(), trusted(setting)), String(setting)).to.eq('http://app.example.test');
    }
    expect(requestOrigin(facts({ encrypted: true }), trusted(null))).to.eq('https://app.example.test');
  });

  it('takes the first forwarded proto and host from a trusted peer', () => {
    for (const setting of [true, 1, 2, '10.0.0.0/8', ['10.0.0.5'], 'uniquelocal', 'loopback, 10.0.0.0/8'] as const) {
      expect(requestOrigin(facts({ forwardedProto: 'https, http', forwardedHost: 'public.example.test, inner' }), trusted(setting)), String(setting)).to.eq('https://public.example.test');
    }
  });

  it('does not trust a peer outside the listed ranges, and reads IPv4-mapped peers', () => {
    expect(requestOrigin(facts({ peer: '203.0.113.9' }), trusted('10.0.0.0/8'))).to.eq('http://app.example.test');
    expect(requestOrigin(facts({ peer: '::ffff:10.0.0.5' }), trusted('10.0.0.0/8'))).to.eq('https://public.example.test');
    expect(requestOrigin(facts({ peer: '::1' }), trusted('loopback'))).to.eq('https://public.example.test');
    expect(requestOrigin(facts({ peer: undefined }), trusted('10.0.0.0/8'))).to.eq('http://app.example.test');
    expect(requestOrigin(facts({ peer: undefined }), trusted(1)), 'a hop count needs a peer that is an address').to.eq('http://app.example.test');
  });

  it('keeps only http or https as the scheme, and falls back to the Host header', () => {
    expect(requestOrigin(facts({ forwardedProto: 'javascript' }), trusted(true))).to.eq('http://public.example.test');
    expect(requestOrigin(facts({ forwardedHost: undefined }), trusted(true))).to.eq('https://app.example.test');
    expect(requestOrigin(facts({ forwardedProto: 'HTTPS' }), trusted(true))).to.eq('https://public.example.test');
  });

  it('refuses a trust entry that is no address', () => {
    expect(() => trusted('10.0.0.0/8, not-an-ip')).to.throw(InvalidOption);
    expect(() => trusted(['10.0.0.0/abc'])).to.throw(InvalidOption);
  });
});
```

Edits to the existing tests:
- `test/config.test.ts`, `hardening.test.ts`, `presets.test.ts`, `sr16-env.test.ts`, `test/support/harness.ts`, `test/support/world.ts`: replace `import { readOidcOptions } from '../src/options/options.js'` (and `../../src/...` in `support/`) by the same name from `./support/oidc-config.js` (`../support/...` as the relative depth needs). Then delete every case whose refusal the schema now owns, because it feeds `readOidcOptions` a wrong type, an unknown key, a bad preset combination or a malformed redirect: the `refused(() => ..., ...)` and `refusedProvider(...)` calls about `flow`, `providers must be an object`, a non-object provider, `preset`/`tenant`/`realm`/`domain`/`authorizationServer` shapes, `tokenEndpointAuth`, `scopes`, `algorithms`, `clockSkewSeconds`, `requiredClaims`, `authorizationParams`, `claims` and `linking` keys, and the app-path loop of `hardening.test.ts` (lines ~25-35). Keep: the preset merge, the endpoint, issuer and alias cases; the https and relaxed-env cases; the mutable subject cases; the linking-warning cases (`config.test.ts` ~383-390, `hardening.test.ts` ~58); `sr16-env.test.ts` entirely. A test that compiles `AUTHN_OIDC_CONFIGURATION_SCHEMA` with a bare Ajv adds `ajv.addKeyword('$configurationModule')` and no longer asserts `additionalProperties: false`.
- `test/contracts.test.ts` `INDEX_VALUES`: delete `'readOidcOptions'` and `'trustedPeer'`, add `'buildOidcOptions'`.
- `test/core.test.ts` (`core()`), `test/support/harness.ts`, `test/support/world.ts`: every child that registers a Configuration (`grep -rn "as(Configuration)" test`) first registers `AUTHN_CONFIGURATION_SCHEMA` and `AUTHN_OIDC_CONFIGURATION_SCHEMA` (`child.register(S).asValue('__configurationSchema__')`), because the provider defaults come from the schema now; a provider config in those fixtures that omits nothing the schema requires needs no other change.
- `packages/authn/test/contracts/config-schema.test.ts`: remove `oidc` from the example config (line ~116) and from the declared-keys expectation (line ~183), and delete the three `refused({ oidc: ... })` cases at ~409-417 (the authn-oidc schema test above covers them).

- [ ] **Step 3: RED**

Run: `cd packages/authn-oidc && npx ts-mocha -p tsconfig.json test/config-schema.test.ts test/origin.test.ts`
Expected: FAIL. `buildOidcOptions` and `ConfiguredOidc` are not exported (compile error); with those stubbed, `AUTHN_OIDC_CONFIGURATION_SCHEMA` has no `$configurationModule` (its registration fails the boot), and `origin.test.ts` is the only file that passes (it exercises the shared parser, which is already exported by `@spinajs/http`).

- [ ] **Step 4: Implement**

1. Apply Step 1, then `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

2. `packages/authn-oidc/src/options/options.ts` (whole file):

```ts
import { InvalidOption } from '@spinajs/exceptions';

import type { OidcAppPath, OidcAuthorizationParams, OidcClaimPath, OidcClaimsMapping, OidcEndpoints, OidcPresetId, OidcProviderConfig, OidcProviderSource, OidcSecretRef, OidcSigningAlgorithm, OidcStrategyName, OidcTokenEndpointAuth } from '../contracts.js';
import { DEFAULT_CLAIMS, OIDC_PRESETS, resolveEndpoints, resolveIssuer } from '../presets.js';
import { checkedUrl, deepFreeze, isRelaxedEnv } from '../support.js';

/** One configured provider after defaults and presets; deep frozen. */
export interface OidcProviderOptions {
  readonly name: string;
  readonly strategy: OidcStrategyName;
  readonly preset: OidcPresetId | null;
  readonly source: OidcProviderSource;
  /** False for plain OAuth2 (GitHub): no ID token, no discovery. */
  readonly idToken: boolean;
  /** null for plain OAuth2. */
  readonly issuer: string | null;
  readonly issuerAliases: readonly string[];
  /** Fixed endpoints of plain OAuth2; null when discovery finds them. */
  readonly endpoints: OidcEndpoints | null;
  readonly clientId: string;
  readonly clientSecret: OidcSecretRef;
  readonly tokenEndpointAuth: OidcTokenEndpointAuth;
  /** null: the callback route on the request's origin. */
  readonly redirectUri: string | null;
  readonly scopes: readonly string[];
  readonly claims: OidcClaimsMapping;
  readonly algorithms: readonly OidcSigningAlgorithm[];
  readonly clockSkewSeconds: number;
  /** 'auto': fetch when the provider has a userinfo endpoint. */
  readonly userinfo: boolean | 'auto';
  readonly requiredClaims: Readonly<Record<string, string | number | boolean>>;
  readonly authorizationParams: OidcAuthorizationParams;
  readonly linking: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
}

export interface OidcOptions {
  readonly providers: ReadonlyMap<string, OidcProviderOptions>;
  readonly redirects: { readonly success: OidcAppPath; readonly failure: OidcAppPath };
}

/** A provider as the schema leaves it: the defaults are filled in. */
export type ConfiguredProvider = OidcProviderConfig & {
  readonly clockSkewSeconds: number;
  readonly algorithms: readonly OidcSigningAlgorithm[];
  readonly requiredClaims: Readonly<Record<string, string | number | boolean>>;
  readonly authorizationParams: Readonly<Record<string, string>>;
  readonly linking: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
};

/** `authn.oidc` as the schema validates and defaults it. */
export interface ConfiguredOidc {
  readonly providers: Readonly<Record<string, ConfiguredProvider>>;
  readonly redirects: { readonly success: OidcAppPath; readonly failure: OidcAppPath };
}

export interface BuildOidcOptionsExtra {
  /** The global authn.linking switches (default off); a provider switch without its global one only earns a warning. */
  readonly linking?: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
  readonly log?: { warn(message: string): void };
}

const ROOT = 'authn.oidc';
const SOURCE_KEYS = ['preset', 'issuer', 'tenant', 'baseUrl', 'realm', 'domain', 'authorizationServer', 'host'] as const;
/** nOAuth: claims a user or a tenant admin can change, so they never identify an account. */
const MUTABLE_SUBJECT_CLAIMS = new Set(['email', 'upn', 'preferred_username', 'login', 'name']);

/** The secret stays readable, but JSON and util.inspect show it redacted, so a dump of the options never leaks it. */
function redacted(secret: string): OidcSecretRef {
  const ref = { secret };
  const hidden = { secret: '[redacted]' };
  Object.defineProperty(ref, 'toJSON', { value: () => hidden, enumerable: false });
  Object.defineProperty(ref, Symbol.for('nodejs.util.inspect.custom'), { value: () => hidden, enumerable: false });
  return ref;
}

const fail = (message: string): never => {
  throw new InvalidOption(message);
};

const lastSegment = (p: OidcClaimPath): string => (typeof p === 'string' ? p : p[p.length - 1]);

// What the schema cannot judge: the scheme rule depends on the app env, which it cannot read.
function checkUrls(at: string, raw: Record<string, unknown>, relaxed: boolean): void {
  const scheme = relaxed ? 'an http or https URL' : 'an https URL';
  if (raw.issuer !== undefined && !checkedUrl(raw.issuer, { relaxed })) {
    fail(`${at}.issuer must be ${scheme} without credentials, query or fragment`);
  }
  if (raw.baseUrl !== undefined && !checkedUrl(raw.baseUrl, { relaxed })) {
    fail(`${at}.baseUrl must be ${scheme} without credentials, query or fragment`);
  }
  if (raw.redirectUri !== undefined && !checkedUrl(raw.redirectUri, { relaxed, query: true })) {
    fail(`${at}.redirectUri must be an absolute ${relaxed ? 'http or https' : 'https'} URL without credentials or fragment`);
  }
}

function sourceOf(raw: Record<string, unknown>): OidcProviderSource {
  return Object.fromEntries(SOURCE_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])) as unknown as OidcProviderSource;
}

function buildProvider(name: string, provider: ConfiguredProvider, env: string | undefined, extra: BuildOidcOptionsExtra): OidcProviderOptions {
  const at = `${ROOT}.providers.${name}`;
  const raw = provider as unknown as Record<string, unknown>;
  checkUrls(at, raw, isRelaxedEnv(env));

  const source = sourceOf(raw);
  const presetId = provider.preset ?? null;
  const preset = presetId ? OIDC_PRESETS[presetId] : null;
  const idToken = preset ? preset.idToken : true;

  const claims: OidcClaimsMapping = { ...(preset?.claims ?? DEFAULT_CLAIMS), ...(provider.claims ?? {}) };
  if (MUTABLE_SUBJECT_CLAIMS.has(lastSegment(claims.subject).toLowerCase())) {
    fail(`${at}.claims.subject must be an immutable subject, never email, upn, preferred_username, login or name`);
  }

  const configuredScopes = provider.scopes ?? preset?.scopes ?? ['openid', 'email', 'profile'];
  const scopes = idToken && !configuredScopes.includes('openid') ? ['openid', ...configuredScopes] : [...configuredScopes];

  const linking = { jit: provider.linking.jit, byVerifiedEmail: provider.linking.byVerifiedEmail };
  if (extra.log) {
    const global = extra.linking ?? { jit: false, byVerifiedEmail: false };
    for (const k of ['jit', 'byVerifiedEmail'] as const) {
      if (linking[k] && !global[k]) {
        extra.log.warn(`${at}.linking.${k} is on but authn.linking.${k} is off, so it has no effect`);
      }
    }
  }

  return deepFreeze({
    name,
    strategy: `oidc:${name}` as OidcStrategyName,
    preset: presetId,
    source,
    idToken,
    issuer: idToken ? resolveIssuer(source) : null,
    issuerAliases: preset?.issuerAliases ? [...preset.issuerAliases] : [],
    endpoints: idToken ? null : { ...resolveEndpoints(source) },
    clientId: provider.clientId,
    clientSecret: redacted(provider.clientSecret.secret),
    tokenEndpointAuth: provider.tokenEndpointAuth ?? preset?.tokenEndpointAuth ?? 'client_secret_basic',
    redirectUri: provider.redirectUri ?? null,
    scopes,
    claims,
    algorithms: [...provider.algorithms],
    clockSkewSeconds: provider.clockSkewSeconds,
    // The subject of a plain OAuth2 provider comes from userinfo, so it is always on.
    userinfo: idToken ? (provider.userinfo ?? 'auto') : true,
    requiredClaims: { ...provider.requiredClaims },
    authorizationParams: { ...provider.authorizationParams } as OidcAuthorizationParams,
    linking,
  });
}

/**
 * The options of a validated `authn.oidc` (design §22.15): the preset merge, the https rule outside development and test,
 * the subject mapping and the linking warnings. The shape, the names, the redirects and the defaults are the schema's.
 * Throws InvalidOption naming the provider and the key; a message never carries a configured value.
 */
export function buildOidcOptions(config: ConfiguredOidc, env: string | undefined, extra: BuildOidcOptionsExtra = {}): OidcOptions {
  const providers = new Map(Object.entries(config.providers).map(([name, provider]) => [name, buildProvider(name, provider, env, extra)] as const));
  return Object.freeze({ providers, redirects: Object.freeze({ ...config.redirects }) });
}
```

3. `packages/authn-oidc/src/origin.ts` (whole file):

```ts
export interface OriginFacts {
  readonly encrypted: boolean;
  readonly peer: string | undefined;
  readonly host: string | undefined;
  readonly forwardedProto: string | undefined;
  readonly forwardedHost: string | undefined;
}

const firstOf = (v: string | undefined): string | undefined => v?.split(',')[0]?.trim().toLowerCase() || undefined;

/**
 * The app's origin as the client sees it, for the default redirect_uri. `trusted` is built from the shared trust setting
 * (authn-http's proxyTrustOf and @spinajs/http's isTrustedPeer, as ClientIp and the CSRF guard use). X-Forwarded-Proto and
 * -Host count only from a trusted peer; as in express, the first value is the client's side. The provider's exact match of
 * the registered redirect URI stays the guard against a forged Host.
 */
export function requestOrigin(f: OriginFacts, trusted: (peer: string | undefined) => boolean): string {
  const viaProxy = trusted(f.peer);
  const proto = (viaProxy ? firstOf(f.forwardedProto) : undefined) ?? (f.encrypted ? 'https' : 'http');
  const host = (viaProxy ? firstOf(f.forwardedHost) : undefined) ?? f.host ?? '';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}
```

4. `packages/authn-oidc/src/providers.ts`: imports `import { Config, Configuration } from '@spinajs/configuration';`, `import { buildOidcOptions } from './options/options.js'; import type { ConfiguredOidc, OidcOptions } from './options/options.js';`, `import { isRelaxedEnv } from './support.js';` (drop `isPlainObject` and `readOidcOptions`). The class members and `resolve()` head:

```ts
  @Config('authn.oidc')
  protected Oidc: ConfiguredOidc;

  @Config('authn.linking')
  protected GlobalLinking: { jit: boolean; byVerifiedEmail: boolean };

  public options!: OidcOptions;
  public env: string | undefined;
  public linking = { jit: false, byVerifiedEmail: false };
  protected readonly byName = new Map<string, OidcStrategy>();

  constructor(protected readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    // A @Config read needs the container's Configuration resolved; the env needs the object itself (SR-16).
    const config = await this.container.resolve(Configuration);
    this.env = appEnvOf(config);
    this.linking = { jit: this.GlobalLinking.jit, byVerifiedEmail: this.GlobalLinking.byVerifiedEmail };
    this.options = buildOidcOptions(this.Oidc, this.env, {
      linking: this.linking,
      log: { warn: (m: string) => this.Log?.warn(m) },
    });
```

(the `if (this.options.providers.size > 0) { ... }` block and the rest are unchanged), and the last function:

```ts
/** The provider names of an `authn.oidc` value the schema has validated. */
export function providerNamesOf(config: { readonly providers?: Readonly<Record<string, unknown>> } | undefined): string[] {
  return Object.keys(config?.providers ?? {});
}
```

5. `packages/authn-oidc/src/bootstrap.ts` (whole file):

```ts
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Config, Configuration, registerConfigurationSchema } from '@spinajs/configuration';

import type { ConfiguredOidc } from './options/options.js';
import { AUTHN_OIDC_CONFIGURATION_SCHEMA } from './options/schema.js';
import { providerNamesOf, registerOidcStrategies } from './providers.js';

/**
 * Registers the authn.oidc schema, so the Configuration validates the providers, then the 'oidc:<name>' strategy services
 * before the core's registry looks them up (D4).
 */
@Injectable(Bootstrapper)
export class OidcBootstrapper extends Bootstrapper {
  @Config('authn.oidc')
  protected Oidc: ConfiguredOidc | undefined;

  public async bootstrap(): Promise<void> {
    registerConfigurationSchema(AUTHN_OIDC_CONFIGURATION_SCHEMA);
    // A @Config read needs the Configuration resolved; resolving it also validates the schema just registered.
    await DI.resolve(Configuration);
    registerOidcStrategies(providerNamesOf(this.Oidc));
  }
}
```

6. `OidcController.ts`: imports: delete `import { Configuration } from '@spinajs/configuration';`; add `import { Config } from '@spinajs/configuration';`, `import { proxyTrustOf } from '@spinajs/authn-http';` and add `isTrustedPeer` to the `@spinajs/http` import list; `import { requestOrigin } from '../origin.js';`. Add after `protected warnedHttpOrigin = false;`:

```ts
  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  @Config('authn.session.cookie')
  protected SessionCookie: ISessionCookieConfig;
```

and in `login()` replace lines 119-124 by:

```ts
    const providers = await DI.resolve(OidcProviders);
    this.env = providers.env;
    // The trust setting of ClientIp and the CSRF guard, parsed once by the shared parser.
    const trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    this.trusted = (peer) => isTrustedPeer(trust, peer);
    const cookieConfig = this.SessionCookie;
```

- [ ] **Step 5: GREEN, package suite, dependants**

1. `cd packages/authn-oidc && npx ts-mocha -p tsconfig.json test/config-schema.test.ts test/origin.test.ts test/core.test.ts`, then `npm test`.
2. `cd packages/authn && npm test` (the removed `oidc` block and the `linking` defaults).
3. Rebuild authn-oidc: `cd packages/authn-oidc && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. No package depends on authn-oidc.
4. The whole chain once more, end to end, sequentially, to confirm no task left the workspace red: `for p in http authn authn-session authn-token authn-orm authn-totp authn-local authn-keys authn-http authn-oidc; do (cd packages/$p && npm test) || break; done`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/test/contracts/config-schema.test.ts packages/authn-oidc/src packages/authn-oidc/test
git commit -m "refactor(authn-oidc): authn.oidc gets a schema of its own and the classes read it through @Config; trustedPeer reuses the http parser"
```

---

## Self-review notes

- Coverage: every row of "Phase 3: authn packages" has a task (rows 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 of the table: 3.8, 3.9 with 3.1, 3.10, 3.7, 3.11, 3.5, 3.4, 3.6, 3.3, 3.2) and the new `http` module is 3.1.
- Risk points:
  - `@Config` cannot be read in a constructor of a DI-built instance (the hidden container key is injected after construction), which is why `DbTokenService`, the authn-keys strategies and `TotpMfaStep` move their checks out of constructors (Tasks 3.3, 3.7, 3.4).
  - Tests that boot the root Configuration lose code defaults that moved into schemas: each task names the fixtures that register the schema.
  - `$data` inside `enum` (Task 3.3, `keys[].alg`) and in `minimum` (Tasks 3.1, 3.6) is the one Ajv feature not already exercised by the tree; Task 3.3 states its fallback.
  - The uncommitted `decorators.ts` change (container injection) is a precondition of the whole phase.
