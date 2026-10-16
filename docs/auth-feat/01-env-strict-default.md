# Strict Environment by Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every security-relaxing decision (authz explain route and denial traces, error detail in HTTP and socket answers, email recipient redirection, the 2.x public-cookie-secret check) relaxes only when an env source explicitly names development or test. An app can also refuse to boot without a named env.

**Architecture:** `@spinajs/configuration-common` gets one rule: `environmentPosture(sources)` and the predicates `isSecurityRelaxed(posture)` and `isProductionPosture(posture)`. `FrameworkConfiguration.load()` computes the posture from the env sources it already reads (`--env`/APP_ENV, a DI-registered `process.env`, NODE_ENV). It writes the posture to `configuration.env` after every source, so no config file can relax it. Consumers read `configuration.env` through `@Config` and ask the predicates. Config-file selection keeps its `'development'` fallback. authn's existing SR-16 helpers delegate to the same name rule.

**Tech Stack:** TypeScript, `@spinajs/configuration` (`@Config`, Ajv schema), mocha + chai / `node:assert`, ts-mocha.

## Global Constraints

- English comments, identifiers and commits. Comment only what the code cannot say.
- One commit per task. Run the package suites before each commit.
- Run tests from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A dependant reads a changed package from `lib/`. After changing a package, rebuild it before you test its dependants: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
- Working-copy files use CRLF. Keep them CRLF.
- Value checks and defaults go in the module's JSON schema. Code keeps only DI lookups, compilation and cross-domain merges.
- Never add a schema default that changes an effective access or security value (mechanism-notes, "Lessons").
- Test isolation: never `DI.clear()`. Boot in child containers and dispose them in `afterEach`.
- Commit only your own hunks. Check `git diff --cached --stat` before each commit.

---

## Current state

- `buildEnvironmentFlags` (`packages/configuration/src/config/configuration.ts:25-41`) computes `normalizeEnvironment(env.APP_ENV ?? env.NODE_ENV ?? 'development')` once, at module load, from `process.env` (`:44`). With no env, `configuration.isProduction` is `false`. It ignores `--env` and a DI-registered `process.env`, so `node app --env production` without APP_ENV still reports `isProduction: false`.
- `FrameworkConfiguration.load()` resolves `APP_ENV: this.Env ?? env?.APP_ENV ?? process.env.NODE_ENV ?? 'development'` (`packages/configuration/src/configuration.ts:230`). `this.Env` is `parseArgv('--env') ?? process.env.APP_ENV` (`:128`). `resolve()` runs `load()`, `validate()` and `configure()` (`:202-205`).
- authn is already strict. `authnEnvFellBack`, `authnAppEnv` and `isLenientAuthnEnv` (`packages/authn/src/service/boot/env.ts:27-47`) treat an unnamed env as production (SR-16). `authn-session` (`cookie.ts:56,79`) and `authn-oidc` (`support.ts:8-11`, `isRelaxedEnv`) use the same rule, which allows only `dev` and `test`.
- These consumers are fail-open when no env is set:
  - `packages/authz/src/host/env.ts:7-9` `isProduction(flag)` falls back to `... ?? 'development'`. It feeds `ExplainControllerSource` (`packages/authz-http/src/explain/source.ts:22-31`) and `AccessPolicy.trace` (`packages/authz-http/src/access/policy.ts:56-57,154`).
  - `packages/http/src/error.ts:42,66` adds `stack` when `configuration.isProduction` is not true. With no Configuration, it also takes `false`.
  - `packages/http-socket/src/errors.ts:120-121,145` adds the message and the stack when `IsProduction` is false (`defaultValue: false`).
  - `packages/email/src/index.ts:48-49,60,105` redirects recipients unless `IsProduction` is true (`defaultValue: false`).
  - `packages/authn-http/src/middlewares.ts:45-56` (2.x `RbacMiddleware`) refuses the public cookie secret only when `process.env.NODE_ENV === 'production'`, so `APP_ENV=prod` alone only warns.
- Not security decisions, left alone: `packages/templates/src/interfaces.ts:36` (`isDevelopment`, template caching) and the queue transports' `process.env.APP_ENV` (queue naming). `packages/telemetry/src/policies/development.ts:11-26` already needs an explicit `dev` and `isProduction !== true`, so it is stricter than this plan and stays.
- `authn:check-config` reports the fallback under topic `env` (`packages/authn/src/service/boot/check-config.ts:65`). It maps an `InvalidConfiguration` to topic `schema` (`:38`).

## Decisions (confirm before Task 1)

1. **Relaxed means `normalizeEnvironment(name)` is `dev` or `test`, and nothing else.** `local`, `staging` and every other name are strict. This is the rule authn (SR-16) and authn-oidc already use, so one rule serves every package.
2. **An empty env (`APP_ENV=`) counts as named but is production.** This matches config-file selection (`normalizeEnvironment('')` is `prod`).
3. **The posture is written after all sources and is not taken from config files.** A config file cannot relax security. A test or app code can still `Configuration.set('configuration.env', …)` at runtime.
4. **Email redirection follows `production` (production or unnamed), not `relaxed`.** The connection docs (`packages/email/src/interfaces.ts:270-276`) name redirection a staging feature. The fail-open case was the unnamed env, and this closes it.
5. **`configuration.requireExplicitEnv` defaults to `false` (opt-in).** With this plan an unnamed env is already strict, so failing the boot would only break CLIs, scripts and tests that never set an env. The schema default `false` keeps today's effective value. Production deployments set it to `true` to catch a mis-templated env.
6. **`configuration.isProduction`, `isDevelopment` and `isLocal` stay as they are**, for non-security consumers such as templates. After this plan no security decision reads them.
7. **`isProduction()` is removed from `@spinajs/authz`.** Its only callers are the two authz-http sites. A fail-open helper should not stay public. Alternative: keep it, deprecated.
8. **A built-in schema for the `configuration` module** (`requireExplicitEnv` only), always applied by `FrameworkConfiguration.validate()`. It has no `additionalProperties: false`, so `isProduction` and the posture are left alone.
9. **The 2.x `RbacMiddleware` reads the shared posture**, not authn's `appEnvOf`. For a `FrameworkConfiguration` both answer the same, and the posture is what this plan makes shared.

## Security notes

- Addressed: a deployment that forgets APP_ENV and NODE_ENV no longer exposes the authz explain route, denial traces, stack traces or socket error messages. It no longer redirects mail, and it no longer boots the 2.x middleware on the public cookie secret. `APP_ENV=prod` without NODE_ENV is now fatal for that secret. `--env production` alone now counts as production for these checks (before, `buildEnvironmentFlags` ignored `--env`).
- Addressed: no config file, including a mis-shipped `*.dev.js` merged into production, can switch the posture to relaxed.
- Residual: a deployment that explicitly sets `APP_ENV=development` in production is relaxed by design. `configuration.requireExplicitEnv` does not catch this. Code that calls `Configuration.set('configuration.env', …)` can still change the posture.
- Residual: staging and `local` lose explain, traces and stack traces. This is a deliberate availability cost; they keep email redirection.

## Facts verified (2026-10-06)

- `normalizeEnvironment` maps `''`, `null` and `undefined` to `prod` and does not fold case (`packages/configuration-common/src/environment.ts:16-30`). Its test is `packages/configuration-common/test/environment.test.ts`.
- `packages/configuration-common/src/index.ts` and `index.browser.ts` both `export * from './environment.js'`. `@spinajs/configuration` re-exports configuration-common (`packages/configuration/src/index.ts:5`).
- `IConfigurationSchema` is only `{ $configurationModule: string }` (`packages/configuration-common/src/definitions.ts:17-19`). Pass an untyped literal and cast at the use site.
- `FrameworkConfiguration.validate()` sets `this.ValidationSchemas = this.schemasOfLineage()` (`packages/configuration/src/configuration.ts:395-396`). `throwIfInvalid` is private (`:412`). The DI `__configuration__` merge ends at `:255` and `loadProtocolVars()` is at `:258`.
- The test fixture `configurationOf(values)` + `NoSource` (`packages/configuration/test/fixtures.ts`) is the pattern of `schema-validation.test.ts:68-76`.
- The authz-http tests pin the old flag in these places: `test/explain.test.ts:49,59,67,74,85,91`, `test/access-policy.test.ts:116-124`, `test/fail-closed.test.ts:21,49`, `test/support/http-harness.ts:190`. `startApp` applies `opts.config` with `cfg.set(path.split('.'), value)` (`test/support/app.ts:61`).
- authz-testing `HttpWorld.env` is `'production' | 'development' | 'test'`, documented as "default: not production" (`packages/authz-testing/src/behaviour/lane.ts:75-76`). B41 builds worlds with `world(env)` (`B41-production.spec.ts:12-19`).
- The http-socket harness pins `configuration: { isProduction: false }` (`packages/http-socket/test/harness.ts:70`). `TestConfiguration` does not override `loadSources`. Tests that set production are `error-mapping.test.ts:132` and `handshake.test.ts:164`.
- The email tests set `configuration.isProduction` (`packages/email/test/redirect.service.test.ts:64-67`) or define `IsProduction` on the instance (`packages/email/test/capture.ts:72`).
- The 2.x middleware test builds `RbacMiddleware` with `new` and `Object.defineProperty` (`packages/authn-http/test/rbac-middleware.test.ts:47-56`).
- The brief said `packages/users/src` checks `NODE_ENV`. It does not: `grep -rn "NODE_ENV\|production" packages/users/src packages/users-http/src` finds nothing. The `docs/authn/README.md:268-270` TODO(C1) about `users` shipping `secure: NODE_ENV === 'production'` is stale, because `packages/users/src/config/users.ts` has no cookie key.
- The authn harness `configurationOf(values, env?, isolated?)` sets `this.Env = env` (`packages/authn/test/behaviour/harness.ts:96-114`). The check-config `env` tests save and clear APP_ENV and NODE_ENV (`packages/authn/test/boot/check-config.test.ts:127-140`).
- `docs/authn/README.md:258-262` and `:645-648` still say that a missing env means development for authn. That is stale since SR-16.

## File structure

| File | Responsibility |
|---|---|
| `packages/configuration-common/src/environment.ts` | Posture rule: sources → `{ name, relaxed, production }`, predicates, config paths |
| `packages/configuration/src/module-schema.ts` (new) | Schema of the `configuration` module (`requireExplicitEnv`) |
| `packages/configuration/src/configuration.ts` | Writes the posture after the sources, warns when unnamed, applies the module schema, enforces `requireExplicitEnv` |
| `packages/authz-http/src/explain/source.ts`, `src/access/policy.ts` | Explain route and denial trace gated on `isSecurityRelaxed` |
| `packages/authz/src/host/env.ts` (deleted) | Removes the fail-open `isProduction` |
| `packages/http/src/error.ts` | `exposesErrorDetail(config)` gates `stack` |
| `packages/http-socket/src/errors.ts` | Socket internal error detail gated on `isSecurityRelaxed` |
| `packages/email/src/index.ts` | Redirection refused under `isProductionPosture` |
| `packages/authn-http/src/middlewares.ts` | 2.x public cookie secret fatal unless relaxed |
| `packages/authn/src/service/boot/env.ts`, `check-config.ts`; `packages/authn-oidc/src/support.ts` | Delegate to the shared name rule; report `requireExplicitEnv` under topic `env` |

Task order: 1 → 2, then 3, 4, 5 and 6 in any order (they touch disjoint packages), then 7. Rebuild configuration-common after Task 1 and configuration after Task 2.

---

### Task 1: The posture rule in configuration-common

**Files:**
- Modify: `packages/configuration-common/src/environment.ts` (append after line 30)
- Test: `packages/configuration-common/test/environment.test.ts` (append)

**Interfaces:**
- Consumes: `normalizeEnvironment(env?: string | null): string` (same file).
- Produces (exported through `@spinajs/configuration-common` and `@spinajs/configuration`):
  - `const ENVIRONMENT_POSTURE_PATH = 'configuration.env'`
  - `const REQUIRE_EXPLICIT_ENV_PATH = 'configuration.requireExplicitEnv'`
  - `interface EnvironmentSources { env?: string | null; registeredAppEnv?: string | null; nodeEnv?: string | null }`
  - `interface EnvironmentPosture { name: string | null; relaxed: boolean; production: boolean }`
  - `explicitEnvironment(sources: EnvironmentSources): string | null`
  - `isRelaxedEnvironmentName(name: string | null | undefined): boolean`
  - `environmentPosture(sources: EnvironmentSources): EnvironmentPosture`
  - `isSecurityRelaxed(posture: unknown): boolean`
  - `isProductionPosture(posture: unknown): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `packages/configuration-common/test/environment.test.ts`. Extend its import to `import { environmentPosture, explicitEnvironment, isProductionPosture, isRelaxedEnvironmentName, isSecurityRelaxed, normalizeEnvironment } from '../src/environment.js';`.

```ts
describe('environment posture', () => {
  it('takes the first set source: --env/APP_ENV, then a registered APP_ENV, then NODE_ENV', () => {
    expect(explicitEnvironment({ env: 'staging', registeredAppEnv: 'dev', nodeEnv: 'production' })).to.equal('staging');
    expect(explicitEnvironment({ registeredAppEnv: 'dev', nodeEnv: 'production' })).to.equal('dev');
    expect(explicitEnvironment({ nodeEnv: 'production' })).to.equal('production');
    expect(explicitEnvironment({})).to.equal(null);
    // '' is set, as for config file selection: it does not fall through to NODE_ENV
    expect(explicitEnvironment({ env: '', nodeEnv: 'development' })).to.equal('');
  });

  it('relaxes only an env named development or test', () => {
    for (const name of ['development', 'dev', 'test']) expect(isRelaxedEnvironmentName(name), name).to.equal(true);
    for (const name of ['production', 'prod', 'staging', 'local', 'qa', 'Development', 'TEST', '', null, undefined]) {
      expect(isRelaxedEnvironmentName(name), String(name)).to.equal(false);
    }
  });

  it('counts no env and an empty env as production', () => {
    expect(environmentPosture({})).to.deep.equal({ name: null, relaxed: false, production: true });
    expect(environmentPosture({ env: '' })).to.deep.equal({ name: '', relaxed: false, production: true });
    expect(environmentPosture({ env: 'prod' })).to.deep.equal({ name: 'prod', relaxed: false, production: true });
    expect(environmentPosture({ env: 'staging' })).to.deep.equal({ name: 'staging', relaxed: false, production: false });
    expect(environmentPosture({ nodeEnv: 'test' })).to.deep.equal({ name: 'test', relaxed: true, production: false });
  });

  it('reads a posture fail-closed', () => {
    expect(isSecurityRelaxed(environmentPosture({ env: 'development' }))).to.equal(true);
    for (const v of [environmentPosture({}), environmentPosture({ env: 'staging' }), undefined, null, true, 'development', { relaxed: 'true' }]) {
      expect(isSecurityRelaxed(v), JSON.stringify(v)).to.equal(false);
    }
    expect(isProductionPosture(environmentPosture({ env: 'staging' }))).to.equal(false);
    for (const v of [environmentPosture({}), environmentPosture({ env: 'production' }), undefined, null, {}, { production: 'false' }]) {
      expect(isProductionPosture(v), JSON.stringify(v)).to.equal(true);
    }
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/configuration-common && npx ts-mocha -p tsconfig.json test/environment.test.ts`
Expected: FAIL at compile time: `Module '"../src/environment.js"' has no exported member 'environmentPosture'` (and the same for the other new names).

- [ ] **Step 3: Implement**

Append to `packages/configuration-common/src/environment.ts`:

```ts
/** Where FrameworkConfiguration writes the EnvironmentPosture once every source has loaded. */
export const ENVIRONMENT_POSTURE_PATH = 'configuration.env';

/** true: refuse to boot when no env source names the app env. */
export const REQUIRE_EXPLICIT_ENV_PATH = 'configuration.requireExplicitEnv';

/** The env sources FrameworkConfiguration.load reads, in its order of precedence. */
export interface EnvironmentSources {
  /** `--env`, else the APP_ENV of the process when the configuration was built (FrameworkConfiguration.Env). */
  readonly env?: string | null;
  /** APP_ENV of a DI-registered `process.env`. */
  readonly registeredAppEnv?: string | null;
  readonly nodeEnv?: string | null;
}

export interface EnvironmentPosture {
  /** The env as a source named it, verbatim; null when no source did. */
  readonly name: string | null;
  /** Security checks may relax: the env is named development or test. */
  readonly relaxed: boolean;
  /** The env is production, or none is named. */
  readonly production: boolean;
}

const RELAXED_ENVIRONMENTS: readonly string[] = ['dev', 'test'];

/** The first source that is set. `''` counts as set, as it does for config file selection. */
export function explicitEnvironment(sources: EnvironmentSources): string | null {
  return sources.env ?? sources.registeredAppEnv ?? sources.nodeEnv ?? null;
}

export function isRelaxedEnvironmentName(name: string | null | undefined): boolean {
  return name !== null && name !== undefined && RELAXED_ENVIRONMENTS.includes(normalizeEnvironment(name));
}

export function environmentPosture(sources: EnvironmentSources): EnvironmentPosture {
  const name = explicitEnvironment(sources);
  return { name, relaxed: isRelaxedEnvironmentName(name), production: name === null || normalizeEnvironment(name) === 'prod' };
}

/** `posture` is the value at ENVIRONMENT_POSTURE_PATH. Anything but a posture that says relaxed is strict. */
export function isSecurityRelaxed(posture: unknown): boolean {
  return typeof posture === 'object' && posture !== null && (posture as Partial<EnvironmentPosture>).relaxed === true;
}

/** Anything but a posture that says `production: false` counts as production. */
export function isProductionPosture(posture: unknown): boolean {
  return !(typeof posture === 'object' && posture !== null && (posture as Partial<EnvironmentPosture>).production === false);
}
```

- [ ] **Step 4: Run and confirm GREEN, then rebuild**

Run: `cd packages/configuration-common && npx ts-mocha -p tsconfig.json test/environment.test.ts`
Expected: PASS, 8 passing, 0 failing.

Run: `cd packages/configuration-common && npm test && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: all passing. The build exits 0, and `lib/mjs/environment.d.ts` declares `environmentPosture`.

- [ ] **Step 5: Commit**

```bash
git add packages/configuration-common/src/environment.ts packages/configuration-common/test/environment.test.ts
git diff --cached --stat
git commit -m "feat(configuration-common): environment posture, relaxed only for an env named development or test"
```

---

### Task 2: FrameworkConfiguration writes the posture and can require a named env

**Files:**
- Create: `packages/configuration/src/module-schema.ts`
- Modify: `packages/configuration/src/configuration.ts` (imports `:13-22`; `resolve()` `:204-205`; `load()` `:226-231` and after `:255`; `validate()` `:396`; a new method after `validateModule`)
- Modify: `packages/configuration/src/config/configuration.ts:16-17` (comment)
- Test: `packages/configuration/test/environment-posture.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 names.
- Produces: every `FrameworkConfiguration` holds an `EnvironmentPosture` at `configuration.env` after `resolve()`. `configuration.requireExplicitEnv: true` with no named env (or `''`) rejects `resolve()` with `InvalidConfiguration` whose `violations[0].path === 'configuration.requireExplicitEnv'`. `CONFIGURATION_MODULE_SCHEMA` is exported from `module-schema.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/configuration/test/environment-posture.test.ts`:

```ts
import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, environmentPosture } from '@spinajs/configuration-common';

import { configurationOf, NoSource } from './fixtures.js';
import { InvalidConfiguration } from '../src/exception.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const booted: IContainer[] = [];

/** `values` booted with `env` as the configuration's own source (`--env`, else APP_ENV when built); undefined: none. */
async function boot(values: Record<string, unknown>, env?: string): Promise<Configuration> {
  const Base = configurationOf(values);
  const WithEnv = class extends Base {
    constructor() {
      super();
      this.Env = env;
    }
  };
  const child = DI.child();
  booted.push(child);
  child.register(NoSource).as(ConfigurationSource);
  child.register(WithEnv).as(Configuration);
  return (await child.resolve(Configuration)) as Configuration;
}

async function violationPaths(values: Record<string, unknown>, env?: string): Promise<string[]> {
  try {
    await boot(values, env);
  } catch (e) {
    expect(e).to.be.instanceOf(InvalidConfiguration);
    return (e as InvalidConfiguration).violations.map((v) => v.path);
  }
  throw new Error('expected InvalidConfiguration');
}

describe('environment posture of FrameworkConfiguration', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['APP_ENV', 'NODE_ENV']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(async () => {
    for (const c of booted.splice(0)) await c.dispose();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('writes the posture of the named env', async () => {
    for (const [name, relaxed, production] of [['development', true, false], ['test', true, false], ['production', false, true], ['staging', false, false], ['local', false, false]] as const) {
      expect((await boot({}, name)).get('configuration.env'), name).to.deep.eq({ name, relaxed, production });
    }
  });

  it('takes NODE_ENV when no other source names the env', async () => {
    process.env.NODE_ENV = 'test';
    expect((await boot({})).get('configuration.env')).to.deep.eq({ name: 'test', relaxed: true, production: false });
  });

  it('takes the APP_ENV of a DI-registered process.env', async () => {
    const registered = DI.get<Record<string, string>>('process.env');
    DI.register({ APP_ENV: 'development' }).asValue('process.env', true);
    try {
      expect((await boot({})).get('configuration.env')).to.deep.eq({ name: 'development', relaxed: true, production: false });
    } finally {
      DI.uncache('process.env');
      if (registered) DI.register(registered).asValue('process.env');
    }
  });

  it('without any env: strict and production, while config files still load as development', async () => {
    const config = await boot({});
    expect(config.get('configuration.env')).to.deep.eq({ name: null, relaxed: false, production: true });
    expect(config.get('process.env.APP_ENV')).to.eq('development');
  });

  it('an empty env is strict and production', async () => {
    expect((await boot({}, '')).get('configuration.env')).to.deep.eq({ name: '', relaxed: false, production: true });
  });

  it('no configuration value relaxes it', async () => {
    const config = await boot({ configuration: { env: environmentPosture({ env: 'development' }) } });
    expect(config.get('configuration.env')).to.deep.eq({ name: null, relaxed: false, production: true });
  });

  it('configuration.requireExplicitEnv defaults to false', async () => {
    expect((await boot({})).get('configuration.requireExplicitEnv')).to.eq(false);
  });

  it('configuration.requireExplicitEnv refuses to boot without a named env, naming the key', async () => {
    expect(await violationPaths({ configuration: { requireExplicitEnv: true } })).to.deep.eq(['configuration.requireExplicitEnv']);
    expect(await violationPaths({ configuration: { requireExplicitEnv: true } }, '')).to.deep.eq(['configuration.requireExplicitEnv']);
    // coerceTypes: the string 'true' is true
    expect(await violationPaths({ configuration: { requireExplicitEnv: 'true' } })).to.deep.eq(['configuration.requireExplicitEnv']);
  });

  it('configuration.requireExplicitEnv boots with a named env', async () => {
    await expect(boot({ configuration: { requireExplicitEnv: true } }, 'production')).to.be.fulfilled;
    process.env.NODE_ENV = 'staging';
    await expect(boot({ configuration: { requireExplicitEnv: true } })).to.be.fulfilled;
  });

  it('a non-boolean configuration.requireExplicitEnv is a schema violation', async () => {
    expect(await violationPaths({ configuration: { requireExplicitEnv: 'yes' } }, 'production')).to.deep.eq(['configuration.requireExplicitEnv']);
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/configuration && npx ts-mocha -p tsconfig.json test/environment-posture.test.ts`
Expected: FAIL, 9 failing and 1 passing. The `configuration.env` cases fail with `AssertionError: expected undefined to deeply equal { name: …`. The `requireExplicitEnv` cases fail with `expected InvalidConfiguration`. The default case fails with `expected undefined to equal false`. The case "boots with a named env" passes already.

- [ ] **Step 3: Implement**

Create `packages/configuration/src/module-schema.ts`:

```ts
/** Schema of the `configuration` module itself; FrameworkConfiguration applies it on every boot. */
export const CONFIGURATION_MODULE_SCHEMA = {
  $id: 'spinajs-configuration',
  $configurationModule: 'configuration',
  type: 'object',
  properties: {
    requireExplicitEnv: { type: 'boolean', default: false, description: 'Refuse to boot when --env, APP_ENV and NODE_ENV are all unset or empty.' },
  },
};
```

In `packages/configuration/src/configuration.ts`:

1. Extend the `@spinajs/configuration-common` import (lines 13-22) with `ENVIRONMENT_POSTURE_PATH, REQUIRE_EXPLICIT_ENV_PATH, environmentPosture, explicitEnvironment` and the type `EnvironmentPosture`. Add `import { CONFIGURATION_MODULE_SCHEMA } from './module-schema.js';` after the `./util.js` import.

2. In `resolve()`, replace lines 204-205:

```ts
    this.validate();
    this.requireExplicitEnvironment();
    this.configure();
```

3. In `load()`, replace lines 226-231:

```ts
    const env = DI.get<NodeJS.ProcessEnv>('process.env');
    const sources = { env: this.Env, registeredAppEnv: env?.APP_ENV, nodeEnv: process.env.NODE_ENV };
    this.set('process.env', {
      ...process.env,
      ...env,
      APP_ENV: explicitEnvironment(sources) ?? 'development',
    });
```

and insert right after the DI `__configuration__` merge (after line 255, before `await this.loadProtocolVars();`):

```ts
    // After every source, so that no config file can relax it.
    const posture = environmentPosture(sources);
    this.set(ENVIRONMENT_POSTURE_PATH, posture);
    if (!posture.name) {
      InternalLogger.warn('No app env is set (--env, APP_ENV or NODE_ENV): config files load as development, but security checks are strict, as in production', 'Configuration');
    }
```

4. In `validate()`, replace line 396:

```ts
    this.ValidationSchemas = [CONFIGURATION_MODULE_SCHEMA as IConfigurationSchema, ...this.schemasOfLineage()];
```

5. Add after `validateModule` (after line 410):

```ts
  protected requireExplicitEnvironment() {
    if (this.get<unknown>(REQUIRE_EXPLICIT_ENV_PATH) !== true) return;
    if (this.get<EnvironmentPosture | undefined>(ENVIRONMENT_POSTURE_PATH)?.name) return;
    this.throwIfInvalid([], [{ path: REQUIRE_EXPLICIT_ENV_PATH, schema: CONFIGURATION_MODULE_SCHEMA.$id, message: 'is true, but no app env is named (--env, APP_ENV or NODE_ENV)' }]);
  }
```

In `packages/configuration/src/config/configuration.ts`, replace lines 16-17:

```ts
 * Security decisions do not read these flags: they read `configuration.env` (environmentPosture), which treats
 * an unnamed env as production.
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/configuration && npx ts-mocha -p tsconfig.json test/environment-posture.test.ts`
Expected: PASS, 10 passing.

Run: `cd packages/configuration && npm test`
Expected: all passing. If a test deep-equals the whole `configuration` object, add `requireExplicitEnv: false` and the `env` posture to its expectation. Do not drop the schema.

- [ ] **Step 5: Rebuild**

Run: `cd packages/configuration && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/configuration/src/module-schema.ts packages/configuration/src/configuration.ts packages/configuration/src/config/configuration.ts packages/configuration/test/environment-posture.test.ts
git diff --cached --stat
git commit -m "feat(configuration): configuration.env posture written after every source, and configuration.requireExplicitEnv"
```

---

### Task 3: authz explain route and denial traces only in a relaxed env

**Files:**
- Modify: `packages/authz-http/src/explain/source.ts:1-31`
- Modify: `packages/authz-http/src/access/policy.ts:2-3,56-57,154`
- Delete: `packages/authz/src/host/env.ts`; modify `packages/authz/src/host/index.ts:6`
- Modify: `packages/authz/test/host/defaults.test.ts:6,224-256`
- Modify: `packages/authz-testing/src/behaviour/lane.ts:75-76`, `packages/authz-testing/src/behaviour/B41-production.spec.ts:12,30-36`
- Modify: `packages/authz-http/test/support/http-harness.ts:190`
- Test: `packages/authz-http/test/explain.test.ts`, `test/access-policy.test.ts`, `test/fail-closed.test.ts`

**Interfaces:**
- Consumes: `ENVIRONMENT_POSTURE_PATH`, `isSecurityRelaxed`, `environmentPosture` from `@spinajs/configuration`.
- Produces: `ExplainControllerSource.EnvPosture` and `AccessPolicy.EnvPosture` (`@Config(ENVIRONMENT_POSTURE_PATH)`, type `unknown`), replacing `IsProduction`. `HttpWorld.env` accepts `null` (no env named), and its default is `'development'`.

- [ ] **Step 1: Write the failing tests**

In `packages/authz-testing/src/behaviour/lane.ts`, replace lines 75-76:

```ts
  /** The app env as --env names it; default 'development'; null: no env named, which is strict. */
  readonly env?: 'production' | 'development' | 'test' | 'staging' | null;
```

In `packages/authz-testing/src/behaviour/B41-production.spec.ts`, add after the case `'outside production the enabled explain route is registered'` (line 32):

```ts
      { name: 'with no app env named the explain route is not registered (404), even when enabled', world: world(null), steps: [http(EXPLAIN, { status: 404 })] },
      { name: 'on staging the explain route is not registered (404), even when enabled', world: world('staging'), steps: [http(EXPLAIN, { status: 404 })] },
      { name: 'with no app env named a 403 body carries no trace', world: world(null), steps: [http({ method: 'GET', path: '/files/f1', as: 'bob' }, { status: 403, absent: ['trace'] })] },
```

Rebuild authz-testing: `cd packages/authz-testing && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

In `packages/authz-http/test/explain.test.ts`, add `import { environmentPosture } from '@spinajs/configuration';` and, after the test `'is not registered while disabled (404)'`:

```ts
  it('is never registered when no app env is named or on staging, even when enabled (404)', async () => {
    for (const env of [{}, { env: 'staging' }]) {
      running = await boot({ 'authz.http.explainRoute': { enabled: true, permission: 'authz:explain' }, 'configuration.env': environmentPosture(env) });
      expect((await running.app.request().get(EXPLAIN).set('x-user', 'bob')).status, JSON.stringify(env)).to.eq(404);
      await running.domain.dispose();
      running = undefined;
      await stopApp();
    }
  });
```

In `packages/authz-http/test/access-policy.test.ts`, add `import { environmentPosture } from '@spinajs/configuration';`. Replace the `explain` helper and the `afterEach` (lines 116-124):

```ts
  const explain = (on: boolean, env: string | null) => {
    testHost.config().set(['authz', 'domains', D, 'engine'], { explain: on });
    testHost.config().set(['configuration', 'env'], environmentPosture({ env }));
  };

  afterEach(() => {
    testHost.config().unset(['authz', 'domains', D, 'engine']);
    testHost.config().unset(['configuration', 'env']);
  });
```

Change the calls in `describe('trace in a 403 (B23, B41)')`: `explain(true, false)` becomes `explain(true, 'development')` (twice), `explain(true, true)` becomes `explain(true, 'production')`, and `explain(false, false)` becomes `explain(false, 'development')`. Add:

```ts
    it('never without a named app env, nor on staging', async () => {
      for (const env of [null, 'staging']) {
        explain(true, env);
        expect((await app.request().get('/pol/files/f1').set('x-user', 'bob')).body, String(env)).to.not.have.property('trace');
      }
    });
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/explain.test.ts test/access-policy.test.ts test/behaviour.test.ts`
Expected: FAIL. `explain.test.ts`: `expected 200 to equal 404`. `access-policy.test.ts`: `expected { …, trace: {…} } to not have property 'trace'`. B41 `with no app env named …` and `on staging …`: status 200, not 404. The old code reads `configuration.isProduction`, which the seeded defaults set to `false`.

- [ ] **Step 3: Implement**

Replace `packages/authz-http/src/explain/source.ts` lines 1-31:

```ts
import { ClassInfo, Injectable } from '@spinajs/di';
import { Config, ENVIRONMENT_POSTURE_PATH, isSecurityRelaxed } from '@spinajs/configuration';
import { BaseController, CONTROLLED_DESCRIPTOR_SYMBOL, ControllerSource } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { ExplainController } from './controller.js';

/**
 * Hands the explain route to http only while `authz.http.explainRoute.enabled` and while the app env is named
 * development or test; otherwise it is never registered and a request gets 404 (H19, B41).
 */
@Injectable(ControllerSource)
export class ExplainControllerSource extends ControllerSource {
  @Logger('authz-http')
  protected Log: Log;

  @Config('authz.http.explainRoute.enabled')
  protected ExplainEnabled: boolean;

  @Config(ENVIRONMENT_POSTURE_PATH)
  protected EnvPosture: unknown;

  public async getControllers(): Promise<ClassInfo<BaseController>[]> {
    // The schema is the gate; this holds for a value that never went through it ('false', 1).
    if (this.ExplainEnabled !== true) return [];
    if (!isSecurityRelaxed(this.EnvPosture)) {
      this.Log.warn('authz.http.explainRoute.enabled is true outside development and test; the explain route is not registered');
      return [];
    }
```

(Lines 32-38 stay.)

In `packages/authz-http/src/access/policy.ts`:
- line 2: `import { Config, ENVIRONMENT_POSTURE_PATH, isSecurityRelaxed } from '@spinajs/configuration';`
- line 3: remove `isProduction, ` from the `@spinajs/authz` import list.
- lines 56-57:

```ts
  @Config(ENVIRONMENT_POSTURE_PATH)
  protected EnvPosture: unknown;
```

- the doc line above `trace` (line 150), "The trace of a denial, outside production only, …", becomes "The trace of a denial, only while the app env is named development or test, …".
- line 154: `if (!isSecurityRelaxed(this.EnvPosture)) return undefined;`

Delete `packages/authz/src/host/env.ts`. Remove line 6 (`export * from './env.js';`) from `packages/authz/src/host/index.ts`. In `packages/authz/test/host/defaults.test.ts`, remove `isProduction, ` from the import on line 6 and delete `describe('isProduction', …)` (lines 224-256).

In `packages/authz-http/test/support/http-harness.ts`, add `import { environmentPosture } from '@spinajs/configuration';` and replace line 190:

```ts
      const env = world.lane?.http?.env;
      host.setConfig(['configuration', 'env'], environmentPosture({ env: env === undefined ? 'development' : env }));
```

Update the remaining old pins:
- `test/explain.test.ts`: add `const RELAXED = environmentPosture({ env: 'development' });`. Each `'configuration.isProduction': false` becomes `'configuration.env': RELAXED` (lines 49, 59, 67, 74), and `'configuration.isProduction': true` (line 85) becomes `'configuration.env': environmentPosture({ env: 'production' })`. Line 91's regex becomes `/explainRoute\.enabled is true outside development and test/`.
- `test/fail-closed.test.ts`: add `import { environmentPosture } from '@spinajs/configuration';`. Line 21 becomes `const booted = await bootConfiguration({});`, followed by `booted.configuration.set(['configuration', 'env'], environmentPosture({ env: 'test' }));`. In line 49, `IsProduction: { value: false }` becomes `EnvPosture: { value: environmentPosture({ env: 'test' }) }`.

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/authz && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npx ts-mocha -p tsconfig.json test/host/defaults.test.ts`
Expected: PASS.

Run: `cd packages/authz-http && npm test`
Expected: all passing, the three new B41 cases included.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-http/src/explain/source.ts packages/authz-http/src/access/policy.ts packages/authz/src/host/env.ts packages/authz/src/host/index.ts packages/authz/test/host/defaults.test.ts packages/authz-testing/src/behaviour/lane.ts packages/authz-testing/src/behaviour/B41-production.spec.ts packages/authz-http/test/support/http-harness.ts packages/authz-http/test/explain.test.ts packages/authz-http/test/access-policy.test.ts packages/authz-http/test/fail-closed.test.ts
git diff --cached --stat
git commit -m "fix(authz-http): explain route and denial traces only in an env named development or test; isProduction removed from authz"
```

---

### Task 4: HTTP and socket error detail only in a relaxed env

**Files:**
- Modify: `packages/http/src/error.ts:9,33-68`
- Modify: `packages/http-socket/src/errors.ts:3,120-121,145`
- Modify: `packages/http-socket/test/harness.ts:60-84,96-97`
- Test: `packages/http/test/error-detail.test.ts` (new), `packages/http-socket/test/error-mapping.test.ts`, `packages/http-socket/test/handshake.test.ts:164`

**Interfaces:**
- Consumes: `ENVIRONMENT_POSTURE_PATH`, `isSecurityRelaxed`, `environmentPosture`.
- Produces: `exposesErrorDetail(config: Configuration | undefined): boolean` exported from `packages/http/src/error.ts`. The http-socket harness gains `configure(cfg?, appEnv: string | null = 'development')` and `startServer(cfg?, prepare?, appEnv: string | null = 'development')`.

- [ ] **Step 1: Write the failing tests**

Create `packages/http/test/error-detail.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { environmentPosture } from '@spinajs/configuration';
import type { Configuration } from '@spinajs/configuration';

import { exposesErrorDetail } from '../src/error.js';

const configWith = (posture: unknown) => ({ get: (path: string) => (path === 'configuration.env' ? posture : undefined) }) as unknown as Configuration;

describe('http error detail', () => {
  it('shows the stack only while the app env is named development or test', () => {
    expect(exposesErrorDetail(configWith(environmentPosture({ env: 'development' })))).to.eq(true);
    expect(exposesErrorDetail(configWith(environmentPosture({ env: 'test' })))).to.eq(true);
  });

  it('hides it in production, on staging, without a named env, without a posture and without a Configuration', () => {
    for (const posture of [environmentPosture({ env: 'production' }), environmentPosture({ env: 'staging' }), environmentPosture({}), undefined]) {
      expect(exposesErrorDetail(configWith(posture)), JSON.stringify(posture)).to.eq(false);
    }
    expect(exposesErrorDetail(undefined)).to.eq(false);
  });
});
```

In `packages/http-socket/test/harness.ts`, replace lines 60-84 (from `let overrides` through the end of `configure`):

```ts
let overrides: Record<string, unknown> = {};
let appEnvOfBoot: string | undefined = 'development';

export class TestConfiguration extends FrameworkConfiguration {
  constructor() {
    super();
    this.Env = appEnvOfBoot;
  }

  protected onLoad(): unknown {
    return _.merge(
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        http: { socket: _.cloneDeep(socketConfig.http.socket) },
      },
      overrides,
    );
  }
}

/** Fresh DI cache and configuration; `cfg` is merged over the test defaults. `appEnv` is the env --env names; null: none. */
export async function configure(cfg: Record<string, unknown> = {}, appEnv: string | null = 'development'): Promise<void> {
  overrides = cfg;
  appEnvOfBoot = appEnv ?? undefined;
  DI.clearCache();
  DI.register(TestConfiguration).as(Configuration);
  registerConfigurationSchema(SOCKET_CONFIGURATION_SCHEMA);
  await DI.resolve(Configuration);
}
```

Replace lines 96-97:

```ts
export async function startServer(cfg: Record<string, unknown> = {}, prepare?: (host: TestHttpHost) => void, appEnv: string | null = 'development'): Promise<ITestServer> {
  await configure(cfg, appEnv);
```

In `packages/http-socket/test/error-mapping.test.ts`, change line 132 to `await configure({}, 'production');`, and add after that test:

```ts
  it('hides the internal message when no app env is named, and on staging', async () => {
    const saved = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;
    try {
      for (const env of [null, 'staging']) {
        await configure({}, env);
        const wire = DI.resolve(SocketErrorMapper).toWire(new Error('db password is hunter2'), 'test');
        expect(wire, String(env)).to.deep.equal({ code: 'internal', message: 'Internal server error', retryable: false, errorId: wire.errorId });
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
```

In `packages/http-socket/test/handshake.test.ts`, change line 164 to `t = await startServer({}, undefined, 'production');`.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/http && npx ts-mocha -p tsconfig.json test/error-detail.test.ts`
Expected: FAIL at compile time: `Module '"../src/error.js"' has no exported member 'exposesErrorDetail'`.

Run: `cd packages/http-socket && npx ts-mocha -p tsconfig.json test/error-mapping.test.ts test/handshake.test.ts`
Expected: FAIL. `hides the internal message in production`, `… when no app env is named, and on staging` and the handshake production case fail with `expected { code: 'internal', message: 'db password is hunter2', … details … }`. The old mapper reads `configuration.isProduction`, which `buildEnvironmentFlags(process.env)` sets to false.

- [ ] **Step 3: Implement**

In `packages/http/src/error.ts`, replace line 9 with `import { Configuration, ENVIRONMENT_POSTURE_PATH, isSecurityRelaxed } from '@spinajs/configuration';` and add before `__handle_error__`:

```ts
/** Stack traces go into error bodies only while the app env is named development or test. */
export function exposesErrorDetail(config: Configuration | undefined): boolean {
  return isSecurityRelaxed(config?.get<unknown>(ENVIRONMENT_POSTURE_PATH));
}
```

Replace line 42 with `const showDetail = exposesErrorDetail(config);`. Replace lines 64-68:

```ts
        // Omitted entirely, not serialized as an empty object.
        if (showDetail) {
            error.stack = err.stack ? err.stack : err.parameter && err.parameter.stack;
        }
```

In `packages/http-socket/src/errors.ts`, replace line 3 with `import { Config, ENVIRONMENT_POSTURE_PATH, isSecurityRelaxed } from '@spinajs/configuration';`, and lines 120-121 with:

```ts
  @Config(ENVIRONMENT_POSTURE_PATH)
  protected EnvPosture: unknown;
```

Replace line 145, `if (this.IsProduction) {`, with `if (!isSecurityRelaxed(this.EnvPosture)) {`.

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/http && npx ts-mocha -p tsconfig.json test/error-detail.test.ts && npm test`
Expected: PASS, all passing.

Run: `cd packages/http && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`, then `cd packages/http-socket && npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/http/src/error.ts packages/http/test/error-detail.test.ts packages/http-socket/src/errors.ts packages/http-socket/test/harness.ts packages/http-socket/test/error-mapping.test.ts packages/http-socket/test/handshake.test.ts
git diff --cached --stat
git commit -m "fix(http, http-socket): error detail only in an env named development or test"
```

---

### Task 5: Email redirection refused in production and without a named env

**Files:**
- Modify: `packages/email/src/index.ts:4,37-49,60,101-105`
- Modify: `packages/email/src/redirect.ts:3-11`, `packages/email/src/interfaces.ts:276`
- Modify: `packages/email/test/capture.ts:72`
- Test: `packages/email/test/redirect.service.test.ts`

**Interfaces:**
- Consumes: `ENVIRONMENT_POSTURE_PATH`, `isProductionPosture`, `environmentPosture`.
- Produces: `DefaultEmailService.EnvPosture` (`@Config(ENVIRONMENT_POSTURE_PATH)`), replacing `IsProduction`.

- [ ] **Step 1: Write the failing tests**

In `packages/email/test/redirect.service.test.ts`:
- Add `environmentPosture` to the `@spinajs/configuration` import.
- In the doc comment of `TestConf` (line 25), replace `` `configuration.isProduction` `` with `` the env posture (`configuration.env`) ``. In the doc of `serviceWith`, replace `` `IsProduction` and `Configuration` `` with `` `EnvPosture` and `Configuration` ``, and replace `` in `@Config('configuration.isProduction')` `` with `` in the posture path ``.
- Replace `serviceWith` (lines 64-80) with:

```ts
/** `env`: the app env as --env names it; null: none named. */
function serviceWith(env: string | null, redirectTo?: string[]) {
  const options = { name: 'test', service: 'CapturingSender', redirectTo };

  cfg.set('configuration.env', environmentPosture({ env }));
  cfg.set('email.connections', [options]);

  const sender = new CapturingSender(options);
  const service = new DefaultEmailService();

  (service as any).Senders = new Map([['test', sender]]);
  Object.defineProperty(service, 'Log', {
    value: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), trace: sinon.stub() },
    configurable: true,
  });
  (service as any).Queue = { emit: sinon.stub().resolves() };

  return { service, sender };
}
```

- Every `serviceWith(false, …)` becomes `serviceWith('development', …)`, and every `serviceWith(true, …)` becomes `serviceWith('production', …)`. In the production test, the comment of lines 105-108 becomes: `// Which env names count as production is not this package's business: it asks the posture of @spinajs/configuration (test/environment-posture.test.ts there).`
- Add inside `describe('DefaultEmailService recipient redirect')`:

```ts
  it('refuses to redirect when no app env is named', async () => {
    const { service, sender } = serviceWith(null, ['dev-inbox@screennetwork.pl']);

    await service.send(anEmail());

    expect(sender.Captured!.to).to.deep.equal(['client@acme.com']);
  });

  it('refuses to redirect when the configuration has no posture', async () => {
    const { service, sender } = serviceWith('development', ['dev-inbox@screennetwork.pl']);
    cfg.set('configuration.env', undefined);

    await service.send(anEmail());

    expect(sender.Captured!.to).to.deep.equal(['client@acme.com']);
  });

  it('redirects on staging', async () => {
    const { service, sender } = serviceWith('staging', ['dev-inbox@screennetwork.pl']);

    await service.send(anEmail());

    expect(sender.Captured!.to).to.deep.equal(['dev-inbox@screennetwork.pl']);
  });

  it('logs an error at startup when a connection configures a redirect and no app env is named', async () => {
    const { service } = serviceWith(null, ['dev-inbox@screennetwork.pl']);

    await service.resolve();

    expect(((service as any).Log.error as sinon.SinonStub).calledOnce).to.equal(true);
  });
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/email && npx ts-mocha -p tsconfig.json test/redirect.service.test.ts`
Expected: FAIL. `refuses to redirect when no app env is named`: `expected [ 'dev-inbox@screennetwork.pl' ] to deeply equal [ 'client@acme.com' ]`. `refuses to redirect … no posture`: the same. `refuses to redirect on production`: the same, because the old code reads `configuration.isProduction` from the shipped flags. `logs an error at startup … no app env`: `expected false to equal true`.

- [ ] **Step 3: Implement**

In `packages/email/src/index.ts`, replace line 4 with `import { Config, ENVIRONMENT_POSTURE_PATH, isProductionPosture, registerConfigurationSchema } from '@spinajs/configuration';`. Replace lines 37-49 (both doc blocks and the field):

```ts
  /** Redirection is refused in production and when no app env is named (configuration.env); staging may redirect. */
  @Config(ENVIRONMENT_POSTURE_PATH)
  protected EnvPosture: unknown;
```

Line 60 `if (!this.IsProduction) {` becomes `if (!isProductionPosture(this.EnvPosture)) {`. Line 101's comment begins `// Production, or an unnamed env, never redirects, whatever …`. Line 105 becomes:

```ts
    const target = isProductionPosture(this.EnvPosture) ? undefined : this.Senders.get(connection)!.Options.redirectTo;
```

In `packages/email/src/redirect.ts`, replace lines 3-11:

```ts
/**
 * Recipient redirection is refused in production and when no app env is named, whatever a connection configures.
 * DefaultEmailService decides that from `configuration.env`, the posture @spinajs/configuration writes after loading.
 */
```

In `packages/email/src/interfaces.ts`, line 276 becomes ` * Refused outright in production and when no app env is named (\`configuration.env\`).`

In `packages/email/test/capture.ts`, add `import { environmentPosture } from '@spinajs/configuration';` and replace line 72:

```ts
  Object.defineProperty(service, 'EnvPosture', { value: environmentPosture({ env: 'development' }), configurable: true });
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/email && npx ts-mocha -p tsconfig.json test/redirect.service.test.ts && npm test`
Expected: PASS, all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/email/src/index.ts packages/email/src/redirect.ts packages/email/src/interfaces.ts packages/email/test/capture.ts packages/email/test/redirect.service.test.ts
git diff --cached --stat
git commit -m "fix(email): no recipient redirection in production or without a named app env"
```

---

### Task 6: The 2.x RbacMiddleware refuses the public cookie secret unless relaxed

**Files:**
- Modify: `packages/authn-http/src/middlewares.ts:5,22-23,45-56`
- Test: `packages/authn-http/test/rbac-middleware.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `ENVIRONMENT_POSTURE_PATH`, `isSecurityRelaxed`, `environmentPosture`.
- Produces: `RbacMiddleware.EnvPosture` (`@Config(ENVIRONMENT_POSTURE_PATH)`).

- [ ] **Step 1: Write the failing test**

Add `import { environmentPosture } from '@spinajs/configuration';` to `packages/authn-http/test/rbac-middleware.test.ts` and append:

```ts
describe('RbacMiddleware and the public cookie secret', () => {
  const PUBLIC = '1234adreewD';

  function build(posture: unknown) {
    const mw = new RbacMiddleware();
    const warn = sinon.spy();
    Object.defineProperty(mw, 'CoockieSecret', { value: PUBLIC, configurable: true, writable: true });
    Object.defineProperty(mw, 'EnvPosture', { value: posture, configurable: true, writable: true });
    Object.defineProperty(mw, 'Log', { value: { warn }, configurable: true });
    return { mw, warn };
  }

  async function failure(p: Promise<unknown>): Promise<Error | undefined> {
    try {
      await p;
    } catch (e) {
      return e as Error;
    }
    return undefined;
  }

  it('refuses to start in production, on staging, on APP_ENV prod without NODE_ENV, without a named env and without a posture', async () => {
    for (const posture of [environmentPosture({ env: 'production' }), environmentPosture({ env: 'staging' }), environmentPosture({ env: 'prod' }), environmentPosture({}), undefined]) {
      const e = await failure(build(posture).mw.resolve());
      expect(e?.message, JSON.stringify(posture)).to.contain('public default');
    }
  });

  it('only warns in development and test', async () => {
    for (const env of ['development', 'test']) {
      const { mw, warn } = build(environmentPosture({ env }));
      expect(await failure(mw.resolve()), env).to.eq(undefined);
      expect(warn.calledOnce, env).to.eq(true);
    }
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/rbac-middleware.test.ts`
Expected: FAIL in `refuses to start …`: `expected undefined to include 'public default'`. NODE_ENV is unset in the test process, so the old check only warns.

- [ ] **Step 3: Implement**

In `packages/authn-http/src/middlewares.ts`, replace line 5 with `import { Config, ENVIRONMENT_POSTURE_PATH, isSecurityRelaxed } from '@spinajs/configuration';`. After the `SessionCookieConfig` field (line 26) add:

```ts
  @Config(ENVIRONMENT_POSTURE_PATH)
  protected EnvPosture: unknown;
```

Replace lines 48-53:

```ts
      // Fatal unless the app env is named development or test, where tests and local development legitimately run on
      // the packaged default; refusing there would only teach people to delete the check.
      if (!isSecurityRelaxed(this.EnvPosture)) {
        throw new Error(message);
      }
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/rbac-middleware.test.ts && npm test`
Expected: PASS, all passing. If a 2.x suite boots `RbacMiddleware` on the public secret without an env, give its configuration a relaxed env: `this.Env = 'test'` in its `FrameworkConfiguration` subclass, or `http.cookie.secret` of its own. Do not weaken the check.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-http/src/middlewares.ts packages/authn-http/test/rbac-middleware.test.ts
git diff --cached --stat
git commit -m "fix(authn-http): the 2.x session middleware refuses the public cookie secret unless the app env is named development or test"
```

---

### Task 7: authn delegates to the shared rule; check-config reports requireExplicitEnv; docs

**Files:**
- Modify: `packages/authn/src/service/boot/env.ts:2,10-11,31-35`
- Modify: `packages/authn/src/service/boot/check-config.ts:2,38`
- Modify: `packages/authn-oidc/src/support.ts:1,7-11`
- Modify: `docs/authn/README.md:258-266,268-270,645-648`
- Test: `packages/authn/test/boot/check-config.test.ts` (in `describe('env (SR-16 residual)')`), `packages/authn-oidc/test/sr16-env.test.ts`

**Interfaces:**
- Consumes: `isRelaxedEnvironmentName`, `REQUIRE_EXPLICIT_ENV_PATH` from `@spinajs/configuration`. Task 2's `InvalidConfiguration` with path `configuration.requireExplicitEnv`.
- Produces: `isLenientAuthnEnv` and `isRelaxedEnv` keep their signatures. A `requireExplicitEnv` refusal is reported as `{ topic: 'env', level: 'error' }`.

- [ ] **Step 1: Write the failing tests**

In `packages/authn/test/boot/check-config.test.ts`, inside `describe('env (SR-16 residual)')`, add:

```ts
    it('reports configuration.requireExplicitEnv refusing a boot without an env under topic env', async () => {
      const child = DI.RootContainer.child();
      children.push(child);
      child.register(configurationOf({ ...sound(), configuration: { requireExplicitEnv: true } }, undefined, true)).as(Configuration);
      const f = await checkAuthnConfig(child);
      expect(topics(f)).to.deep.eq(['env:error']);
      expect(f[0].message).to.contain('configuration.requireExplicitEnv');
    });
```

In `packages/authn-oidc/test/sr16-env.test.ts`, add `import { isRelaxedEnvironmentName } from '@spinajs/configuration';` and `import { isRelaxedEnv } from '../src/support.js';`, and add inside the describe:

```ts
  it('isRelaxedEnv is the shared rule of @spinajs/configuration', () => {
    for (const env of ['development', 'dev', 'test', 'production', 'staging', 'local', 'Development', '', null, undefined]) {
      expect(isRelaxedEnv(env), String(env)).to.eq(isRelaxedEnvironmentName(env));
    }
  });
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/boot/check-config.test.ts`
Expected: FAIL: `expected [ 'schema:error' ] to deeply equal [ 'env:error' ]`.

The authn-oidc case pins equivalence. It passes before and after, because the delegation is a pure refactor.

- [ ] **Step 3: Implement**

`packages/authn/src/service/boot/env.ts`:
- line 2: `import { isRelaxedEnvironmentName } from '@spinajs/configuration';`
- line 11:

```ts
export const AUTHN_ENV_FALLBACK_WARNING = 'No app env is set (--env, APP_ENV or NODE_ENV): the configuration fell back to "development" files, but authn and every other security check are strict, as in production; name the env, or set configuration.requireExplicitEnv to refuse to boot without one';
```

- lines 31-35:

```ts
/** Only development and test relax the secret checks; any other env, an absent one included, is strict (@spinajs/configuration's rule). */
export function isLenientAuthnEnv(env: string | undefined): boolean {
  return isRelaxedEnvironmentName(env);
}
```

`packages/authn/src/service/boot/check-config.ts`:
- line 2: `import { Configuration, FrameworkConfiguration, InvalidConfiguration, REQUIRE_EXPLICIT_ENV_PATH } from '@spinajs/configuration';`
- line 38:

```ts
const schemaFindings = (e: InvalidConfiguration): AuthnConfigFinding[] =>
  e.violations.map((v) => ({ topic: v.path === REQUIRE_EXPLICIT_ENV_PATH ? 'env' : 'schema', level: 'error', message: `${v.path} ${v.message}` }));
```

`packages/authn-oidc/src/support.ts`:
- line 1: `import { isRelaxedEnvironmentName } from '@spinajs/configuration-common';`
- lines 7-11:

```ts
/** Development and test relax https and cookie flags; an absent or unknown env is production. */
export function isRelaxedEnv(env: string | null | undefined): boolean {
  return isRelaxedEnvironmentName(env);
}
```

`docs/authn/README.md` (CRLF file):
- Replace lines 258-262 (the paragraph that begins `**With no app env set, the code resolves to development**`) with:

```markdown
  **With no app env set, config files load as development, but every security decision is strict**, as
  in production: the cookie gets `Secure` and the `__Host-` prefix, and the public cookie secret is
  refused (SR-16, `packages/authn/src/service/boot/env.ts`). Outside authn the same rule is the
  `configuration.env` posture of `@spinajs/configuration` (explain route, error detail, mail redirection).
  Set `APP_ENV` or `NODE_ENV` in every deployment; `configuration.requireExplicitEnv: true` makes a
  missing one fatal.
```

- Replace lines 264-266 (the TODO(N8a) block, whose env rule has landed) with:

```markdown
> **TODO(N8a):** the session middleware, cookie issue and clear on the HTTP routes, and the `Ip` and
> `UserAgent` entries it writes.
```

- Delete the stale TODO(C1) block (lines 268-270) and the blank line before it, because `packages/users/src/config/users.ts` ships no cookie key.
- Keep line 645. Replace lines 646-648 (`boot refuses …` through `… a missing env will mean production).`) with:

```markdown
boot refuses a public or missing value for the cookie secret outside development and test (A24). With
no app env set, the env counts as production for this refusal; set `configuration.requireExplicitEnv`
to refuse a boot without one.
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/boot/check-config.test.ts test/boot/secrets.test.ts && npm test`
Expected: PASS, all passing.

Run: `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`, then `cd packages/authn-oidc && npx ts-mocha -p tsconfig.json test/sr16-env.test.ts`, then `cd packages/authn-session && npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/service/boot/env.ts packages/authn/src/service/boot/check-config.ts packages/authn-oidc/src/support.ts packages/authn/test/boot/check-config.test.ts packages/authn-oidc/test/sr16-env.test.ts docs/authn/README.md
git diff --cached --stat
git commit -m "refactor(authn, authn-oidc): the shared relaxed-env rule; check-config reports configuration.requireExplicitEnv under env"
```

---

## Self-review

- **Spec coverage.** Shared helper: Task 1. Boot failure `requireExplicitEnv` and the decision to make it opt-in: Task 2 and Decision 5. Config files still fall back to development: Task 2 test "without any env". Authz explain and trace: Task 3. Legacy middleware secret check: Task 6. HTTP error details: Task 4, which adds socket detail too. Email redirect: Task 5. authn-check-config reporting: Task 7. Every call site has a test. The brief named `packages/users/src`, but nothing there reads the env (Facts).
- **Placeholder scan.** Every code step has full code. The two "if a suite … do this" notes (Task 2 Step 4, Task 6 Step 4) name the exact fix.
- **Type consistency.** `ENVIRONMENT_POSTURE_PATH`, `isSecurityRelaxed`, `isProductionPosture`, `environmentPosture`, `isRelaxedEnvironmentName` and `REQUIRE_EXPLICIT_ENV_PATH` are defined in Task 1 and used with the same names in Tasks 2-7. Each `EnvPosture` field is `unknown` everywhere.
