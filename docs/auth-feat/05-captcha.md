# CAPTCHA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-flow CAPTCHA gate ('off' | 'always' | 'adaptive') that stops distributed credential stuffing on login and email pumping on the reset request, with Cloudflare Turnstile and self-hosted ALTCHA as providers, and a fixed seam that plans 06–08 call for 'verify', 'register' and 'code'.

**Architecture:** `@spinajs/authn` owns the `CaptchaGate` contract (as the README fixes it), a `CaptchaProvider` contract and `DefaultCaptchaGate`, which reads `authn.captcha` and counts requests per flow and per ip in a sliding window for the adaptive mode. The new package `@spinajs/authn-captcha` ships `TurnstileCaptchaProvider` and `AltchaCaptchaProvider`. The 3.0 HTTP layer (`packages/authn-http/src/v3`) runs the gate before any account lookup through one helper, `captchaRefusal`, on `POST /auth/login` and on the reset request, and serves `GET /auth/captcha` and `GET /auth/captcha/challenge`.

**Tech Stack:** TypeScript (node16 modules, ESM + CJS builds), `@spinajs/di`, `@spinajs/configuration` (`@Config`, AJV schema), mocha + ts-mocha, `node:crypto`, global `fetch` (Node 18+; the repo runs Node 24).

## Global Constraints

- Code comments, identifiers and commit messages are in English. Comment only what the code cannot say.
- Work on branch `authz-v3-refactor`, one commit per task, and run the package suites before each commit.
- Every test command runs from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A package that consumes a changed package reads it from `lib/`. Rebuild before testing dependents: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in the changed package.
- Working-copy files use CRLF. Keep them CRLF.
- A value check moves into the module's JSON schema. Code keeps only checks a schema cannot make (DI lookups, compiling a value, cross-domain merges).
- Defaults move into the schema (`default`, applied by `useDefaults`).
- Secrets are secret references, never inline values.
- Each new behaviour rule gets a row in `packages/authn-testing`, continuing the A-series. The last existing rule is A32; this plan takes A33 (if another plan took A33 first, use the next free id everywhere Task 7 says A33).
- HTTP work targets the 3.0 layer (`packages/authn-http/src/v3`), never the 2.x controllers (see Decision 5 for the one exception).
- Message IDs: this plan owns 1003000–1003999 (info) and 4003000–4003999 (user errors). Audit: this plan adds `captcha.fail` to `AuthnEventType`.
- Mechanism notes (`.superpowers/sdd/mechanism-notes.md`) are binding: test isolation in child containers of `DI.RootContainer`, never `DI.clear()`; `@Config` getters read live; an instance built with `new` needs `pinConfiguration`; violation paths are full configuration paths; stage only your own hunks (`git diff --cached` before each commit).

---

## Current state

- No CAPTCHA exists: `grep -rli captcha packages/*/src` finds nothing.
- The throttle counts per key kind: `account` (`login:<login string>`), `account-ip`, `ip`, and an optional `global` key that is off by default (`packages/authn/src/contracts/throttle.ts:3-43`, `packages/authn/src/service/default-authn-service.ts:533-555`). A key gates only once its counted attempts reach `free` (`backoffDelayMs`, `throttle.ts:59-62`; login defaults: account 5, ip 20, `throttle.ts:50-57`). A botnet that sends one attempt per account per ip never reaches `free` on any key.
- `PeekableThrottle.peek` answers only whether a backoff delay holds a key *now* (`packages/authn/src/throttle/peek.ts:4-15`), not whether its count reached `free`; once the delay has elapsed it answers `allowed` again.
- The 3.0 layer has one password-guessing entry: `POST /auth/login` (`packages/authn-http/src/v3/controllers/AuthnLoginController.ts:33-60`). It has no password-reset routes; the reset request is served by the 2.x `PasswordResetController` (`packages/authn-http/src/account/controllers/PasswordResetController.ts:63-77`), which N8c keeps scanned (`packages/authn-http/test/v3/route-table-n8c.test.ts:62-63`).
- Single-use values have a store: `NonceStore` with `MemoryNonceStore` and `DbNonceStore` (table `authn_nonce`) in `@spinajs/authn-orm` (`packages/authn-orm/src/nonces/nonce-store.ts:24-97`).
- Plan 03 (message IDs) has not landed: `packages/authn/src/messages/` does not exist. Task 8 is gated on it.
- Another session has uncommitted changes in `packages/authn/src/throttle/*`, `packages/authn/src/contracts/throttle.ts` and `packages/authn-orm/src/throttle/*` (git status). This plan touches none of them.

## Decisions (confirm before Task 1)

1. **The gate runs in the 3.0 HTTP layer, not in `DefaultAuthnService`.** One helper, `captchaRefusal(container, req, flow, account?)` in `packages/authn-http/src/v3/captcha.ts`, runs before `authenticate()` and before any lookup. Why not the service with `AuthnContext.captcha` (the brief's suggestion):
   - A CAPTCHA is solved by a browser. The service's other callers (`reauthenticate`, MFA completion, impersonation with password, CLI, `users` actions with `actionContext()` at `packages/users/src/actions.ts:886`) have no widget, and each would need an exemption.
   - The service path needs a new `AuthnFailure` member (`credentials.ts:74`), which A02's "one shape for all failures" would then have to except, and a new `PasswordResetRequestResult` variant (`password.ts:32`). The HTTP path changes no core result type.
   - Plans 07 and 08 add 3.0 routes anyway; they call the same helper.
   - Cost: an app with its own HTTP login route must call the gate itself. Documented in `CaptchaGate`'s doc comment.
2. **Adaptive signal: request rate per flow, all clients and per ip, counted by `required()`, in memory.** A sliding window of two fixed buckets (O(1) per key). `required()` counts before any lookup, and nothing is keyed by account, so the decision cannot differ between an existing and an unknown account. Rejected alternatives:
   - Failure rate from audit events: the gate would need its own `AuthnEventSink`, which changes `AuthnAudit`'s sink list for every app, and reset-request events are published by deferred work after the answer (`packages/authn-local/src/service.ts:189-199, 300-311`).
   - Throttle state: `peek` does not tell "reached free" (see Current state); a new throttle method would touch files another session is changing, and it would not catch the distributed attack anyway, since that attack stays under `free` on every key.
   - A per-account (login string) counter: it would let anyone force a challenge onto a victim's login, and the account throttle already covers a targeted account.
   - Trade-off: counters live per app instance, so thresholds are per instance. A shared counter (database or Redis) is out of scope.
3. **Providers shipped first: Turnstile and ALTCHA.** Turnstile covers the hosted case and enforces single use itself (`timeout-or-duplicate`). ALTCHA (proof of work, no third party, nothing to declare under GDPR) uses `NonceStore` for single use. hCaptcha is deferred: its siteverify has the same shape as Turnstile's (one small task when someone needs it).
4. **Provider failure fails closed by default.** `authn.captcha.failOpen: false`, `authn.captcha.timeoutMs: 5000`. A missing or unknown provider name is a setup error and never fails open.
5. **The reset request is guarded in the 2.x `PasswordResetController`.** This is the controller that serves `POST /auth/password/reset-request` after N8c too (it is not in N8c's replaced list, `route-table-n8c.test.ts:14,62-63`). Building 3.0 password routes is out of scope. This is the one exception to "never the 2.x controllers": this controller is not replaced.
6. **The answer when a challenge is required:** HTTP 400, `Cache-Control: no-store`, body `{ error: { code: 'E_CAPTCHA_REQUIRED' | 'E_CAPTCHA_INVALID', message }, messages: [<4003001 | 4003002>, <1003001 with context { provider, siteKey?, challenge }>] }`. The message objects use plan 03's `AuthnMessage` shape; Task 8 checks that shape first.
7. **`@spinajs/authn-captcha` depends on `@spinajs/authn-orm`** for `NonceStore`, as `@spinajs/authn-oidc` does (`packages/authn-oidc/src/providers.ts:5,50`).
8. **Behaviour rule A33 has a core facet only.** The HTTP behaviour is covered by the v3-app suite of Task 8.

## Security notes

- The gate decides before any account lookup and never reads the account, so neither the decision nor the answer tells accounts apart (A02). Missing and wrong tokens get different messages; both are independent of the account.
- Tokens never reach an event or a log. `captcha.fail` carries `flow`, the reason (`missing` | `invalid` | `provider_error`) and a detail that must match `^[A-Za-z0-9_-]{1,64}$` (a provider reason or an error class).
- Tokens longer than 4096 characters are refused before the provider sees them.
- Behind a proxy, `ClientIp` must come from `authn.http.trustProxy`. Otherwise every client shares the proxy's ip and `ipThreshold` trips for all of them.
- Under attack, every refused request publishes one `captcha.fail`, the same volume as login failures today.
- ALTCHA: an HMAC key of at least 32 characters (a secret reference), the expiry inside the signed salt, single use through `NonceStore`. `DbNonceStore` is needed when several instances run. Proof of work slows a botnet; it does not stop one with large compute.
- Turnstile: the secret goes only to `challenges.cloudflare.com` over https, with no redirects followed and a timeout. `client()` returns only the public site key.
- CAPTCHA does not replace the throttle. Both run, CAPTCHA first: a refused request is never counted in the throttle, so missing tokens cannot burn an account's free attempts.

## Integration for plans 06, 07 and 08

A 3.0 route that a CAPTCHA guards calls, after its input bounds checks and before any lookup, issue or send:

```ts
import { captchaRefusal } from '../captcha.js'; // packages/authn-http/src/v3/captcha.ts

const refusal = await captchaRefusal(this.Container, req, 'register', email);
if (refusal) return refusal;
```

- Flows: 07 registration `'register'` (account: the submitted email), 08 code request `'code'` (account: the submitted address), 06 resend of a verification code `'verify'`.
- Call it once per request: in adaptive mode each call counts one request.
- Programmatic paths (admin, CLI, `users` actions) never call it.
- `GET /auth/captcha` already lists every flow's mode; no change is needed when a flow gets its route.

---

## File structure

| File | Task | Responsibility |
|---|---|---|
| `packages/authn/src/contracts/captcha.ts` (new) | 1 | `CaptchaFlow`, `CAPTCHA_FLOWS`, `CaptchaGate` (README contract), `CaptchaProvider`, `CaptchaClientInfo`, `CaptchaVerdict` |
| `packages/authn/src/contracts/index.ts`, `contracts/audit.ts` | 1 | export; `captcha.fail` |
| `packages/authn/src/schemas/authn.configuration.ts` | 2 | `authn.captcha` block |
| `packages/authn/src/captcha/pressure.ts` (new) | 3 | `SlidingCount`, `CaptchaPressure`, `CaptchaAdaptive` |
| `packages/authn/src/captcha/settings.ts`, `provider.ts`, `default-captcha-gate.ts`, `index.ts` (new) | 4 | settings types, provider selection, the gate |
| `packages/authn-captcha/**` (new package) | 5, 6 | schema, bootstrapper, `TurnstileCaptchaProvider`, `AltchaCaptchaProvider` |
| `packages/authn-testing/src/fakes/captcha.ts` (new), `harness/ports.ts`, `harness/config.ts`, `behaviour/types.ts`, `behaviour/A33-captcha.spec.ts` (new), `behaviour/index.ts` | 7 | stub provider, captcha port, rule A33 |
| `packages/authn/test/behaviour/harness.ts`, `core.test.ts` | 7 | the core lane runs A33 |
| `packages/authn/src/messages/captcha.ts` (new) | 8 | messages 1003001, 4003001, 4003002 |
| `packages/authn-http/src/v3/captcha.ts` (new), `v3/controllers/AuthnCaptchaController.ts` (new), `v3/controllers/AuthnLoginController.ts` | 8 | helper, endpoints, login wiring |
| `packages/authn-http/src/account/controllers/PasswordResetController.ts` | 9 | reset-request wiring |

Task order: 1 → 2 → 3 → 4 → (5 → 6) → 7 → 8 → 9. Tasks 5–6 need only Tasks 1–2; Task 7 needs 4; Task 8 needs 7 and plan 03; Task 9 needs 8.

---

### Task 1: CAPTCHA contracts and the `captcha.fail` event

**Files:**
- Create: `packages/authn/src/contracts/captcha.ts`
- Modify: `packages/authn/src/contracts/index.ts:19` (append an export)
- Modify: `packages/authn/src/contracts/audit.ts:21` (append a union member)
- Create: `packages/authn/test/contracts/captcha.test.ts`
- Modify: `packages/authn/test/contracts/audit.test.ts:23` (`EVENT_TYPES`)
- Modify: `packages/authn/test/contracts/boundary.test.ts:18` (`RUNTIME_EXPORTS`)

**Interfaces:**
- Consumes: nothing.
- Produces (from `@spinajs/authn/contracts`):
  - `type CaptchaFlow = 'login' | 'register' | 'reset' | 'code' | 'verify'`
  - `const CAPTCHA_FLOWS: readonly CaptchaFlow[]`
  - `abstract class CaptchaGate { required(flow, ctx: { readonly ip?: string; readonly account?: string }): Promise<boolean>; verify(flow, token: string | undefined, ctx: { readonly ip?: string }): Promise<boolean> }`
  - `interface CaptchaClientInfo { readonly provider: string; readonly siteKey?: string }`
  - `interface CaptchaVerdict { readonly ok: boolean; readonly reason?: string }`
  - `abstract class CaptchaProvider { verify(token: string, ip?: string): Promise<CaptchaVerdict>; client(): CaptchaClientInfo; challenge?(): Promise<Readonly<Record<string, unknown>>> }`
  - `AuthnEventType` gains `'captcha.fail'`.

- [ ] **Step 1: Write the failing test**

Create `packages/authn/test/contracts/captcha.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { CAPTCHA_FLOWS, CaptchaGate, CaptchaProvider } from '../../src/contracts/captcha.js';
import type { CaptchaClientInfo, CaptchaFlow, CaptchaVerdict } from '../../src/contracts/captcha.js';
import * as index from '../../src/contracts/index.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

class TokenGate extends CaptchaGate {
  async required(): Promise<boolean> {
    return true;
  }
  async verify(_flow: CaptchaFlow, token: string | undefined): Promise<boolean> {
    return token === 'ok';
  }
}

class EchoProvider extends CaptchaProvider {
  async verify(token: string): Promise<CaptchaVerdict> {
    return token === 'ok' ? { ok: true } : { ok: false, reason: 'wrong' };
  }
  client(): CaptchaClientInfo {
    return { provider: 'echo', siteKey: 'site' };
  }
}

describe('captcha contracts', () => {
  it('CaptchaFlow is exactly the five README flows, listed in CAPTCHA_FLOWS', () => {
    same<CaptchaFlow, 'login' | 'register' | 'reset' | 'code' | 'verify'>(true);
    expect([...CAPTCHA_FLOWS]).to.deep.eq(['login', 'register', 'reset', 'code', 'verify']);
    expect(Object.isFrozen(CAPTCHA_FLOWS)).to.eq(true);
  });

  it('CaptchaGate takes the README signatures', async () => {
    same<Parameters<CaptchaGate['required']>[1], { readonly ip?: string; readonly account?: string }>(true);
    same<Parameters<CaptchaGate['verify']>[1], string | undefined>(true);
    same<Parameters<CaptchaGate['verify']>[2], { readonly ip?: string }>(true);
    const gate: CaptchaGate = new TokenGate();
    expect(await gate.required('login', { ip: '192.0.2.1', account: 'a' })).to.eq(true);
    expect(await gate.verify('reset', undefined, {})).to.eq(false);
  });

  it('a provider without challenge() is a hosted widget', async () => {
    const p: CaptchaProvider = new EchoProvider();
    expect(p.challenge).to.eq(undefined);
    expect(await p.verify('ok')).to.deep.eq({ ok: true });
    expect(p.client()).to.deep.eq({ provider: 'echo', siteKey: 'site' });
  });

  it('the contracts index re-exports them', () => {
    expect(index.CaptchaGate).to.eq(CaptchaGate);
    expect(index.CaptchaProvider).to.eq(CaptchaProvider);
    expect(index.CAPTCHA_FLOWS).to.eq(CAPTCHA_FLOWS);
    same<index.CaptchaFlow, CaptchaFlow>(true);
  });
});
```

In `packages/authn/test/contracts/audit.test.ts:23`, append `'captcha.fail'` as the last member of `EVENT_TYPES`:

```ts
const EVENT_TYPES = ['login', 'logout', 'mfa.challenge', 'mfa.verify', 'mfa.enrol', 'mfa.disable', 'reauth', 'session.issue', 'session.rotate', 'session.revoke', 'session.expire', 'password.change', 'password.reset.request', 'password.reset', 'invite.redeem', 'token.create', 'token.use', 'token.revoke', 'key.register', 'key.use', 'key.revoke', 'identity.link', 'identity.unlink', 'impersonation.start', 'impersonation.end', 'impersonation.expire', 'throttle.block', 'captcha.fail'] as const;
```

In `packages/authn/test/contracts/boundary.test.ts:18`, append `'CaptchaGate', 'CaptchaProvider', 'CAPTCHA_FLOWS'` to the end of `RUNTIME_EXPORTS`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/captcha.test.ts test/contracts/audit.test.ts`
Expected: FAIL at compile time: `Cannot find module '../../src/contracts/captcha.js'`; with that file absent, audit.test.ts fails on `AuthnEventType lists the design members in the design order`.

- [ ] **Step 3: Implement**

Create `packages/authn/src/contracts/captcha.ts`:

```ts
/** The flows a CAPTCHA can guard: password guessing (login), sign-up (register) and the flows that send mail or SMS. */
export type CaptchaFlow = 'login' | 'register' | 'reset' | 'code' | 'verify';

export const CAPTCHA_FLOWS: readonly CaptchaFlow[] = Object.freeze(['login', 'register', 'reset', 'code', 'verify']);

/**
 * If no CaptchaGate is registered, CAPTCHA is off; consumers resolve it as optional. DefaultCaptchaGate is the core's.
 * Called by the 3.0 HTTP routes (authn-http `captchaRefusal`) once per request, before any account lookup: an app
 * with its own HTTP route for a guarded flow calls it the same way. Programmatic callers do not.
 */
export abstract class CaptchaGate {
  /** Whether this request must carry a solved challenge (config per flow: 'off' | 'always' | 'adaptive'). */
  abstract required(flow: CaptchaFlow, ctx: { readonly ip?: string; readonly account?: string }): Promise<boolean>;
  /** Verifies the client token with the provider; false on a wrong, reused or expired token. */
  abstract verify(flow: CaptchaFlow, token: string | undefined, ctx: { readonly ip?: string }): Promise<boolean>;
}

/** What a client needs to render the provider's widget; never a secret. */
export interface CaptchaClientInfo {
  /** The widget to render: 'turnstile', 'altcha', … */
  readonly provider: string;
  /** The public site key of a hosted widget. */
  readonly siteKey?: string;
}

export interface CaptchaVerdict {
  readonly ok: boolean;
  /** Why not; audit only. */
  readonly reason?: string;
}

/**
 * Checks solved challenges for DefaultCaptchaGate, which selects one by `authn.captcha.provider`.
 * TurnstileCaptchaProvider and AltchaCaptchaProvider ship in @spinajs/authn-captcha. A token verifies at most once.
 */
export abstract class CaptchaProvider {
  /** Rejects only when the provider cannot answer (network, timeout, 5xx); authn.captcha.failOpen decides then. */
  abstract verify(token: string, ip?: string): Promise<CaptchaVerdict>;
  abstract client(): CaptchaClientInfo;
  /** A self-hosted provider's new challenge, served by GET /auth/captcha/challenge. */
  challenge?(): Promise<Readonly<Record<string, unknown>>>;
}
```

Append to `packages/authn/src/contracts/index.ts` (after line 19):

```ts
export * from './captcha.js';
```

In `packages/authn/src/contracts/audit.ts:21`, append `| 'captcha.fail'` after `'throttle.block'`:

```ts
export type AuthnEventType = 'login' | 'logout' | 'mfa.challenge' | 'mfa.verify' | 'mfa.enrol' | 'mfa.disable' | 'reauth' | 'session.issue' | 'session.rotate' | 'session.revoke' | 'session.expire' | 'password.change' | 'password.reset.request' | 'password.reset' | 'invite.redeem' | 'token.create' | 'token.use' | 'token.revoke' | 'key.register' | 'key.use' | 'key.revoke' | 'identity.link' | 'identity.unlink' | 'impersonation.start' | 'impersonation.end' | 'impersonation.expire' | 'throttle.block' | 'captcha.fail';
```

- [ ] **Step 4: Run the tests, rebuild, run the boundary test and the suite**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/captcha.test.ts test/contracts/audit.test.ts` → PASS (captcha: 4 passing; audit: all passing).
2. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && cd ../.. && node scripts/generate-packages-for-modules.mjs && cd packages/authn`
3. `npx ts-mocha -p tsconfig.json test/contracts/boundary.test.ts` → PASS (the contracts still import only `@spinajs/di` and register nothing).
4. `npm test` in `packages/authn` → 0 failing.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/contracts/captcha.ts packages/authn/src/contracts/index.ts packages/authn/src/contracts/audit.ts packages/authn/test/contracts/captcha.test.ts packages/authn/test/contracts/audit.test.ts packages/authn/test/contracts/boundary.test.ts
git diff --cached --stat
git commit -m "feat(authn): CaptchaGate and CaptchaProvider contracts, captcha.fail event"
```

---

### Task 2: The `authn.captcha` schema block

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:61` (constants after `stringList`) and between lines 361 and 362 (the new block after `audit`, before `http`)
- Modify: `packages/authn/test/boot/config-defaults.test.ts:75`
- Create: `packages/authn/test/captcha/captcha-config.test.ts`

**Interfaces:**
- Consumes: `configuredChild`, `violationPaths` from `packages/authn/test/behaviour/harness.ts:122,151`.
- Produces: `authn.captcha` with defaults `{ flows: { login, register, reset, code, verify: 'off' }, adaptive: { windowSeconds: 60, threshold: 100, ipThreshold: 10, maxTrackedIps: 100000 }, timeoutMs: 5000, failOpen: false }`; `provider` (string) is required once a flow is not off. `authn.captcha.turnstile` and `authn.captcha.altcha` are left to `@spinajs/authn-captcha`'s schema.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn/test/captcha/captcha-config.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { Configuration } from '@spinajs/configuration';

import { configuredChild, violationPaths } from '../behaviour/harness.js';

const expect = chai.expect;

const boot = (captcha: Record<string, unknown>) => configuredChild({ authn: { captcha } }, 'test', true);

describe('authn.captcha schema', function () {
  this.timeout(30000);

  it('fills every flow off and the adaptive limits when authn.captcha is unset', async () => {
    const child = await configuredChild({}, 'test', true);
    try {
      expect(child.get(Configuration)!.get('authn.captcha')).to.deep.eq({
        flows: { login: 'off', register: 'off', reset: 'off', code: 'off', verify: 'off' },
        adaptive: { windowSeconds: 60, threshold: 100, ipThreshold: 10, maxTrackedIps: 100000 },
        timeoutMs: 5000,
        failOpen: false,
      });
    } finally {
      await child.dispose();
    }
  });

  it('takes a provider and a mode per flow', async () => {
    const child = await boot({ provider: 'TurnstileCaptchaProvider', flows: { login: 'adaptive', reset: 'always' } });
    try {
      const c = child.get(Configuration)!;
      expect(c.get('authn.captcha.flows')).to.deep.eq({ login: 'adaptive', register: 'off', reset: 'always', code: 'off', verify: 'off' });
      expect(c.get('authn.captcha.provider')).to.eq('TurnstileCaptchaProvider');
    } finally {
      await child.dispose();
    }
  });

  it('refuses an unknown mode and an unknown flow, naming the path', async () => {
    expect(await violationPaths(boot({ provider: 'P', flows: { login: 'sometimes' } }))).to.include('authn.captcha.flows.login');
    expect(await violationPaths(boot({ flows: { signup: 'always' } }))).to.include('authn.captcha.flows.signup');
  });

  it('needs a provider once a flow is not off', async () => {
    for (const mode of ['always', 'adaptive']) {
      expect(await violationPaths(boot({ flows: { reset: mode } })), mode).to.include('authn.captcha.provider');
    }
  });

  it('bounds the adaptive window, the thresholds and the provider timeout', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ adaptive: { windowSeconds: 9 } }, 'authn.captcha.adaptive.windowSeconds'],
      [{ adaptive: { windowSeconds: 3601 } }, 'authn.captcha.adaptive.windowSeconds'],
      [{ adaptive: { threshold: 0 } }, 'authn.captcha.adaptive.threshold'],
      [{ adaptive: { ipThreshold: 0 } }, 'authn.captcha.adaptive.ipThreshold'],
      [{ adaptive: { maxTrackedIps: 999 } }, 'authn.captcha.adaptive.maxTrackedIps'],
      [{ adaptive: { burst: 1 } }, 'authn.captcha.adaptive.burst'],
      [{ timeoutMs: 99 }, 'authn.captcha.timeoutMs'],
      [{ timeoutMs: 30001 }, 'authn.captcha.timeoutMs'],
    ];
    for (const [captcha, path] of cases) expect(await violationPaths(boot(captcha)), path).to.include(path);
  });
});
```

In `packages/authn/test/boot/config-defaults.test.ts:75` the defaults now include the captcha block; replace the line with:

```ts
    expect(r.config).to.deep.eq({ ...clone(authn), mfa: { ...clone(authn.mfa), steps: [], totp: check({}).config.mfa.totp }, throttle: { ...clone(authn.throttle), maxRows: DEFAULT_THROTTLE_MAX_ROWS }, token: check({}).config.token, jwt: { issuers: [] }, captcha: check({}).config.captcha });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/captcha/captcha-config.test.ts test/boot/config-defaults.test.ts`
Expected: FAIL. The first case: `expected undefined to deeply equal { flows: … }`; the violation cases: `expected the boot to fail with InvalidConfiguration`; config-defaults `passes the schema unchanged`: the expected object has `captcha: undefined`.

- [ ] **Step 3: Implement**

In `packages/authn/src/schemas/authn.configuration.ts`, after line 61 (`const stringList = …`), add:

```ts
const CAPTCHA_FLOW_NAMES = ['login', 'register', 'reset', 'code', 'verify'];

const CAPTCHA_MODE = { type: 'string', enum: ['off', 'always', 'adaptive'], default: 'off' };
```

Between the end of the `audit` block (line 361, `    },`) and `    http: {` (line 362), add:

```ts
    captcha: {
      type: 'object',
      default: {},
      description: "CAPTCHA per flow (DefaultCaptchaGate). authn.captcha.turnstile and authn.captcha.altcha are validated by @spinajs/authn-captcha's schema.",
      properties: {
        provider: { type: 'string', minLength: 1, description: 'The CaptchaProvider service, e.g. TurnstileCaptchaProvider or AltchaCaptchaProvider (@spinajs/authn-captcha). Required once a flow is not off.' },
        flows: {
          type: 'object',
          default: {},
          propertyNames: { enum: CAPTCHA_FLOW_NAMES },
          properties: Object.fromEntries(CAPTCHA_FLOW_NAMES.map((f) => [f, CAPTCHA_MODE])),
        },
        adaptive: {
          type: 'object',
          default: {},
          propertyNames: { enum: ['windowSeconds', 'threshold', 'ipThreshold', 'maxTrackedIps'] },
          properties: {
            windowSeconds: { type: 'integer', minimum: 10, maximum: 3600, default: 60, description: 'The sliding window requests are counted in.' },
            threshold: { type: 'integer', minimum: 1, default: 100, description: 'Requests of a flow per window, all clients together, above which every request of the flow needs a challenge. Counted per app instance.' },
            ipThreshold: { type: 'integer', minimum: 1, default: 10, description: 'Requests of a flow per window from one ip above which that ip needs a challenge.' },
            maxTrackedIps: { type: 'integer', minimum: 1000, maximum: 10000000, default: 100000, description: 'Ips counted at once per instance; the least recently seen goes first.' },
          },
        },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 30000, default: 5000, description: 'How long a provider may take to verify a token.' },
        failOpen: { type: 'boolean', default: false, description: 'true: a provider that cannot answer lets the request through. Default: refused as a wrong token.' },
      },
      allOf: [
        // A flow that asks for challenges needs a provider to check them.
        {
          if: { type: 'object', required: ['flows'], properties: { flows: { type: 'object', anyOf: CAPTCHA_FLOW_NAMES.map((f) => ({ type: 'object', required: [f], properties: { [f]: { type: 'string', enum: ['always', 'adaptive'] } } })) } } },
          then: { required: ['provider'] },
        },
      ],
    },
```

- [ ] **Step 4: Run the tests and the suite**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/captcha/captcha-config.test.ts test/boot/config-defaults.test.ts` → PASS (captcha-config: 5 passing).
2. `npm test` in `packages/authn` → 0 failing. `coerceTypes` cannot turn `'sometimes'` into a listed mode, so no case changes.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/test/captcha/captcha-config.test.ts packages/authn/test/boot/config-defaults.test.ts
git diff --cached --stat
git commit -m "feat(authn): authn.captcha schema with per-flow modes and adaptive limits"
```

---

### Task 3: Sliding-window pressure counter

**Files:**
- Create: `packages/authn/src/captcha/pressure.ts`
- Create: `packages/authn/test/captcha/pressure.test.ts`

**Interfaces:**
- Consumes: `CaptchaFlow` (Task 1).
- Produces:
  - `interface CaptchaAdaptive { readonly windowSeconds: number; readonly threshold: number; readonly ipThreshold: number; readonly maxTrackedIps: number }`
  - `class SlidingCount { add(now: number, windowMs: number): number; count(now: number, windowMs: number): number }`
  - `class CaptchaPressure { readonly trackedIps: number; hit(flow: CaptchaFlow, ip: string | undefined, now: number, limits: CaptchaAdaptive): boolean }`

- [ ] **Step 1: Write the failing test**

Create `packages/authn/test/captcha/pressure.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';

import { CaptchaPressure, SlidingCount } from '../../src/captcha/pressure.js';
import type { CaptchaAdaptive } from '../../src/captcha/pressure.js';

const MIN = 60_000;
const limits = (over: Partial<CaptchaAdaptive> = {}): CaptchaAdaptive => ({ windowSeconds: 60, threshold: 1000, ipThreshold: 1000, maxTrackedIps: 1000, ...over });

describe('SlidingCount', () => {
  it('counts every event of the current bucket', () => {
    const c = new SlidingCount();
    assert.deepStrictEqual([c.add(0, MIN), c.add(1_000, MIN), c.add(59_999, MIN)], [1, 2, 3]);
  });

  it('weights the previous bucket by the part of it still inside the window', () => {
    const c = new SlidingCount();
    c.add(0, MIN);
    c.add(1_000, MIN);
    assert.strictEqual(c.count(60_000, MIN), 2);
    assert.strictEqual(c.count(90_000, MIN), 1);
    assert.strictEqual(c.add(90_000, MIN), 2);
  });

  it('forgets everything two windows on', () => {
    const c = new SlidingCount();
    for (let i = 0; i < 5; i++) c.add(0, MIN);
    assert.strictEqual(c.count(120_000, MIN), 0);
  });

  it('counts a clock that steps back as the start of the bucket', () => {
    const c = new SlidingCount();
    c.add(60_000, MIN);
    assert.strictEqual(c.count(59_000, MIN), 1);
  });
});

describe('CaptchaPressure', () => {
  it('puts a flow under pressure once its requests in the window go over threshold, whatever the ip', () => {
    const p = new CaptchaPressure();
    const l = limits({ threshold: 3 });
    const seen = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4'].map((ip) => p.hit('login', ip, 0, l));
    assert.deepStrictEqual(seen, [false, false, false, true]);
    assert.strictEqual(p.hit('login', '192.0.2.5', 1_000, l), true);
  });

  it('counts each flow apart', () => {
    const p = new CaptchaPressure();
    for (let i = 0; i < 4; i++) p.hit('login', undefined, 0, limits({ threshold: 3 }));
    assert.strictEqual(p.hit('reset', undefined, 0, limits({ threshold: 3 })), false);
  });

  it('puts one ip under pressure over ipThreshold and leaves the others alone', () => {
    const p = new CaptchaPressure();
    const l = limits({ ipThreshold: 2 });
    assert.deepStrictEqual([p.hit('login', '192.0.2.1', 0, l), p.hit('login', '192.0.2.1', 0, l), p.hit('login', '192.0.2.1', 0, l)], [false, false, true]);
    assert.strictEqual(p.hit('login', '192.0.2.2', 0, l), false);
  });

  it('counts a request without an ip for the flow only', () => {
    const p = new CaptchaPressure();
    const l = limits({ threshold: 2, ipThreshold: 1 });
    assert.deepStrictEqual([p.hit('login', undefined, 0, l), p.hit('login', undefined, 0, l), p.hit('login', undefined, 0, l)], [false, false, true]);
    assert.strictEqual(p.trackedIps, 0);
  });

  it('lifts the pressure once the requests stop for two windows', () => {
    const p = new CaptchaPressure();
    const l = limits({ ipThreshold: 1 });
    p.hit('login', '192.0.2.1', 0, l);
    assert.strictEqual(p.hit('login', '192.0.2.1', 0, l), true);
    assert.strictEqual(p.hit('login', '192.0.2.1', 120_000, l), false);
  });

  it('keeps at most maxTrackedIps ips, dropping the least recently seen', () => {
    const p = new CaptchaPressure();
    const l = limits({ ipThreshold: 1, maxTrackedIps: 2 });
    p.hit('login', 'a', 0, l);
    p.hit('login', 'b', 0, l);
    p.hit('login', 'a', 0, l);
    p.hit('login', 'c', 0, l);
    assert.strictEqual(p.trackedIps, 2);
    assert.strictEqual(p.hit('login', 'a', 0, l), true, 'a was seen after b, so b went first');
    assert.strictEqual(p.hit('login', 'b', 0, l), false, 'b was dropped and counts from zero');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/captcha/pressure.test.ts`
Expected: FAIL at compile time: `Cannot find module '../../src/captcha/pressure.js'`.

- [ ] **Step 3: Implement**

Create `packages/authn/src/captcha/pressure.ts`:

```ts
import type { CaptchaFlow } from '../contracts/captcha.js';

/** `authn.captcha.adaptive` as the schema delivers it. */
export interface CaptchaAdaptive {
  readonly windowSeconds: number;
  readonly threshold: number;
  readonly ipThreshold: number;
  readonly maxTrackedIps: number;
}

/**
 * Events of the last window from two fixed buckets: the current one in full, the previous one weighted by the part of
 * it still inside the window. Constant memory per key.
 */
export class SlidingCount {
  private bucketStart = Number.NEGATIVE_INFINITY;
  private current = 0;
  private previous = 0;

  public add(now: number, windowMs: number): number {
    this.roll(now, windowMs);
    this.current += 1;
    return this.weighted(now, windowMs);
  }

  public count(now: number, windowMs: number): number {
    this.roll(now, windowMs);
    return this.weighted(now, windowMs);
  }

  private weighted(now: number, windowMs: number): number {
    // A clock that steps back counts as the start of the bucket.
    const into = Math.min(Math.max(now - this.bucketStart, 0), windowMs);
    return this.current + this.previous * (1 - into / windowMs);
  }

  private roll(now: number, windowMs: number): void {
    const elapsed = now - this.bucketStart;
    if (elapsed < windowMs) return;
    const steps = Math.floor(elapsed / windowMs);
    this.previous = steps === 1 ? this.current : 0;
    this.current = 0;
    this.bucketStart = Number.isFinite(this.bucketStart) ? this.bucketStart + steps * windowMs : now;
  }
}

/**
 * Requests per flow, all clients together and per ip, for DefaultCaptchaGate's adaptive mode. Never keyed by account,
 * so the decision cannot tell an existing account from an unknown one (A02). One process: each instance counts its own.
 */
export class CaptchaPressure {
  private readonly flows = new Map<CaptchaFlow, SlidingCount>();
  // Insertion order is recency: a hit moves its ip to the end, so the first key is the least recently seen.
  private readonly ips = new Map<string, SlidingCount>();

  public get trackedIps(): number {
    return this.ips.size;
  }

  /** Counts one request; true when the flow or this ip is over its threshold within the window, this request included. */
  public hit(flow: CaptchaFlow, ip: string | undefined, now: number, limits: CaptchaAdaptive): boolean {
    const windowMs = limits.windowSeconds * 1000;
    let all = this.flows.get(flow);
    if (!all) this.flows.set(flow, (all = new SlidingCount()));
    const overall = all.add(now, windowMs);
    const fromIp = ip ? this.ofIp(`${flow}\u0000${ip}`, limits.maxTrackedIps).add(now, windowMs) : 0;
    return overall > limits.threshold || fromIp > limits.ipThreshold;
  }

  private ofIp(key: string, cap: number): SlidingCount {
    let c = this.ips.get(key);
    if (c) {
      this.ips.delete(key);
    } else {
      c = new SlidingCount();
      for (const oldest of this.ips.keys()) {
        if (this.ips.size < cap) break;
        this.ips.delete(oldest);
      }
    }
    this.ips.set(key, c);
    return c;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/captcha/pressure.test.ts`
Expected: PASS, 10 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/captcha/pressure.ts packages/authn/test/captcha/pressure.test.ts
git diff --cached --stat
git commit -m "feat(authn): sliding-window request counter for adaptive CAPTCHA"
```

---

### Task 4: `DefaultCaptchaGate` and provider selection

**Files:**
- Create: `packages/authn/src/captcha/settings.ts`, `packages/authn/src/captcha/provider.ts`, `packages/authn/src/captcha/default-captcha-gate.ts`, `packages/authn/src/captcha/index.ts`
- Modify: `packages/authn/src/index.ts:10` (append an export)
- Create: `packages/authn/test/captcha/default-captcha-gate.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts; `CaptchaPressure`, `CaptchaAdaptive` (Task 3); `AuthnAudit.publish` (`packages/authn/src/audit/authn-audit.ts:114`); `auditLog` (`packages/authn/src/audit/log.ts`); `nearestRegistration`, `registeredNames`, `instantiate`, `nonEmpty`, `q` (`packages/authn/src/registry/named.ts:9-35`).
- Produces (from `@spinajs/authn`):
  - `type CaptchaMode = 'off' | 'always' | 'adaptive'`; `interface CaptchaSettings { provider?: string; flows: Record<CaptchaFlow, CaptchaMode>; adaptive: CaptchaAdaptive; timeoutMs: number; failOpen: boolean }`
  - `selectCaptchaProvider(container: IContainer, name: string | undefined): Promise<CaptchaProvider>` (throws `InvalidOption`)
  - `configuredCaptchaProvider(container: IContainer): Promise<CaptchaProvider | null>` (null when `authn.captcha.provider` is unset)
  - `class DefaultCaptchaGate extends CaptchaGate` (`@PerChildInstance`, `@Injectable(CaptchaGate)`), constructor `(container: IContainer, options?: DefaultCaptchaGateOptions)`, `DefaultCaptchaGateOptions { now?: () => number; log?: AuditLog }`
  - `CAPTCHA_TOKEN_CAP = 4096`; `type CaptchaFailure = 'missing' | 'invalid' | 'provider_error'`
  - Audit event: `{ type: 'captcha.fail', outcome: 'failure', reason: CaptchaFailure, ip?, data: { flow, detail? } }`

- [ ] **Step 1: Write the failing test**

Create `packages/authn/test/captcha/default-captcha-gate.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { RecordingEventSink } from '@spinajs/authn-testing';

import { AuthnEventSink, CaptchaGate, CaptchaProvider, DefaultCaptchaGate } from '../../src/index.js';
import type { CaptchaClientInfo, CaptchaVerdict } from '../../src/index.js';
import { bind, configuredChild, pinConfiguration, useHarnessLog } from '../behaviour/harness.js';

const IP_A = '192.0.2.10';
const IP_B = '192.0.2.20';

class TestProvider extends CaptchaProvider {
  public readonly calls: { token: string; ip?: string }[] = [];
  public answer: () => Promise<CaptchaVerdict> = async () => ({ ok: true });

  public verify(token: string, ip?: string): Promise<CaptchaVerdict> {
    this.calls.push({ token, ...(ip ? { ip } : {}) });
    return this.answer();
  }

  public client(): CaptchaClientInfo {
    return { provider: 'test', siteKey: 'site-key' };
  }
}

interface Booted {
  child: IContainer;
  gate: DefaultCaptchaGate;
  provider: TestProvider;
  events: RecordingEventSink;
  clock: { ms: number };
}

const open: IContainer[] = [];

async function boot(captcha: Record<string, unknown> = {}): Promise<Booted> {
  const child = await configuredChild({ authn: { captcha: { provider: 'TestCaptchaProvider', ...captcha } } }, 'test', true);
  open.push(child);
  const provider = new TestProvider();
  const events = new RecordingEventSink();
  bind(child, CaptchaProvider, 'TestCaptchaProvider', provider);
  bind(child, AuthnEventSink, 'CaptchaEvents', events);
  const clock = { ms: 0 };
  const gate = pinConfiguration(new DefaultCaptchaGate(child, { now: () => clock.ms }), child);
  return { child, gate, provider, events, clock };
}

const fails = (b: Booted) => b.events.all().filter((e) => e.type === 'captcha.fail');

describe('DefaultCaptchaGate', function () {
  this.timeout(30000);
  useHarnessLog();

  afterEach(async () => {
    for (const c of open.splice(0)) await c.dispose();
  });

  it('is the CaptchaGate a container resolves', async () => {
    const { child } = await boot();
    assert.ok((await child.resolve(CaptchaGate)) instanceof DefaultCaptchaGate);
  });

  describe('required', () => {
    it('asks for nothing while every flow is off (the default)', async () => {
      const { gate } = await boot();
      for (const flow of ['login', 'register', 'reset', 'code', 'verify'] as const) {
        for (let i = 0; i < 20; i++) assert.strictEqual(await gate.required(flow, { ip: IP_A }), false, flow);
      }
    });

    it("asks on every request of an 'always' flow and only there", async () => {
      const { gate } = await boot({ flows: { reset: 'always' } });
      assert.strictEqual(await gate.required('reset', {}), true);
      assert.strictEqual(await gate.required('reset', { ip: IP_A, account: 'alice@example.test' }), true);
      assert.strictEqual(await gate.required('login', { ip: IP_A }), false);
    });

    it('adaptive: asks an ip once its requests in the window go over ipThreshold', async () => {
      const { gate } = await boot({ flows: { login: 'adaptive' }, adaptive: { ipThreshold: 2 } });
      const seen: boolean[] = [];
      for (let i = 0; i < 3; i++) seen.push(await gate.required('login', { ip: IP_A }));
      assert.deepStrictEqual(seen, [false, false, true]);
      assert.strictEqual(await gate.required('login', { ip: IP_B }), false);
    });

    it('adaptive: asks every client once the flow goes over threshold', async () => {
      const { gate } = await boot({ flows: { login: 'adaptive' }, adaptive: { threshold: 3 } });
      const seen: boolean[] = [];
      for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) seen.push(await gate.required('login', { ip }));
      assert.deepStrictEqual(seen, [false, false, false, true]);
    });

    it('adaptive: the window slides, so the pressure ends when the requests stop', async () => {
      const b = await boot({ flows: { login: 'adaptive' }, adaptive: { windowSeconds: 60, ipThreshold: 1 } });
      await b.gate.required('login', { ip: IP_A });
      assert.strictEqual(await b.gate.required('login', { ip: IP_A }), true);
      b.clock.ms += 120_000;
      assert.strictEqual(await b.gate.required('login', { ip: IP_A }), false);
    });

    it('adaptive: the answers are the same whichever account is named (A02)', async () => {
      const { gate } = await boot({ flows: { login: 'adaptive' }, adaptive: { ipThreshold: 2 } });
      const run = async (ip: string, accounts: string[]) => {
        const out: boolean[] = [];
        for (const account of accounts) out.push(await gate.required('login', { ip, account }));
        return out;
      };
      assert.deepStrictEqual(await run(IP_A, ['alice@example.test', 'nobody@example.test', 'alice@example.test']), await run(IP_B, ['nobody@example.test', 'alice@example.test', 'nobody@example.test']));
    });
  });

  describe('verify', () => {
    it('passes a token the provider accepts, with the ip, and publishes nothing', async () => {
      const b = await boot();
      assert.strictEqual(await b.gate.verify('login', 'tok', { ip: IP_A }), true);
      assert.deepStrictEqual(b.provider.calls, [{ token: 'tok', ip: IP_A }]);
      assert.deepStrictEqual(fails(b), []);
    });

    it('refuses a missing token without asking the provider and audits captcha.fail missing', async () => {
      const b = await boot();
      assert.strictEqual(await b.gate.verify('reset', undefined, { ip: IP_A }), false);
      assert.strictEqual(await b.gate.verify('reset', '', {}), false);
      assert.deepStrictEqual(b.provider.calls, []);
      const [e] = fails(b);
      assert.deepStrictEqual({ outcome: e.outcome, reason: e.reason, ip: e.ip, data: e.data }, { outcome: 'failure', reason: 'missing', ip: IP_A, data: { flow: 'reset' } });
      assert.strictEqual(fails(b).length, 2);
    });

    it('refuses a token the provider rejects, auditing its reason but never the token', async () => {
      const b = await boot();
      b.provider.answer = async () => ({ ok: false, reason: 'timeout-or-duplicate' });
      assert.strictEqual(await b.gate.verify('login', 'secret-token-value', { ip: IP_A }), false);
      const [e] = fails(b);
      assert.strictEqual(e.reason, 'invalid');
      assert.deepStrictEqual(e.data, { flow: 'login', detail: 'timeout-or-duplicate' });
      assert.ok(!JSON.stringify(b.events.all()).includes('secret-token-value'));
    });

    it('drops a provider reason that is not a short identifier', async () => {
      const b = await boot();
      b.provider.answer = async () => ({ ok: false, reason: 'echo: secret-token-value' });
      assert.strictEqual(await b.gate.verify('login', 'secret-token-value', {}), false);
      assert.deepStrictEqual(fails(b)[0].data, { flow: 'login' });
    });

    it('refuses an over-long token unseen', async () => {
      const b = await boot();
      assert.strictEqual(await b.gate.verify('login', 'x'.repeat(4097), {}), false);
      assert.deepStrictEqual(b.provider.calls, []);
      assert.deepStrictEqual(fails(b)[0].data, { flow: 'login', detail: 'too_long' });
    });

    it('fails closed when the provider cannot answer', async () => {
      const b = await boot();
      b.provider.answer = async () => {
        throw new TypeError('fetch failed');
      };
      assert.strictEqual(await b.gate.verify('login', 'tok', {}), false);
      const [e] = fails(b);
      assert.deepStrictEqual({ reason: e.reason, data: e.data }, { reason: 'provider_error', data: { flow: 'login', detail: 'TypeError' } });
    });

    it('fails closed when the provider does not answer within timeoutMs', async () => {
      const b = await boot({ timeoutMs: 100 });
      b.provider.answer = () => new Promise<CaptchaVerdict>(() => undefined);
      const started = Date.now();
      assert.strictEqual(await b.gate.verify('login', 'tok', {}), false);
      assert.ok(Date.now() - started < 2000);
      assert.deepStrictEqual(fails(b)[0].data, { flow: 'login', detail: 'TimeoutError' });
    });

    it('lets the request through under failOpen when the provider cannot answer, never a rejected token', async () => {
      const b = await boot({ failOpen: true });
      b.provider.answer = async () => {
        throw new TypeError('fetch failed');
      };
      assert.strictEqual(await b.gate.verify('login', 'tok', {}), true);
      b.provider.answer = async () => ({ ok: false, reason: 'invalid-input-response' });
      assert.strictEqual(await b.gate.verify('login', 'tok', {}), false);
    });

    it('rejects with InvalidOption when the named provider is not registered, even under failOpen', async () => {
      const child = await configuredChild({ authn: { captcha: { provider: 'GhostCaptchaProvider', failOpen: true } } }, 'test', true);
      open.push(child);
      const gate = pinConfiguration(new DefaultCaptchaGate(child), child);
      await assert.rejects(gate.verify('login', 'tok', {}), (e: unknown) => e instanceof InvalidOption && /authn\.captcha\.provider "GhostCaptchaProvider": no CaptchaProvider is registered/.test(e.message));
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/captcha/default-captcha-gate.test.ts`
Expected: FAIL at compile time: `Module '"../../src/index.js"' has no exported member 'DefaultCaptchaGate'`.

- [ ] **Step 3: Implement**

Create `packages/authn/src/captcha/settings.ts`:

```ts
import type { CaptchaFlow } from '../contracts/captcha.js';
import type { CaptchaAdaptive } from './pressure.js';

export type CaptchaMode = 'off' | 'always' | 'adaptive';

/** `authn.captcha` as the schema delivers it. */
export interface CaptchaSettings {
  readonly provider?: string;
  readonly flows: Readonly<Record<CaptchaFlow, CaptchaMode>>;
  readonly adaptive: CaptchaAdaptive;
  readonly timeoutMs: number;
  readonly failOpen: boolean;
}
```

Create `packages/authn/src/captcha/provider.ts`:

```ts
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import { CaptchaProvider } from '../contracts/captcha.js';
import { instantiate, nearestRegistration, nonEmpty, q, registeredNames } from '../registry/named.js';

/** The CaptchaProvider registered as `name`, the registration nearest to `container` winning. */
export async function selectCaptchaProvider(container: IContainer, name: string | undefined): Promise<CaptchaProvider> {
  const listed = registeredNames(container, CaptchaProvider).map(q).join(', ') || 'none';
  if (!nonEmpty(name)) throw new InvalidOption(`authn.captcha.provider is not set (registered: ${listed})`);
  const type = nearestRegistration(container, CaptchaProvider, name);
  if (!type) {
    throw new InvalidOption(`authn.captcha.provider ${q(name)}: no CaptchaProvider is registered under that name (registered: ${listed}). TurnstileCaptchaProvider and AltchaCaptchaProvider come with @spinajs/authn-captcha`);
  }
  const provider: unknown = await instantiate(container, type);
  const p = provider as Partial<CaptchaProvider> | null;
  if (p === null || typeof p !== 'object' || typeof p.verify !== 'function' || typeof p.client !== 'function') {
    throw new InvalidOption(`authn.captcha.provider ${q(name)} is not a CaptchaProvider`);
  }
  return provider as CaptchaProvider;
}

/** The provider `authn.captcha.provider` names in the configuration of `container`, or null when it names none. */
export async function configuredCaptchaProvider(container: IContainer): Promise<CaptchaProvider | null> {
  const name = (await container.resolve(Configuration)).get<string | undefined>('authn.captcha.provider');
  return nonEmpty(name) ? selectCaptchaProvider(container, name) : null;
}
```

Create `packages/authn/src/captcha/default-captcha-gate.ts`:

```ts
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';

import { CaptchaGate } from '../contracts/captcha.js';
import type { CaptchaFlow, CaptchaProvider, CaptchaVerdict } from '../contracts/captcha.js';
import { AuthnAudit } from '../audit/authn-audit.js';
import { auditLog } from '../audit/log.js';
import type { AuditLog } from '../audit/log.js';
import { CaptchaPressure } from './pressure.js';
import { selectCaptchaProvider } from './provider.js';
import type { CaptchaSettings } from './settings.js';

export interface DefaultCaptchaGateOptions {
  /** Epoch milliseconds, read at each call; default Date.now. */
  readonly now?: () => number;
  readonly log?: AuditLog;
}

/** Longer than any provider's token (Turnstile's are at most 2048 characters); a longer one never reaches the provider. */
export const CAPTCHA_TOKEN_CAP = 4096;

export type CaptchaFailure = 'missing' | 'invalid' | 'provider_error';

// What a provider reason or an error class may put into an audit event.
const DETAIL = /^[A-Za-z0-9_-]{1,64}$/;

const errorClass = (err: unknown): string => (err instanceof Error && err.name !== '' ? err.name : typeof err);

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${ms} ms`), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Per flow, `authn.captcha.flows.<flow>`: 'off' never asks for a challenge, 'always' asks on every request, 'adaptive'
 * asks while the flow or the client ip is under pressure: more requests within `adaptive.windowSeconds` than
 * `adaptive.threshold` (all clients) or `adaptive.ipThreshold` (one ip). In adaptive mode each required() call counts as
 * one request. Nothing is keyed by account, so the answer is the same for an existing and an unknown account (A02).
 *
 * verify() asks the provider `authn.captcha.provider` names and publishes `captcha.fail` for a missing, wrong or
 * unverifiable token; the token never reaches an event or a log. A provider that cannot answer within `timeoutMs`
 * fails closed unless `failOpen`.
 *
 * One per container, as DefaultAuthnService (D11); the counters live in the instance, so each app instance counts
 * its own requests.
 */
@PerChildInstance()
@Injectable(CaptchaGate)
@Inject(Container)
export class DefaultCaptchaGate extends CaptchaGate {
  @Config('authn.captcha')
  protected Settings!: CaptchaSettings;

  private readonly pressure = new CaptchaPressure();
  private selected: Promise<CaptchaProvider> | undefined;
  private readonly now: () => number;
  private readonly log: AuditLog;

  /** `options` is for tests; DI passes only the container. */
  constructor(private readonly container: IContainer, options: DefaultCaptchaGateOptions = {}) {
    super();
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? auditLog('authn-captcha');
  }

  public async required(flow: CaptchaFlow, ctx: { readonly ip?: string; readonly account?: string }): Promise<boolean> {
    const settings = this.settings();
    const mode = settings.flows[flow];
    if (mode === 'always') return true;
    if (mode !== 'adaptive') return false;
    return this.pressure.hit(flow, ctx.ip, this.now(), settings.adaptive);
  }

  public async verify(flow: CaptchaFlow, token: string | undefined, ctx: { readonly ip?: string }): Promise<boolean> {
    if (typeof token !== 'string' || token === '') return this.failed(flow, ctx, 'missing');
    if (token.length > CAPTCHA_TOKEN_CAP) return this.failed(flow, ctx, 'invalid', 'too_long');
    const settings = this.settings();
    // Outside the try: a provider that is not configured is a setup error, never a reason to let a request through.
    const provider = await this.provider(settings);
    let verdict: CaptchaVerdict;
    try {
      verdict = await within(provider.verify(token, ctx.ip), settings.timeoutMs);
    } catch (err) {
      if (!settings.failOpen) return this.failed(flow, ctx, 'provider_error', errorClass(err));
      this.log.warn(`DefaultCaptchaGate: the captcha provider could not answer (${errorClass(err)}); authn.captcha.failOpen lets this ${flow} request through`);
      return true;
    }
    if (verdict?.ok === true) return true;
    return this.failed(flow, ctx, 'invalid', verdict?.reason);
  }

  private settings(): CaptchaSettings {
    const s = this.Settings;
    if (!s?.flows || !s.adaptive) throw new InvalidOperation('authn.captcha is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
    return s;
  }

  private provider(settings: CaptchaSettings): Promise<CaptchaProvider> {
    this.selected ??= selectCaptchaProvider(this.container, settings.provider).catch((err: unknown) => {
      this.selected = undefined;
      throw err;
    });
    return this.selected;
  }

  private async failed(flow: CaptchaFlow, ctx: { readonly ip?: string }, reason: CaptchaFailure, detail?: string): Promise<false> {
    const auditor = await this.container.resolve(AuthnAudit);
    await auditor.publish({
      type: 'captcha.fail',
      outcome: 'failure',
      at: new Date(this.now()),
      reason,
      ...(typeof ctx.ip === 'string' && ctx.ip !== '' ? { ip: ctx.ip } : {}),
      data: { flow, ...(typeof detail === 'string' && DETAIL.test(detail) ? { detail } : {}) },
    });
    return false;
  }
}
```

Create `packages/authn/src/captcha/index.ts`:

```ts
export * from './pressure.js';
export * from './settings.js';
export * from './provider.js';
export * from './default-captcha-gate.js';
```

Append to `packages/authn/src/index.ts` (after line 10):

```ts
export * from './captcha/index.js';
```

- [ ] **Step 4: Run the test, the suite, rebuild**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/captcha/default-captcha-gate.test.ts` → PASS, 16 passing.
2. `npm test` in `packages/authn` → 0 failing.
3. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && cd ../.. && node scripts/generate-packages-for-modules.mjs`
4. Dependants read `lib/`: run `npm test` in `packages/authn-http` and `packages/authn-testing` → 0 failing (the gate is registered in every app that imports `@spinajs/authn`, with every flow off).

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/captcha packages/authn/src/index.ts packages/authn/test/captcha/default-captcha-gate.test.ts
git diff --cached --stat
git commit -m "feat(authn): DefaultCaptchaGate with off, always and adaptive modes"
```

---

### Task 5: Package `@spinajs/authn-captcha` with the Turnstile provider

**Files:**
- Create: `packages/authn-captcha/{package.json,tsconfig.json,tsconfig.mjs.json,tsconfig.cjs.json,README.md}`
- Copy from `packages/authn-keys`: `.eslintignore`, `.eslintrc.cjs`, `.gitignore`, `.mocharc.json`, `.npmignore`, `.prettierrc`, `typedoc.json`
- Create: `packages/authn-captcha/src/{index.ts,schema.ts,bootstrap.ts,errors.ts,turnstile.ts}`
- Create: `packages/authn-captcha/test/support/config-boot.ts`, `test/schema.test.ts`, `test/turnstile.test.ts`
- Modify: `package.json:106` (root dependency), `tsconfig.build.json:90`, `tsconfig.build.cjs.json:90`

**Interfaces:**
- Consumes: `CaptchaProvider`, `CaptchaClientInfo`, `CaptchaVerdict` (Task 1); `AUTHN_CONFIGURATION_SCHEMA` with `authn.captcha.timeoutMs` (Task 2).
- Produces (from `@spinajs/authn-captcha`):
  - `AUTHN_CAPTCHA_CONFIGURATION_SCHEMA` (`$configurationModule: 'authn.captcha'`), `AuthnCaptchaConfigBootstrapper`
  - `class CaptchaUnavailable extends Error`
  - `TURNSTILE_SITEVERIFY_URL`, `type FetchLike = (url: string, init: RequestInit) => Promise<Response>`, `TurnstileSettings`, `TurnstileOptions { fetch?: FetchLike }`
  - `class TurnstileCaptchaProvider extends CaptchaProvider` (`@Injectable(CaptchaProvider)`), registered as `TurnstileCaptchaProvider`; `client()` → `{ provider: 'turnstile', siteKey }`

- [ ] **Step 1: Scaffold the package**

From the repo root:

```bash
mkdir -p packages/authn-captcha/src packages/authn-captcha/test/support
cp packages/authn-keys/{.eslintignore,.eslintrc.cjs,.gitignore,.mocharc.json,.npmignore,.prettierrc,typedoc.json} packages/authn-captcha/
```

Create `packages/authn-captcha/package.json`:

```json
{
  "name": "@spinajs/authn-captcha",
  "version": "3.0.0-alpha.0",
  "description": "CAPTCHA providers for SpinaJS authn: Cloudflare Turnstile and self-hosted ALTCHA proof of work",
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
    "captcha"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {
    "@spinajs/authn": "3.0.0-alpha.0",
    "@spinajs/authn-orm": "3.0.0-alpha.0",
    "@spinajs/configuration": "2.0.549",
    "@spinajs/di": "2.0.549"
  }
}
```

Create `packages/authn-captcha/tsconfig.json`:

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
  "references": [{ "path": "../authn/tsconfig.json" }, { "path": "../authn-orm/tsconfig.json" }, { "path": "../configuration/tsconfig.json" }, { "path": "../di/tsconfig.json" }]
}
```

Create `packages/authn-captcha/tsconfig.mjs.json`:

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
  "references": [{ "path": "../authn/tsconfig.mjs.json" }, { "path": "../authn-orm/tsconfig.mjs.json" }, { "path": "../configuration/tsconfig.mjs.json" }, { "path": "../di/tsconfig.mjs.json" }]
}
```

Create `packages/authn-captcha/tsconfig.cjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../authn/tsconfig.cjs.json" }, { "path": "../authn-orm/tsconfig.cjs.json" }, { "path": "../configuration/tsconfig.cjs.json" }, { "path": "../di/tsconfig.cjs.json" }]
}
```

Create `packages/authn-captcha/README.md`:

```md
# @spinajs/authn-captcha

CAPTCHA providers for `DefaultCaptchaGate` (`@spinajs/authn`): `TurnstileCaptchaProvider` (Cloudflare Turnstile) and `AltchaCaptchaProvider` (self-hosted proof of work). Select one with `authn.captcha.provider` and turn flows on with `authn.captcha.flows`.
```

Root `package.json`, after line 106 (`"@spinajs/authn-oidc": "file:packages/authn-oidc",`):

```json
    "@spinajs/authn-captcha": "file:packages/authn-captcha",
```

`tsconfig.build.json`, after `{ "path": "packages/authn-oidc/tsconfig.mjs.json" },`:

```json
    { "path": "packages/authn-captcha/tsconfig.mjs.json" },
```

`tsconfig.build.cjs.json`, after `{ "path": "./packages/authn-oidc/tsconfig.cjs.json" },`:

```json
    { "path": "./packages/authn-captcha/tsconfig.cjs.json" },
```

Link the package the way the others are linked (`node_modules/@spinajs/authn-keys` is a link to `packages/authn-keys`). From the repo root, in PowerShell:

```powershell
New-Item -ItemType Junction -Path node_modules\@spinajs\authn-captcha -Target packages\authn-captcha
```

Expected: `ls node_modules/@spinajs/authn-captcha/package.json` lists the file.

- [ ] **Step 2: Write the failing tests**

Create `packages/authn-captcha/test/support/config-boot.ts` (the helper of `packages/authn-totp/test/support/config-boot.ts`):

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
```

Create `packages/authn-captcha/test/schema.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

import { AUTHN_CAPTCHA_CONFIGURATION_SCHEMA } from '../src/index.js';
import { disposeBooted, violationsOf } from './support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_CAPTCHA_CONFIGURATION_SCHEMA];
const TURNSTILE = { siteKey: '0x4AAAAAAA-site', secret: { secret: 'turnstile-secret' } };

describe('authn-captcha schema: turnstile', function () {
  this.timeout(30000);
  afterEach(disposeBooted);

  it('needs authn.captcha.turnstile once the provider is TurnstileCaptchaProvider', async () => {
    const paths = await violationsOf(SCHEMAS, { authn: { captcha: { provider: 'TurnstileCaptchaProvider' } } });
    assert.ok(paths.includes('authn.captcha.turnstile'), paths.join(', '));
  });

  it('needs the site key and the secret reference', async () => {
    const paths = await violationsOf(SCHEMAS, { authn: { captcha: { provider: 'TurnstileCaptchaProvider', turnstile: { siteKey: '' } } } });
    assert.ok(paths.includes('authn.captcha.turnstile.siteKey'), paths.join(', '));
    assert.ok(paths.includes('authn.captcha.turnstile.secret'), paths.join(', '));
  });

  it('takes a complete Turnstile block', async () => {
    assert.deepStrictEqual(await violationsOf(SCHEMAS, { authn: { captcha: { provider: 'TurnstileCaptchaProvider', flows: { login: 'adaptive' }, turnstile: TURNSTILE } } }), []);
  });
});
```

Create `packages/authn-captcha/test/turnstile.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

import { AUTHN_CAPTCHA_CONFIGURATION_SCHEMA, CaptchaUnavailable, TURNSTILE_SITEVERIFY_URL, TurnstileCaptchaProvider } from '../src/index.js';
import type { FetchLike } from '../src/index.js';
import { boot, disposeBooted, readingFrom } from './support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_CAPTCHA_CONFIGURATION_SCHEMA];
const SETTINGS = { authn: { captcha: { provider: 'TurnstileCaptchaProvider', timeoutMs: 1500, turnstile: { siteKey: '0x4AAAAAAA-site', secret: { secret: 'turnstile-secret' } } } } };

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return answer(call);
    },
  };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function provider(f: FetchLike): Promise<TurnstileCaptchaProvider> {
  const { child } = await boot(SCHEMAS, SETTINGS);
  return readingFrom(new TurnstileCaptchaProvider({ fetch: f }), child);
}

describe('TurnstileCaptchaProvider', function () {
  this.timeout(30000);
  afterEach(disposeBooted);

  it('posts the secret, the token and the ip to siteverify as a form, with a timeout and no redirects', async () => {
    const f = fakeFetch(() => json({ success: true }));
    assert.deepStrictEqual(await (await provider(f.fetch)).verify('tok-1', '192.0.2.10'), { ok: true });
    const [c] = f.calls;
    assert.strictEqual(c.url, TURNSTILE_SITEVERIFY_URL);
    assert.strictEqual(c.init.method, 'POST');
    assert.strictEqual(c.init.redirect, 'manual');
    assert.ok(c.init.signal instanceof AbortSignal);
    assert.strictEqual((c.init.headers as Record<string, string>)['content-type'], 'application/x-www-form-urlencoded');
    assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(String(c.init.body))), { secret: 'turnstile-secret', response: 'tok-1', remoteip: '192.0.2.10' });
  });

  it('sends no remoteip without an ip', async () => {
    const f = fakeFetch(() => json({ success: true }));
    await (await provider(f.fetch)).verify('tok-1');
    assert.strictEqual(new URLSearchParams(String(f.calls[0].init.body)).has('remoteip'), false);
  });

  it("answers Cloudflare's first error code as the reason (a reused token: timeout-or-duplicate)", async () => {
    const f = fakeFetch(() => json({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
    assert.deepStrictEqual(await (await provider(f.fetch)).verify('tok-1'), { ok: false, reason: 'timeout-or-duplicate' });
  });

  it("answers 'rejected' when Cloudflare names no error code", async () => {
    const f = fakeFetch(() => json({ success: false }));
    assert.deepStrictEqual(await (await provider(f.fetch)).verify('tok-1'), { ok: false, reason: 'rejected' });
  });

  const unavailable: [string, () => Response][] = [
    ['a 5xx', () => json({ success: true }, 503)],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['JSON without a verdict', () => json({ ok: true })],
    ['internal-error', () => json({ success: false, 'error-codes': ['internal-error'] })],
  ];
  for (const [label, answer] of unavailable) {
    it(`rejects with CaptchaUnavailable on ${label}`, async () => {
      await assert.rejects((await provider(fakeFetch(answer).fetch)).verify('tok-1'), CaptchaUnavailable);
    });
  }

  it('lets a network failure reject as it is', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects((await provider(f.fetch)).verify('tok-1'), TypeError);
  });

  it('tells a client the widget and the public site key, never the secret, and offers no challenge', async () => {
    const p = await provider(fakeFetch(() => json({ success: true })).fetch);
    assert.deepStrictEqual(p.client(), { provider: 'turnstile', siteKey: '0x4AAAAAAA-site' });
    assert.strictEqual(typeof (p as { challenge?: unknown }).challenge, 'undefined');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/authn-captcha && npx ts-mocha -p tsconfig.json test/schema.test.ts test/turnstile.test.ts`
Expected: FAIL at compile time: `Cannot find module '../src/index.js'`.

- [ ] **Step 4: Implement**

Create `packages/authn-captcha/src/errors.ts`:

```ts
/** The provider could not answer; DefaultCaptchaGate applies authn.captcha.failOpen to it. */
export class CaptchaUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaUnavailable';
  }
}
```

Create `packages/authn-captcha/src/schema.ts`:

```ts
const secretRef = (description: string, minLength = 1) => ({
  type: 'object',
  description: `${description} A reference the configuration resolves (e.g. aws-parameters://), never an inline value.`,
  propertyNames: { enum: ['secret'] },
  properties: { secret: { type: 'string', minLength } },
  required: ['secret'],
});

/** authn.captcha.turnstile; the core schema (AUTHN_CONFIGURATION_SCHEMA) owns the rest of authn.captcha. */
export const AUTHN_CAPTCHA_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-captcha.configuration.schema.json',
  $configurationModule: 'authn.captcha',
  description: 'CAPTCHA provider settings (@spinajs/authn-captcha)',
  type: 'object',
  properties: {
    turnstile: {
      type: 'object',
      propertyNames: { enum: ['siteKey', 'secret'] },
      properties: {
        siteKey: { type: 'string', minLength: 1, description: 'The public site key the widget renders with.' },
        secret: secretRef('The Turnstile secret key of the site.'),
      },
      required: ['siteKey', 'secret'],
    },
  },
  allOf: [{ if: { type: 'object', required: ['provider'], properties: { provider: { const: 'TurnstileCaptchaProvider' } } }, then: { required: ['turnstile'] } }],
};
```

Create `packages/authn-captcha/src/bootstrap.ts`:

```ts
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHN_CAPTCHA_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the provider schema, so the configuration validates authn.captcha's provider blocks and fills their defaults. */
@Injectable(Bootstrapper)
export class AuthnCaptchaConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_CAPTCHA_CONFIGURATION_SCHEMA);
  }
}
```

Create `packages/authn-captcha/src/turnstile.ts`:

```ts
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { CaptchaProvider } from '@spinajs/authn/contracts';
import type { CaptchaClientInfo, CaptchaVerdict } from '@spinajs/authn/contracts';

import { CaptchaUnavailable } from './errors.js';

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** `authn.captcha.turnstile` as the schema delivers it. */
export interface TurnstileSettings {
  readonly siteKey: string;
  readonly secret: { readonly secret: string };
}

export interface TurnstileOptions {
  /** Default: the global fetch. */
  readonly fetch?: FetchLike;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Cloudflare Turnstile. Each token goes to siteverify once; Cloudflare answers a token seen before with
 * timeout-or-duplicate, so tokens are single use without a store of our own.
 */
@Injectable(CaptchaProvider)
export class TurnstileCaptchaProvider extends CaptchaProvider {
  @Config('authn.captcha.turnstile')
  protected Settings: TurnstileSettings | undefined;

  @Config('authn.captcha.timeoutMs')
  protected TimeoutMs: number | undefined;

  private readonly fetchFn: FetchLike;

  /** `options` is for tests; DI passes nothing. */
  constructor(options: TurnstileOptions = {}) {
    super();
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  }

  public client(): CaptchaClientInfo {
    return { provider: 'turnstile', siteKey: this.settings().siteKey };
  }

  public async verify(token: string, ip?: string): Promise<CaptchaVerdict> {
    const form = new URLSearchParams({ secret: this.settings().secret.secret, response: token });
    if (ip) form.set('remoteip', ip);
    const response = await this.fetchFn(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.TimeoutMs ?? 5000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new CaptchaUnavailable(`Turnstile siteverify answered HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CaptchaUnavailable('Turnstile siteverify answered no JSON');
    }
    if (!isObject(body) || typeof body.success !== 'boolean') throw new CaptchaUnavailable('Turnstile siteverify answered no verdict');
    if (body.success) return { ok: true };
    const codes = Array.isArray(body['error-codes']) ? body['error-codes'].filter((c): c is string => typeof c === 'string') : [];
    // Cloudflare's own fault: a retry may pass, so it is not the client's wrong answer.
    if (codes.includes('internal-error')) throw new CaptchaUnavailable('Turnstile siteverify reported internal-error');
    return { ok: false, reason: codes[0] ?? 'rejected' };
  }

  private settings(): TurnstileSettings {
    const s = this.Settings;
    // The schema requires the block once this provider is named, so only an unregistered schema gets here.
    if (!s?.siteKey || !s.secret?.secret) throw new Error('authn.captcha.turnstile is not set: register AUTHN_CAPTCHA_CONFIGURATION_SCHEMA (AuthnCaptchaConfigBootstrapper)');
    return s;
  }
}
```

Create `packages/authn-captcha/src/index.ts`:

```ts
export * from './errors.js';
export * from './schema.js';
export * from './bootstrap.js';
export * from './turnstile.js';
```

- [ ] **Step 5: Run the tests, build**

1. `cd packages/authn-captcha && npx ts-mocha -p tsconfig.json test/schema.test.ts test/turnstile.test.ts` → PASS (schema: 3 passing; turnstile: 11 passing).
2. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && cd ../.. && node scripts/generate-packages-for-modules.mjs` → no errors.
3. `cd packages/authn-captcha && npm test` → 0 failing.

- [ ] **Step 6: Commit**

```bash
git add packages/authn-captcha package.json tsconfig.build.json tsconfig.build.cjs.json
git diff --cached --stat
git commit -m "feat(authn-captcha): new package with the Cloudflare Turnstile provider"
```

The `node_modules` junction is not committed (`node_modules` is ignored).

---

### Task 6: The ALTCHA provider

**Files:**
- Create: `packages/authn-captcha/src/altcha.ts`
- Modify: `packages/authn-captcha/src/schema.ts` (whole file below), `packages/authn-captcha/src/index.ts`
- Create: `packages/authn-captcha/test/altcha.test.ts`
- Modify: `packages/authn-captcha/test/schema.test.ts` (a new describe)

**Interfaces:**
- Consumes: `CaptchaProvider` (Task 1); `NonceStore`, `MemoryNonceStore` from `@spinajs/authn-orm` (`packages/authn-orm/src/nonces/nonce-store.ts:24-48`); test helpers of Task 5.
- Produces:
  - `AltchaSettings { hmacKey: { secret: string }; maxNumber: number; expiresSeconds: number }`
  - `AltchaChallenge { algorithm: 'SHA-256'; challenge: string; maxnumber: number; salt: string; signature: string }` (the ALTCHA widget's challenge format)
  - `AltchaOptions { now?: () => number; nonces?: NonceStore }`
  - `class AltchaCaptchaProvider extends CaptchaProvider` (`@Injectable(CaptchaProvider)`, `@Inject(Container)`), constructor `(container: IContainer, options?: AltchaOptions)`; `challenge(): Promise<AltchaChallenge>`; `verify(token)` reasons: `malformed`, `expired`, `bad_signature`, `wrong_solution`, `replayed`; `client()` → `{ provider: 'altcha' }`
  - Schema: `authn.captcha.altcha { hmacKey (secret ref, ≥ 32 chars), maxNumber 1000–10000000 (default 100000), expiresSeconds 10–3600 (default 300) }`, required once the provider is `AltchaCaptchaProvider`.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-captcha/test/altcha.test.ts`:

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'mocha';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { MemoryNonceStore, NonceStore } from '@spinajs/authn-orm';

import { AUTHN_CAPTCHA_CONFIGURATION_SCHEMA, AltchaCaptchaProvider } from '../src/index.js';
import type { AltchaChallenge } from '../src/index.js';
import { boot, disposeBooted, readingFrom } from './support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_CAPTCHA_CONFIGURATION_SCHEMA];
const HMAC_KEY = 'altcha-hmac-key-'.repeat(3);
const SETTINGS = { authn: { captcha: { provider: 'AltchaCaptchaProvider', altcha: { hmacKey: { secret: HMAC_KEY }, maxNumber: 1000 } } } };

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const encode = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');
const decode = (token: string): { number: number; challenge: string } => JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as { number: number; challenge: string };

/** What the widget does: tries every number until the hash matches, then sends base64(JSON). */
function solve(c: AltchaChallenge, over: Record<string, unknown> = {}): string {
  for (let n = 0; n <= c.maxnumber; n++) {
    if (sha256(`${c.salt}${n}`) === c.challenge) return encode({ algorithm: c.algorithm, challenge: c.challenge, number: n, salt: c.salt, signature: c.signature, took: 5, ...over });
  }
  throw new Error('no solution');
}

async function provider() {
  const clock = { ms: Date.UTC(2026, 9, 6) };
  const { child } = await boot(SCHEMAS, SETTINGS);
  const p = readingFrom(new AltchaCaptchaProvider(child, { now: () => clock.ms, nonces: new MemoryNonceStore() }), child);
  return { p, clock };
}

describe('AltchaCaptchaProvider', function () {
  this.timeout(30000);
  afterEach(disposeBooted);

  it('issues a signed SHA-256 challenge with maxnumber and the expiry in the salt', async () => {
    const { p, clock } = await provider();
    const c = await p.challenge();
    assert.strictEqual(c.algorithm, 'SHA-256');
    assert.strictEqual(c.maxnumber, 1000);
    assert.match(c.challenge, /^[0-9a-f]{64}$/);
    assert.match(c.signature, /^[0-9a-f]{64}$/);
    assert.strictEqual(new URLSearchParams(c.salt.split('?')[1]).get('expires'), String(Math.floor(clock.ms / 1000) + 300));
    assert.notStrictEqual((await p.challenge()).salt, c.salt);
  });

  it('verifies a solved challenge once; the second redemption is a replay', async () => {
    const { p } = await provider();
    const token = solve(await p.challenge());
    assert.deepStrictEqual(await p.verify(token), { ok: true });
    assert.deepStrictEqual(await p.verify(token), { ok: false, reason: 'replayed' });
  });

  it('refuses a wrong number', async () => {
    const { p } = await provider();
    const c = await p.challenge();
    const right = decode(solve(c)).number;
    assert.deepStrictEqual(await p.verify(solve(c, { number: (right + 1) % 1001 })), { ok: false, reason: 'wrong_solution' });
  });

  it('refuses a challenge it did not sign', async () => {
    const { p } = await provider();
    const c = await p.challenge();
    assert.deepStrictEqual(await p.verify(solve({ ...c, signature: 'f'.repeat(64) })), { ok: false, reason: 'bad_signature' });
  });

  it('refuses a moved expiry: the signature covers the salt', async () => {
    const { p } = await provider();
    const c = await p.challenge();
    const { number } = decode(solve(c));
    const salt = c.salt.replace(/expires=\d+/, 'expires=9999999999');
    const token = encode({ algorithm: 'SHA-256', challenge: sha256(`${salt}${number}`), number, salt, signature: c.signature });
    assert.deepStrictEqual(await p.verify(token), { ok: false, reason: 'bad_signature' });
  });

  it('refuses an expired challenge', async () => {
    const { p, clock } = await provider();
    const token = solve(await p.challenge());
    clock.ms += 301_000;
    assert.deepStrictEqual(await p.verify(token), { ok: false, reason: 'expired' });
  });

  const malformed: [string, string][] = [
    ['a token that is not base64 JSON', 'not-a-token'],
    ['another algorithm', encode({ algorithm: 'SHA-1', challenge: 'a'.repeat(64), number: 1, salt: 's?expires=9999999999', signature: 'b'.repeat(64) })],
    ['a salt without expiry', encode({ algorithm: 'SHA-256', challenge: 'a'.repeat(64), number: 1, salt: 'abc', signature: 'b'.repeat(64) })],
    ['a number over maxNumber', encode({ algorithm: 'SHA-256', challenge: 'a'.repeat(64), number: 1001, salt: 'abc?expires=9999999999', signature: 'b'.repeat(64) })],
  ];
  for (const [label, token] of malformed) {
    it(`refuses ${label} as malformed`, async () => {
      const { p } = await provider();
      assert.deepStrictEqual(await p.verify(token), { ok: false, reason: 'malformed' });
    });
  }

  it('claims redeemed challenges in the NonceStore of its container when none is given', async () => {
    const { child } = await boot(SCHEMAS, SETTINGS);
    const store = new MemoryNonceStore();
    child.register({ KitNonceStore: () => store }.KitNonceStore).as(NonceStore);
    const p = readingFrom(new AltchaCaptchaProvider(child), child);
    const token = solve(await p.challenge());
    assert.deepStrictEqual(await p.verify(token), { ok: true });
    assert.strictEqual(await store.claim(`altcha:${decode(token).challenge}`, new Date(Date.now() + 60_000), new Date()), false, 'the challenge is claimed');
  });

  it('tells a client the widget only: no site key', async () => {
    const { p } = await provider();
    assert.deepStrictEqual(p.client(), { provider: 'altcha' });
  });
});
```

Append to `packages/authn-captcha/test/schema.test.ts` (the `boot` import is added to the existing import from `./support/config-boot.js`, and `Configuration` from `@spinajs/configuration`):

```ts
describe('authn-captcha schema: altcha', function () {
  this.timeout(30000);
  afterEach(disposeBooted);

  it('needs authn.captcha.altcha once the provider is AltchaCaptchaProvider', async () => {
    const paths = await violationsOf(SCHEMAS, { authn: { captcha: { provider: 'AltchaCaptchaProvider' } } });
    assert.ok(paths.includes('authn.captcha.altcha'), paths.join(', '));
  });

  it('needs an HMAC key of at least 32 characters and bounds maxNumber and expiresSeconds', async () => {
    const at = (altcha: Record<string, unknown>) => violationsOf(SCHEMAS, { authn: { captcha: { provider: 'AltchaCaptchaProvider', altcha } } });
    assert.ok((await at({ hmacKey: { secret: 'x'.repeat(31) } })).includes('authn.captcha.altcha.hmacKey.secret'));
    assert.ok((await at({ hmacKey: { secret: 'x'.repeat(32) }, maxNumber: 999 })).includes('authn.captcha.altcha.maxNumber'));
    assert.ok((await at({ hmacKey: { secret: 'x'.repeat(32) }, expiresSeconds: 3601 })).includes('authn.captcha.altcha.expiresSeconds'));
  });

  it('fills maxNumber 100000 and expiresSeconds 300', async () => {
    const { configuration } = await boot(SCHEMAS, { authn: { captcha: { provider: 'AltchaCaptchaProvider', altcha: { hmacKey: { secret: 'x'.repeat(32) } } } } });
    assert.deepStrictEqual(configuration.get('authn.captcha.altcha'), { hmacKey: { secret: 'x'.repeat(32) }, maxNumber: 100000, expiresSeconds: 300 });
  });
});
```

and change the import line of that file to:

```ts
import { boot, disposeBooted, violationsOf } from './support/config-boot.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/authn-captcha && npx ts-mocha -p tsconfig.json test/altcha.test.ts test/schema.test.ts`
Expected: FAIL at compile time: `Module '"../src/index.js"' has no exported member 'AltchaCaptchaProvider'`.

- [ ] **Step 3: Implement**

Replace `packages/authn-captcha/src/schema.ts` with:

```ts
const secretRef = (description: string, minLength = 1) => ({
  type: 'object',
  description: `${description} A reference the configuration resolves (e.g. aws-parameters://), never an inline value.`,
  propertyNames: { enum: ['secret'] },
  properties: { secret: { type: 'string', minLength } },
  required: ['secret'],
});

const requiredFor = (provider: string, block: string) => ({
  if: { type: 'object', required: ['provider'], properties: { provider: { const: provider } } },
  then: { required: [block] },
});

/** authn.captcha.turnstile and authn.captcha.altcha; the core schema (AUTHN_CONFIGURATION_SCHEMA) owns the rest of authn.captcha. */
export const AUTHN_CAPTCHA_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-captcha.configuration.schema.json',
  $configurationModule: 'authn.captcha',
  description: 'CAPTCHA provider settings (@spinajs/authn-captcha)',
  type: 'object',
  properties: {
    turnstile: {
      type: 'object',
      propertyNames: { enum: ['siteKey', 'secret'] },
      properties: {
        siteKey: { type: 'string', minLength: 1, description: 'The public site key the widget renders with.' },
        secret: secretRef('The Turnstile secret key of the site.'),
      },
      required: ['siteKey', 'secret'],
    },
    altcha: {
      type: 'object',
      propertyNames: { enum: ['hmacKey', 'maxNumber', 'expiresSeconds'] },
      properties: {
        hmacKey: secretRef('HMAC-SHA256 key that signs the challenges; at least 32 characters.', 32),
        maxNumber: { type: 'integer', minimum: 1000, maximum: 10000000, default: 100000, description: 'The solution lies in 0..maxNumber; a browser tries half of them on average.' },
        expiresSeconds: { type: 'integer', minimum: 10, maximum: 3600, default: 300, description: 'How long a challenge can be solved and redeemed.' },
      },
      required: ['hmacKey'],
    },
  },
  allOf: [requiredFor('TurnstileCaptchaProvider', 'turnstile'), requiredFor('AltchaCaptchaProvider', 'altcha')],
};
```

Create `packages/authn-captcha/src/altcha.ts`:

```ts
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Container, Inject, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { CaptchaProvider } from '@spinajs/authn/contracts';
import type { CaptchaClientInfo, CaptchaVerdict } from '@spinajs/authn/contracts';
import { NonceStore } from '@spinajs/authn-orm';

/** `authn.captcha.altcha` as the schema delivers it. */
export interface AltchaSettings {
  readonly hmacKey: { readonly secret: string };
  readonly maxNumber: number;
  readonly expiresSeconds: number;
}

/** The challenge format the ALTCHA widget reads (field names are the widget's). */
export interface AltchaChallenge {
  readonly algorithm: 'SHA-256';
  readonly challenge: string;
  readonly maxnumber: number;
  readonly salt: string;
  readonly signature: string;
}

export interface AltchaOptions {
  /** Epoch milliseconds; default Date.now. */
  readonly now?: () => number;
  /** Default: the container's NonceStore (DbNonceStore of @spinajs/authn-orm). */
  readonly nonces?: NonceStore;
}

interface Solution {
  readonly challenge: string;
  readonly number: number;
  readonly salt: string;
  readonly signature: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SALT_CAP = 200;

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// Both sides are 64 hex characters: checked on the client's, computed on ours.
const sameHex = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function parse(token: string): Solution | null {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!isObject(v) || v.algorithm !== 'SHA-256') return null;
  const { challenge, number, salt, signature } = v;
  if (typeof challenge !== 'string' || !HEX64.test(challenge) || typeof signature !== 'string' || !HEX64.test(signature)) return null;
  if (typeof salt !== 'string' || salt.length > SALT_CAP || typeof number !== 'number') return null;
  return { challenge, number, salt, signature };
}

/**
 * Self-hosted proof of work (ALTCHA): no third party sees the client. challenge() signs sha256(salt + n) for a random
 * n ≤ maxNumber; the widget finds n by brute force and sends back base64(JSON). The salt carries the expiry, so the
 * signature covers it. A solution redeems once: its challenge is claimed in the NonceStore until it expires.
 */
@Injectable(CaptchaProvider)
@Inject(Container)
export class AltchaCaptchaProvider extends CaptchaProvider {
  @Config('authn.captcha.altcha')
  protected Settings: AltchaSettings | undefined;

  private readonly now: () => number;

  /** `options` is for tests; DI passes only the container. */
  constructor(private readonly container: IContainer, private readonly options: AltchaOptions = {}) {
    super();
    this.now = options.now ?? (() => Date.now());
  }

  public client(): CaptchaClientInfo {
    return { provider: 'altcha' };
  }

  public async challenge(): Promise<AltchaChallenge> {
    const s = this.settings();
    const expires = Math.floor(this.now() / 1000) + s.expiresSeconds;
    const salt = `${randomBytes(12).toString('hex')}?expires=${expires}`;
    const challenge = sha256(`${salt}${randomInt(0, s.maxNumber + 1)}`);
    return { algorithm: 'SHA-256', challenge, maxnumber: s.maxNumber, salt, signature: this.sign(challenge) };
  }

  public async verify(token: string): Promise<CaptchaVerdict> {
    const s = this.settings();
    const p = parse(token);
    if (!p || !Number.isInteger(p.number) || p.number < 0 || p.number > s.maxNumber || !p.salt.includes('?')) return { ok: false, reason: 'malformed' };
    const expires = Number(new URLSearchParams(p.salt.slice(p.salt.indexOf('?') + 1)).get('expires'));
    if (!Number.isInteger(expires) || expires <= 0) return { ok: false, reason: 'malformed' };
    if (expires * 1000 <= this.now()) return { ok: false, reason: 'expired' };
    if (!sameHex(p.signature, this.sign(p.challenge))) return { ok: false, reason: 'bad_signature' };
    if (!sameHex(p.challenge, sha256(`${p.salt}${p.number}`))) return { ok: false, reason: 'wrong_solution' };
    const fresh = await (await this.nonces()).claim(`altcha:${p.challenge}`, new Date(expires * 1000), new Date(this.now()));
    return fresh ? { ok: true } : { ok: false, reason: 'replayed' };
  }

  private sign(challenge: string): string {
    return createHmac('sha256', this.settings().hmacKey.secret).update(challenge, 'utf8').digest('hex');
  }

  private async nonces(): Promise<NonceStore> {
    return this.options.nonces ?? (await this.container.resolve(NonceStore));
  }

  private settings(): AltchaSettings {
    const s = this.Settings;
    // The schema requires the block once this provider is named, so only an unregistered schema gets here.
    if (!s?.hmacKey?.secret) throw new Error('authn.captcha.altcha is not set: register AUTHN_CAPTCHA_CONFIGURATION_SCHEMA (AuthnCaptchaConfigBootstrapper)');
    return s;
  }
}
```

Append to `packages/authn-captcha/src/index.ts`:

```ts
export * from './altcha.js';
```

- [ ] **Step 4: Run the tests, build**

1. `cd packages/authn-captcha && npx ts-mocha -p tsconfig.json test/altcha.test.ts test/schema.test.ts` → PASS (altcha: 12 passing; schema: 6 passing).
2. `npm test` → 0 failing.
3. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && cd ../.. && node scripts/generate-packages-for-modules.mjs`

- [ ] **Step 5: Commit**

```bash
git add packages/authn-captcha/src/altcha.ts packages/authn-captcha/src/schema.ts packages/authn-captcha/src/index.ts packages/authn-captcha/test/altcha.test.ts packages/authn-captcha/test/schema.test.ts
git diff --cached --stat
git commit -m "feat(authn-captcha): self-hosted ALTCHA proof-of-work provider, single use through NonceStore"
```

---

### Task 7: Behaviour rule A33 and the core lane

**Files:**
- Create: `packages/authn-testing/src/fakes/captcha.ts`
- Modify: `packages/authn-testing/src/fakes/index.ts` (append an export)
- Modify: `packages/authn-testing/src/harness/ports.ts:1` (import), `:52` (Harness member), new `CaptchaPort` interface after `EventsPort` (line 123)
- Modify: `packages/authn-testing/src/harness/config.ts` (`ConfigOverrides.authn.captcha`)
- Modify: `packages/authn-testing/src/behaviour/types.ts:8` (`RULE_IDS`), `:16-55` (`portNames`)
- Create: `packages/authn-testing/src/behaviour/A33-captcha.spec.ts`
- Modify: `packages/authn-testing/src/behaviour/index.ts` (import and `ALL`)
- Modify: `packages/authn-testing/test/registry.test.ts:6` (`FACET_MAP`), `:46-52` (the RULE_IDS case)
- Modify: `packages/authn-testing/README.md:110` (N1 row)
- Modify: `packages/authn/test/behaviour/harness.ts:5,8,13`, `CoreParts` (47-67), `buildCore` (195-204), `prepareCore` (207-253), `coreHarnessOf` (316-353)
- Modify: `packages/authn/test/behaviour/core.test.ts:11,15`

**Interfaces:**
- Consumes: `CaptchaGate`, `CaptchaProvider` (Task 1); `DefaultCaptchaGate` registered by `@spinajs/authn` (Task 4).
- Produces:
  - `class StubCaptchaProvider extends CaptchaProvider { calls; solve(): string; failNext(): void; verify; client() → { provider: 'stub', siteKey: 'stub-site-key' }; challenge() → { stub: true } }` from `@spinajs/authn-testing`
  - `interface CaptchaPort { readonly gate: CaptchaGate; solve(): string; failNext(): void }`; `Harness.captcha?: CaptchaPort`; port name `'captcha'`
  - `ConfigOverrides.authn.captcha { flows, adaptive { windowSeconds, threshold, ipThreshold }, timeoutMs, failOpen }`
  - Rule `A33` with facet `A33/core`; core lane constant `KIT_CAPTCHA_PROVIDER = 'KitCaptchaProvider'`

- [ ] **Step 1: Write the failing tests (rule, registry pins, lane)**

Create `packages/authn-testing/src/behaviour/A33-captcha.spec.ts`:

```ts
import assert from 'node:assert/strict';
import type { AuthnEvent } from '@spinajs/authn/contracts';
import type { CaptchaPort, Harness } from '../harness/ports.js';
import { ALICE, IP_A, IP_B, NOBODY, seedUser } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

const FLOWS = ['login', 'register', 'reset', 'code', 'verify'] as const;

const fails = (h: Harness): AuthnEvent[] => h.events!.all().filter((e) => e.type === 'captcha.fail');

async function asks(c: CaptchaPort, ip: string, accounts: readonly string[]): Promise<boolean[]> {
  const out: boolean[] = [];
  for (const account of accounts) out.push(await c.gate.required('login', { ip, account }));
  return out;
}

export const A33: AuthnRule = defineRule('A33', 'a CAPTCHA guards a flow without telling accounts apart', [
  defineCase({
    name: 'A33 every flow is off by default',
    facet: 'A33/core',
    needs: ['captcha'],
    async run(h) {
      for (const flow of FLOWS) assert.strictEqual(await h.captcha.gate.required(flow, { ip: IP_A }), false, flow);
    },
  }),
  defineCase({
    name: "A33 an 'always' flow asks on every request",
    facet: 'A33/core',
    needs: ['captcha'],
    config: { authn: { captcha: { flows: { reset: 'always' } } } },
    async run(h) {
      for (let i = 0; i < 3; i++) assert.strictEqual(await h.captcha.gate.required('reset', { ip: IP_A, account: ALICE.login }), true);
      assert.strictEqual(await h.captcha.gate.required('login', { ip: IP_A }), false);
    },
  }),
  defineCase({
    name: 'A33 a solved token verifies once; a missing, wrong or reused one is refused and audited as captcha.fail',
    facet: 'A33/core',
    needs: ['captcha', 'events'],
    config: { authn: { captcha: { flows: { login: 'always' } } } },
    async run(h) {
      const token = h.captcha.solve();
      assert.strictEqual(await h.captcha.gate.verify('login', token, { ip: IP_A }), true);
      assert.strictEqual(await h.captcha.gate.verify('login', token, { ip: IP_A }), false, 'reused');
      assert.strictEqual(await h.captcha.gate.verify('login', undefined, { ip: IP_A }), false, 'missing');
      assert.strictEqual(await h.captcha.gate.verify('login', 'not-a-solved-token', { ip: IP_A }), false, 'wrong');
      assert.deepStrictEqual(fails(h).map((e) => e.reason), ['invalid', 'missing', 'invalid']);
      for (const e of fails(h)) {
        assert.strictEqual(e.outcome, 'failure');
        assert.strictEqual(e.ip, IP_A);
        assert.strictEqual((e.data as { flow?: unknown }).flow, 'login');
      }
      assert.ok(!JSON.stringify(h.events.all()).includes(token), 'no event carries the token');
    },
  }),
  defineCase({
    name: 'A33 adaptive: an ip over ipThreshold is asked, another ip is not',
    facet: 'A33/core',
    needs: ['captcha'],
    config: { authn: { captcha: { flows: { login: 'adaptive' }, adaptive: { ipThreshold: 2 } } } },
    async run(h) {
      assert.deepStrictEqual(await asks(h.captcha, IP_A, [NOBODY, NOBODY, NOBODY]), [false, false, true]);
      assert.deepStrictEqual(await asks(h.captcha, IP_B, [NOBODY]), [false]);
    },
  }),
  defineCase({
    name: 'A33 adaptive: every client is asked once the flow is over threshold',
    facet: 'A33/core',
    needs: ['captcha'],
    config: { authn: { captcha: { flows: { login: 'adaptive' }, adaptive: { threshold: 3 } } } },
    async run(h) {
      const seen: boolean[] = [];
      for (const ip of ['198.18.0.1', '198.18.0.2', '198.18.0.3', '198.18.0.4']) seen.push(...(await asks(h.captcha, ip, [NOBODY])));
      assert.deepStrictEqual(seen, [false, false, false, true]);
    },
  }),
  defineCase({
    name: 'A33 adaptive: the answer is the same for an existing and an unknown account',
    facet: 'A33/core',
    needs: ['captcha', 'seed'],
    config: { authn: { captcha: { flows: { login: 'adaptive' }, adaptive: { ipThreshold: 2 } } } },
    async run(h) {
      await seedUser(h, ALICE);
      assert.deepStrictEqual(await asks(h.captcha, IP_A, [ALICE.login, NOBODY, ALICE.login, NOBODY]), await asks(h.captcha, IP_B, [NOBODY, ALICE.login, NOBODY, ALICE.login]));
    },
  }),
  defineCase({
    name: 'A33 adaptive: the pressure ends when the requests stop',
    facet: 'A33/core',
    needs: ['captcha', 'fakeDate'],
    config: { authn: { captcha: { flows: { login: 'adaptive' }, adaptive: { windowSeconds: 60, ipThreshold: 1 } } } },
    async run(h, k) {
      assert.deepStrictEqual(await asks(h.captcha, IP_A, [NOBODY, NOBODY]), [false, true]);
      k.clock.tick(120_000);
      assert.deepStrictEqual(await asks(h.captcha, IP_A, [NOBODY]), [false]);
    },
  }),
  defineCase({
    name: 'A33 a provider that cannot answer fails closed',
    facet: 'A33/core',
    needs: ['captcha', 'events'],
    config: { authn: { captcha: { flows: { login: 'always' } } } },
    async run(h) {
      h.captcha.failNext();
      assert.strictEqual(await h.captcha.gate.verify('login', h.captcha.solve(), { ip: IP_A }), false);
      assert.deepStrictEqual(fails(h).map((e) => e.reason), ['provider_error']);
    },
  }),
  defineCase({
    name: 'A33 failOpen lets a request through only when the provider cannot answer',
    facet: 'A33/core',
    needs: ['captcha'],
    config: { authn: { captcha: { flows: { login: 'always' }, failOpen: true } } },
    async run(h) {
      h.captcha.failNext();
      assert.strictEqual(await h.captcha.gate.verify('login', h.captcha.solve(), {}), true);
      assert.strictEqual(await h.captcha.gate.verify('login', 'not-a-solved-token', {}), false);
    },
  }),
]);
```

In `packages/authn-testing/test/registry.test.ts`:
- Line 6: append `'A33/core'` as the last entry of `FACET_MAP`.
- Replace the case at lines 46-52 with:

```ts
  it('RULE_IDS are A01–A27 and A30–A33 in order', () => {
    const expected = [...Array.from({ length: 27 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`), 'A30', 'A31', 'A32', 'A33'];
    assert.deepStrictEqual([...RULE_IDS], expected);
    assert.deepStrictEqual([...AUTHN_RULES.keys()], expected);
    assert.strictEqual(AUTHN_RULES.has('A28' as RuleId), false);
    assert.strictEqual(AUTHN_RULES.has('A29' as RuleId), false);
  });
```

In `packages/authn/test/behaviour/core.test.ts`, line 11 gets `'A33/core'` appended to `FACETS`, and line 15 gets `'A33'` appended to the rule list:

```ts
const FACETS: Facet[] = ['A01/core', 'A02/core', 'A02/external', 'A05/core', 'A06/core', 'A09/core', 'A10/core', 'A13/core', 'A19/core', 'A20/core', 'A21/core', 'A23/core', 'A24/boot', 'A33/core'];
```

```ts
  runAuthnBehaviour(['A01', 'A02', 'A05', 'A06', 'A09', 'A10', 'A13', 'A19', 'A20', 'A21', 'A23', 'A24', 'A33'], coreHarness, { title: 'authn behaviour: DefaultAuthnService', facets: FACETS, claim: FACETS });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registry.test.ts`
Expected: FAIL at compile time: `Property 'captcha' does not exist on type 'Harness'` and `Argument of type '"A33"' is not assignable to parameter of type 'RuleId'` (A33-captcha.spec.ts).

- [ ] **Step 3: Implement the kit**

Create `packages/authn-testing/src/fakes/captcha.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { CaptchaProvider } from '@spinajs/authn/contracts';
import type { CaptchaClientInfo, CaptchaVerdict } from '@spinajs/authn/contracts';

/**
 * A provider for tests: solve() mints a token that verifies once; any other token is refused as
 * 'invalid-input-response'. failNext() makes the next verify reject as an unreachable provider does. It offers a
 * challenge, as a self-hosted provider does.
 */
export class StubCaptchaProvider extends CaptchaProvider {
  public readonly calls: { token: string; ip?: string }[] = [];
  private readonly live = new Set<string>();
  private failing = 0;

  public solve(): string {
    const token = `stub-${randomUUID()}`;
    this.live.add(token);
    return token;
  }

  public failNext(): void {
    this.failing++;
  }

  public async verify(token: string, ip?: string): Promise<CaptchaVerdict> {
    this.calls.push({ token, ...(ip !== undefined ? { ip } : {}) });
    if (this.failing > 0) {
      this.failing--;
      throw new TypeError('stub provider unreachable');
    }
    return this.live.delete(token) ? { ok: true } : { ok: false, reason: 'invalid-input-response' };
  }

  public client(): CaptchaClientInfo {
    return { provider: 'stub', siteKey: 'stub-site-key' };
  }

  public async challenge(): Promise<Readonly<Record<string, unknown>>> {
    return { stub: true };
  }
}
```

Append to `packages/authn-testing/src/fakes/index.ts`:

```ts
export * from './captcha.js';
```

In `packages/authn-testing/src/harness/ports.ts`, add `CaptchaGate` to the type import of line 1 (alphabetical position after `AuthenticationStrategy`), add the member before `readonly http?: HttpPort;` (line 52):

```ts
  readonly captcha?: CaptchaPort;
```

and after the `EventsPort` interface (ends at line 123):

```ts

export interface CaptchaPort {
  readonly gate: CaptchaGate;
  /** A token the lane's provider accepts once. */
  solve(): string;
  /** The provider's next verify rejects as an unreachable provider does. */
  failNext(): void;
}
```

In `packages/authn-testing/src/harness/config.ts`, add inside `ConfigOverrides.authn`'s `DeepPartial<{ … }>`, after the `impersonation` line:

```ts
    /** `provider` is the lane's own; cases never name it. */
    captcha: {
      flows: { login: CaptchaModeOverride; register: CaptchaModeOverride; reset: CaptchaModeOverride; code: CaptchaModeOverride; verify: CaptchaModeOverride };
      adaptive: { windowSeconds: number; threshold: number; ipThreshold: number };
      timeoutMs: number;
      failOpen: boolean;
    };
```

and above `export interface ConfigOverrides`:

```ts
export type CaptchaModeOverride = 'off' | 'always' | 'adaptive';
```

In `packages/authn-testing/src/behaviour/types.ts`, line 8 becomes:

```ts
export const RULE_IDS = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24', 'A25', 'A26', 'A27', 'A30', 'A31', 'A32', 'A33'] as const;
```

and in `portNames`, before `http: 1,`:

```ts
  captcha: 1,
```

In `packages/authn-testing/src/behaviour/index.ts`, add after the A32 import:

```ts
import { A33 } from './A33-captcha.spec.js';
```

and append `A33` to `ALL`:

```ts
const ALL: readonly AuthnRule[] = [A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A30, A31, A32, A33];
```

In `packages/authn-testing/README.md:110`, the N1 row becomes:

```md
| N1 | A01/core, A02/core, A02/external, A05/store, A05/core, A06/store, A06/core, A09/core, A13/core, A19/core, A20/core, A21/core, A23/core, A24/boot, A33/core |
```

- [ ] **Step 4: Run the kit tests, build the kit**

1. `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registry.test.ts` → PASS.
2. `npm test` in `packages/authn-testing` → 0 failing. If a test pins the port list or the rule count, add `captcha` / A33 to that pin (the same change as above, no other).
3. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && cd ../.. && node scripts/generate-packages-for-modules.mjs`

- [ ] **Step 5: Wire the core lane**

In `packages/authn/test/behaviour/harness.ts`:
- Line 5: add `StubCaptchaProvider` to the `@spinajs/authn-testing` import.
- Line 8: add `CaptchaGate, CaptchaProvider` to the `../../src/index.js` import.
- Line 13 becomes:

```ts
export const CORE_SUPPORTED: readonly string[] = ['env', 'authn.throttle', 'authn.linking', 'authn.session', 'authn.mfa.policy.force', 'authn.freshAuth', 'authn.impersonation', 'authn.captcha'];

/** The service name of the kit CAPTCHA provider, set as authn.captcha.provider in every core boot. */
export const KIT_CAPTCHA_PROVIDER = 'KitCaptchaProvider';
```

- In `CoreParts`, after `readonly guard: FakeImpersonationGuard;`:

```ts
  readonly captcha: StubCaptchaProvider;
  readonly captchaGate: CaptchaGate;
```

- `buildCore`'s return line (199) becomes:

```ts
    return { ...parts, service: await parts.child.resolve(AuthnService), captchaGate: await parts.child.resolve(CaptchaGate) };
```

- `prepareCore`'s signature (207) becomes:

```ts
async function prepareCore(config: ConfigOverrides, opts: CoreOptions): Promise<Omit<CoreParts, 'service' | 'captchaGate'>> {
```

- In `prepareCore`, after `const guard = new FakeImpersonationGuard();` (218):

```ts
  const captcha = new StubCaptchaProvider();
```

- Line 223 becomes:

```ts
  const authn = deepMerge({ mfa: { steps: [{ name: step.name, service: KIT_MFA_STEP }] }, captcha: { provider: KIT_CAPTCHA_PROVIDER } }, { ...(config.authn ?? {}), strategies: strategies.filter((s) => s.listed).map((s) => ({ name: s.name, service: s.service })) });
```

- After `bind(child, MfaStep, KIT_MFA_STEP, step);` (243):

```ts
    bind(child, CaptchaProvider, KIT_CAPTCHA_PROVIDER, captcha);
```

- The returned object (248) gets `captcha` after `guard`:

```ts
    return { child, configuration, identities, passwords, sessions, throttle, events, second, principals, links, step, guard, captcha, tokens, externalSubjects, strategies, dispose: () => child.dispose() };
```

- In `coreHarnessOf`, after `guard: parts.guard,` (340):

```ts
    captcha: { gate: parts.captchaGate, solve: () => parts.captcha.solve(), failNext: () => parts.captcha.failNext() },
```

- [ ] **Step 6: Run the core lane and the authn suite**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/behaviour/core.test.ts` → PASS; the A33 describe shows 9 passing cases.
2. `npm test` in `packages/authn` → 0 failing.

- [ ] **Step 7: Commit**

```bash
git add packages/authn-testing/src/fakes/captcha.ts packages/authn-testing/src/fakes/index.ts packages/authn-testing/src/harness/ports.ts packages/authn-testing/src/harness/config.ts packages/authn-testing/src/behaviour/types.ts packages/authn-testing/src/behaviour/A33-captcha.spec.ts packages/authn-testing/src/behaviour/index.ts packages/authn-testing/test/registry.test.ts packages/authn-testing/README.md packages/authn/test/behaviour/harness.ts packages/authn/test/behaviour/core.test.ts
git diff --cached --stat
git commit -m "test(authn-testing): behaviour rule A33 for the CAPTCHA gate, run by the core lane"
```

---

### Task 8: 3.0 HTTP: messages, login wiring, `GET /auth/captcha` and the challenge route

**Prerequisite:** plan 03 has landed. Check before Step 1:
- `ls packages/authn/src/messages/index.ts` lists the file.
- `grep -n "AuthnMessage" packages/authn/src/messages/*.ts` shows an interface with at least `id: number`, `type: 'info' | 'error'`, `text: string` and an optional `context`.
- `grep -n "messages" packages/authn/src/index.ts` shows the folder exported from the root barrel.

If a field name differs, stop and report: the IDs and texts below are binding, the field names follow plan 03.

**Files:**
- Create: `packages/authn/src/messages/captcha.ts`
- Modify: `packages/authn/src/messages/index.ts` (append an export)
- Create: `packages/authn/test/captcha/messages.test.ts`
- Create: `packages/authn-http/src/v3/captcha.ts`
- Create: `packages/authn-http/src/v3/controllers/AuthnCaptchaController.ts`
- Modify: `packages/authn-http/src/v3/controllers/AuthnLoginController.ts:10` (import) and `:46-48` (the gate)
- Modify: `packages/authn-http/test/v3-app/app.ts:13,17` (imports), after `:93` (the stub), `V3AppConfiguration.onLoad` `authn` (after line 67), `wire()` (after line 143)
- Create: `packages/authn-http/test/v3-app/suites/captcha.ts`
- Modify: `packages/authn-http/test/v3-app/account.test.ts:10,29`
- Modify: `packages/authn-http/test/v3-app/suites/route-table.ts:39`
- Modify: `packages/authn-http/test/v3/inert.test.ts:36`

**Interfaces:**
- Consumes: `CaptchaGate`, `CaptchaProvider`, `CaptchaFlow`, `CaptchaClientInfo`, `CAPTCHA_FLOWS` (`@spinajs/authn/contracts`); `configuredCaptchaProvider` (Task 4); `StubCaptchaProvider` (Task 7); plan 03's `AuthnMessage`; `bodyField` (`packages/authn-http/src/v3/routes.ts:25`), `NO_STORE` (`responses.ts:17`), `notFound` (`policies/v3/errors.ts:19`).
- Produces:
  - `CAPTCHA_MESSAGES { challenge: 1003001, missing: 4003001, invalid: 4003002 }` from `@spinajs/authn`
  - In `packages/authn-http/src/v3/captcha.ts`: `CAPTCHA_HEADER = 'x-captcha-token'`, `CAPTCHA_FIELD = 'captcha'`, `type CaptchaWidget = CaptchaClientInfo & { readonly challenge: boolean }`, `widgetOf(p: CaptchaProvider): CaptchaWidget`, `captchaTokenOf(req): string | undefined`, `captchaRefusal(container, req, flow, account?, cookies?): Promise<BadRequestResponse | null>`, `captchaAnswer(container, outcome: 'missing' | 'invalid', cookies?): Promise<BadRequestResponse>`
  - Routes `GET /auth/captcha` → `{ provider: string | null, siteKey?, challenge: boolean, flows: Record<CaptchaFlow, mode> }`; `GET /auth/captcha/challenge` → the provider's challenge, or 404 `E_NO_CAPTCHA_CHALLENGE`

- [ ] **Step 1: Write the failing tests**

Create `packages/authn/test/captcha/messages.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';

import { CAPTCHA_MESSAGES } from '../../src/index.js';

describe('CAPTCHA messages', () => {
  it('use plan 05 ids only: info 1003xxx, errors 4003xxx, each once', () => {
    const all = Object.values(CAPTCHA_MESSAGES);
    assert.deepStrictEqual(all.map((m) => m.id), [1003001, 4003001, 4003002]);
    for (const m of all) assert.ok(m.type === 'info' ? m.id >= 1003000 && m.id <= 1003999 : m.id >= 4003000 && m.id <= 4003999, String(m.id));
    assert.ok(Object.isFrozen(CAPTCHA_MESSAGES));
  });
});
```

Create `packages/authn-http/test/v3-app/suites/captcha.ts`:

```ts
import { expect } from 'chai';

import { Client, captchaProvider, config, events, passwordStrategy, resetRecorders, seedUser, throttle } from '../app.js';
import type { Res } from '../app.js';

const LOGIN_FLOW = 'authn.captcha.flows.login';
const WRONG = 'Wrong-Pass-9876';

async function withMode(mode: 'always' | 'adaptive', run: () => Promise<void>): Promise<void> {
  config().set(LOGIN_FLOW, mode);
  try {
    await run();
  } finally {
    config().set(LOGIN_FLOW, 'off');
  }
}

const ids = (res: Res): number[] => (res.body.messages as { id: number }[]).map((m) => m.id);

export function captchaSuite(): void {
  beforeEach(resetRecorders);

  describe('GET /auth/captcha', () => {
    it('answers the provider, its public site key, the challenge route and every flow off by default, uncached', async () => {
      const res = await new Client().get('/auth/captcha');
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ provider: 'stub', siteKey: 'stub-site-key', challenge: true, flows: { login: 'off', register: 'off', reset: 'off', code: 'off', verify: 'off' } });
      expect(res.headers['cache-control']).to.eq('no-store');
    });

    it("shows a flow's configured mode", async () => {
      await withMode('adaptive', async () => {
        expect((await new Client().get('/auth/captcha')).body.flows.login).to.eq('adaptive');
      });
    });
  });

  describe('GET /auth/captcha/challenge', () => {
    it("answers the provider's challenge, uncached", async () => {
      const res = await new Client().get('/auth/captcha/challenge');
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ stub: true });
      expect(res.headers['cache-control']).to.eq('no-store');
    });
  });

  describe('POST /auth/login under CAPTCHA', () => {
    it('always, no token: 400 with 4003001 and 1003001 carrying the widget; nothing reaches the strategy or the throttle', async () => {
      await withMode('always', async () => {
        const u = await seedUser();
        const res = await new Client().post('/auth/login', { login: u.login, password: u.password });
        expect(res.status).to.eq(400);
        expect(res.body.error).to.deep.eq({ code: 'E_CAPTCHA_REQUIRED', message: 'This request needs a solved challenge.' });
        expect(ids(res)).to.deep.eq([4003001, 1003001]);
        expect(res.body.messages[1].context).to.deep.eq({ provider: 'stub', siteKey: 'stub-site-key', challenge: true });
        expect(res.headers['cache-control']).to.eq('no-store');
        expect(passwordStrategy.verifyCalls).to.have.length(0);
        expect(throttle.attempts).to.have.length(0);
        expect(events.ofType('captcha.fail').map((e) => e.reason)).to.deep.eq(['missing']);
      });
    });

    it('always, a wrong token: 400 with 4003002', async () => {
      await withMode('always', async () => {
        const u = await seedUser();
        const res = await new Client().post('/auth/login', { login: u.login, password: u.password }, { 'X-Captcha-Token': 'not-a-solved-token' });
        expect(res.status).to.eq(400);
        expect(res.body.error.code).to.eq('E_CAPTCHA_INVALID');
        expect(ids(res)).to.deep.eq([4003002, 1003001]);
      });
    });

    it('always: a solved token in the X-Captcha-Token header or in the body field captcha logs in', async () => {
      await withMode('always', async () => {
        const u = await seedUser();
        expect((await new Client().post('/auth/login', { login: u.login, password: u.password }, { 'X-Captcha-Token': captchaProvider.solve() })).status).to.eq(200);
        expect((await new Client().post('/auth/login', { login: u.login, password: u.password, captcha: captchaProvider.solve() })).status).to.eq(200);
      });
    });

    it('always: the answer is the same for an existing and an unknown account (A02)', async () => {
      await withMode('always', async () => {
        const u = await seedUser();
        const known = await new Client().post('/auth/login', { login: u.login, password: WRONG });
        const unknown = await new Client().post('/auth/login', { login: `nobody-${Date.now()}@example.test`, password: WRONG });
        expect({ status: unknown.status, body: unknown.body }).to.deep.eq({ status: known.status, body: known.body });
      });
    });

    // Last: the only case in this process that counts adaptive requests, so the window holds no earlier ones.
    it('adaptive: with ipThreshold 1 the second login of an ip within the window needs a challenge', async () => {
      config().set('authn.captcha.adaptive.ipThreshold', 1);
      try {
        await withMode('adaptive', async () => {
          const u = await seedUser();
          const first = await new Client().post('/auth/login', { login: u.login, password: WRONG });
          const second = await new Client().post('/auth/login', { login: u.login, password: WRONG });
          expect(first.status).to.eq(401);
          expect(second.status).to.eq(400);
          expect(ids(second)).to.deep.eq([4003001, 1003001]);
        });
      } finally {
        config().set('authn.captcha.adaptive.ipThreshold', 10);
      }
    });
  });
}
```

In `packages/authn-http/test/v3-app/app.ts`:
- Line 13: add `CaptchaProvider` to the `@spinajs/authn/contracts` import.
- Line 17: add `StubCaptchaProvider` to the `@spinajs/authn-testing` import.
- After line 93 (`export const events = new RecordingEventSink();`):

```ts
export const captchaProvider = new StubCaptchaProvider();
```

- In `V3AppConfiguration.onLoad`, inside `authn`, after the `impersonation` line (67):

```ts
        // Every flow stays off (the schema default); the captcha suite switches login on per case.
        captcha: { provider: 'V3AppCaptchaProvider' },
```

- In `wire()`, after `DI.register(V3AppResponseExtension).as(AuthnResponseExtension);` (143):

```ts
  bind(CaptchaProvider, 'V3AppCaptchaProvider', () => captchaProvider);
```

In `packages/authn-http/test/v3-app/account.test.ts`, add after line 10:

```ts
import { captchaSuite } from './suites/captcha.js';
```

and after line 29 (`describe('route table', routeTableSuite);`):

```ts
    describe('CAPTCHA', captchaSuite);
```

In `packages/authn-http/test/v3-app/suites/route-table.ts`, after line 39 (`'DELETE /auth/impersonate',`):

```ts
  'GET /auth/captcha',
  'GET /auth/captcha/challenge',
```

In `packages/authn-http/test/v3/inert.test.ts:36`, append `'AuthnCaptchaController'` to `V3_CONTROLLERS`.

- [ ] **Step 2: Run the tests to verify they fail**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/captcha/messages.test.ts` → FAIL: `Module '"../../src/index.js"' has no exported member 'CAPTCHA_MESSAGES'`.
2. `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json` → FAIL in `CAPTCHA`: `GET /auth/captcha` answers 404, and the `always` login cases answer 200 instead of 400.

- [ ] **Step 3: Implement the messages (authn)**

Create `packages/authn/src/messages/captcha.ts`:

```ts
import type { AuthnMessage } from './index.js';

// Plan 05's range: 1003000–1003999 (info) and 4003000–4003999 (user errors). An id never changes meaning once released.

const challenge = { id: 1003001, type: 'info', text: 'Solve the challenge to continue.' } as const satisfies AuthnMessage;

const missing = { id: 4003001, type: 'error', text: 'This request needs a solved challenge.' } as const satisfies AuthnMessage;

const invalid = { id: 4003002, type: 'error', text: 'The challenge answer is wrong, used or expired. Solve a new one.' } as const satisfies AuthnMessage;

/** `challenge` goes with either error; its `context` carries the widget data (provider, siteKey, challenge). */
export const CAPTCHA_MESSAGES = Object.freeze({ challenge, missing, invalid });
```

Append to `packages/authn/src/messages/index.ts`:

```ts
export * from './captcha.js';
```

Run `cd packages/authn && npx ts-mocha -p tsconfig.json test/captcha/messages.test.ts` → PASS, 1 passing. Then rebuild: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && cd ../.. && node scripts/generate-packages-for-modules.mjs`.

- [ ] **Step 4: Implement the HTTP helper, the controller and the login wiring (authn-http)**

Create `packages/authn-http/src/v3/captcha.ts`:

```ts
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse } from '@spinajs/http';
import type { ICookie, Request } from '@spinajs/http';
import { CaptchaGate } from '@spinajs/authn/contracts';
import type { CaptchaClientInfo, CaptchaFlow, CaptchaProvider } from '@spinajs/authn/contracts';

import { NO_STORE } from './responses.js';
import { bodyField } from './routes.js';

// Helpers of the routes a CAPTCHA guards (login; the reset request; register, code and verify in plans 06–08).
// Not exported by any entry.

export const CAPTCHA_HEADER = 'x-captcha-token';
export const CAPTCHA_FIELD = 'captcha';

export type CaptchaWidget = CaptchaClientInfo & { readonly challenge: boolean };

/** What a client renders: the provider's widget data, and whether it fetches GET /auth/captcha/challenge. */
export const widgetOf = (p: CaptchaProvider): CaptchaWidget => ({ ...p.client(), challenge: typeof p.challenge === 'function' });

/** The solved token: the X-Captcha-Token header, else the body field `captcha`. Its length is the gate's check. */
export function captchaTokenOf(req: Request): string | undefined {
  const header = req.headers[CAPTCHA_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string' && value !== '') return value;
  const field = bodyField(req, CAPTCHA_FIELD);
  return typeof field === 'string' && field !== '' ? field : undefined;
}

/**
 * Null when the request may go on; else the 400 answer asking for a challenge. Call it once per request, after the
 * input bounds checks and before any lookup of the account (the default gate counts each call; A02). Without a
 * registered CaptchaGate, CAPTCHA is off.
 */
export async function captchaRefusal(container: IContainer, req: Request, flow: CaptchaFlow, account?: string, cookies: readonly ICookie[] = []): Promise<BadRequestResponse | null> {
  if (!container.hasRegistered(CaptchaGate)) return null;
  const gate = await container.resolve(CaptchaGate);
  const ip = req.storage.ClientIp;
  const at = typeof ip === 'string' && ip !== '' ? { ip } : {};
  if (!(await gate.required(flow, { ...at, ...(account !== undefined ? { account } : {}) }))) return null;
  const token = captchaTokenOf(req);
  if (await gate.verify(flow, token, at)) return null;
  return captchaAnswer(container, token === undefined ? 'missing' : 'invalid', cookies);
}

/** 400 with the error message (4003001 missing, 4003002 invalid) and the info message 1003001 carrying the widget. */
export async function captchaAnswer(container: IContainer, outcome: 'missing' | 'invalid', cookies: readonly ICookie[] = []): Promise<BadRequestResponse> {
  // Loaded here, not at module load: the @spinajs/authn root registers its services in every app that imports it.
  const { CAPTCHA_MESSAGES, configuredCaptchaProvider } = await import('@spinajs/authn');
  const provider = await configuredCaptchaProvider(container);
  const error = CAPTCHA_MESSAGES[outcome];
  const info = { ...CAPTCHA_MESSAGES.challenge, ...(provider ? { context: widgetOf(provider) } : {}) };
  const body = { error: { code: outcome === 'missing' ? 'E_CAPTCHA_REQUIRED' : 'E_CAPTCHA_INVALID', message: error.text }, messages: [error, info] };
  return new BadRequestResponse(body, { Headers: [NO_STORE], Coockies: [...cookies] });
}
```

Create `packages/authn-http/src/v3/controllers/AuthnCaptchaController.ts`:

```ts
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { CAPTCHA_FLOWS } from '@spinajs/authn/contracts';

import { notFound } from '../../policies/v3/errors.js';
import { widgetOf } from '../captcha.js';
import { NO_STORE } from '../responses.js';

// The 3.0 controllers are scanned only when an app lists src/v3/controllers (N8c); this file must not load the
// @spinajs/authn root at module load either.

/**
 * What a client needs before it shows a guarded form, and the challenge of a self-hosted provider. Both public.
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnCaptchaController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * CAPTCHA settings
   * The provider and its public site key (`provider: null` when none is set), whether the widget fetches its
   * challenge from GET /auth/captcha/challenge, and each flow's mode. An 'adaptive' flow asks for a challenge only
   * under load; the client learns it from a 400 answer carrying message 4003001.
   * @security []
   */
  @Get('captcha')
  public async settings() {
    const { configuredCaptchaProvider } = await import('@spinajs/authn');
    const provider = await configuredCaptchaProvider(this.Container);
    const modes = this._cfg.get<Record<string, string>>('authn.captcha.flows', {}) ?? {};
    const flows = Object.fromEntries(CAPTCHA_FLOWS.map((f) => [f, modes[f] ?? 'off']));
    return new Ok({ ...(provider ? widgetOf(provider) : { provider: null, challenge: false }), flows }, { Headers: [NO_STORE] });
  }

  /**
   * CAPTCHA challenge
   * A new challenge of a self-hosted provider (ALTCHA), never cached.
   * @security []
   * @response 404 The provider issues no challenges
   */
  @Get('captcha/challenge')
  public async challenge() {
    const { configuredCaptchaProvider } = await import('@spinajs/authn');
    const provider = await configuredCaptchaProvider(this.Container);
    if (!provider || typeof provider.challenge !== 'function') throw notFound('E_NO_CAPTCHA_CHALLENGE', 'the CAPTCHA provider issues no challenges');
    return new Ok(await provider.challenge(), { Headers: [NO_STORE] });
  }
}
```

In `packages/authn-http/src/v3/controllers/AuthnLoginController.ts`, after line 10 add:

```ts
import { captchaRefusal } from '../captcha.js';
```

and after line 46 (`if (login === null || password === null) return authnFailureResponse(undefined, cleared);`) add:

```ts
    // Before any lookup and before the throttle: a refused request neither names an account nor spends its free attempts.
    const refusal = await captchaRefusal(this.Container, req, 'login', login, cleared);
    if (refusal) return refusal;
```

In the method's doc comment (lines 26-30), append one sentence after "Any failure: 401 with one body, plus Retry-After when throttled.":

```ts
   * A flow under CAPTCHA (authn.captcha.flows.login) without a solved token (X-Captcha-Token or body `captcha`): 400
   * with message 4003001 or 4003002.
```

- [ ] **Step 5: Run the tests, build, run the package suite**

1. `cd packages/authn-http && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && cd ../.. && node scripts/generate-packages-for-modules.mjs && cd packages/authn-http`
2. `npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json` → PASS; the `CAPTCHA` describe shows 8 passing, 0 failing overall.
3. `npx ts-mocha -p tsconfig.json test/v3/inert.test.ts test/v3/route-table-n8c.test.ts` → PASS (the new controller loads no authn root at module load and clashes with no 2.x route).
4. `npm test` in `packages/authn-http` → 0 failing.
5. `npm test` in `packages/authn` → 0 failing.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/messages/captcha.ts packages/authn/src/messages/index.ts packages/authn/test/captcha/messages.test.ts packages/authn-http/src/v3/captcha.ts packages/authn-http/src/v3/controllers/AuthnCaptchaController.ts packages/authn-http/src/v3/controllers/AuthnLoginController.ts packages/authn-http/test/v3-app/app.ts packages/authn-http/test/v3-app/suites/captcha.ts packages/authn-http/test/v3-app/account.test.ts packages/authn-http/test/v3-app/suites/route-table.ts packages/authn-http/test/v3/inert.test.ts
git diff --cached --stat
git commit -m "feat(authn-http): CAPTCHA on 3.0 login, GET /auth/captcha and the challenge route"
```

---

### Task 9: CAPTCHA on the reset request

**Files:**
- Modify: `packages/authn-http/src/account/controllers/PasswordResetController.ts:1-8` (imports), class body (Container, `requestReset` at 63-77, a new protected method)
- Modify: `packages/authn-http/test/password-reset.test.ts:22-40` (stub), `:73,81,84,94` (the second argument), new cases in `describe('requestReset')`

**Interfaces:**
- Consumes: `captchaRefusal` (Task 8).
- Produces: `PasswordResetController.requestReset(payload: PasswordResetRequestDto, req: Request): Promise<Ok<IPasswordResetAck> | BadRequestResponse>`; `protected refusedByCaptcha(req: Request, login: string): Promise<BadRequestResponse | null>`.

- [ ] **Step 1: Write the failing tests**

In `packages/authn-http/test/password-reset.test.ts`:
- After line 24 (`let redeemStub: sinon.SinonStub;`) add:

```ts
  let captchaStub: sinon.SinonStub;

  // The controller only hands the request to the CAPTCHA helper; a bare object stands in for it.
  const REQ = {} as any;
```

- After line 40 (`redeemStub = …`) add:

```ts
    captchaStub = sinon.stub(controller as any, 'refusedByCaptcha').resolves(null);
```

- In the four calls at lines 73, 81, 84 and 94, add `REQ` as the second argument, e.g. line 73 becomes:

```ts
      const result = await controller.requestReset(new PasswordResetRequestDto({ Email: 'me@spinajs.pl' }), REQ);
```

- Append to `describe('requestReset', …)`:

```ts
    it('asks the CAPTCHA gate first and answers its refusal untouched, issuing no token', async () => {
      const refusal = new BadRequestResponse({ error: { code: 'E_CAPTCHA_REQUIRED' } });
      captchaStub.resolves(refusal);

      const result = await controller.requestReset(new PasswordResetRequestDto({ Email: 'me@spinajs.pl' }), REQ);

      expect(result).to.eq(refusal);
      sinon.assert.calledWith(captchaStub, REQ, 'me@spinajs.pl');
      sinon.assert.notCalled(issueStub);
    });

    it('issues the token when the gate lets the request through', async () => {
      const result = await controller.requestReset(new PasswordResetRequestDto({ Email: 'me@spinajs.pl' }), REQ);

      expect(result).to.be.instanceOf(Ok);
      sinon.assert.calledOnce(captchaStub);
      sinon.assert.calledWith(issueStub, 'me@spinajs.pl');
    });

    it("guards the 'reset' flow of the container's CaptchaGate with the client ip and the submitted login", async () => {
      captchaStub.restore();
      const calls: unknown[] = [];
      const gate = {
        required: async (flow: string, ctx: unknown) => {
          calls.push([flow, ctx]);
          return false;
        },
        verify: async () => true,
      };
      Object.defineProperty(controller, 'Container', { value: { hasRegistered: () => true, resolve: async () => gate }, configurable: true, writable: true });
      const req = { storage: { ClientIp: '192.0.2.10' }, headers: {}, body: {} } as any;

      await controller.requestReset(new PasswordResetRequestDto({ Email: 'me@spinajs.pl' }), req);

      expect(calls).to.deep.eq([['reset', { ip: '192.0.2.10', account: 'me@spinajs.pl' }]]);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/password-reset.test.ts`
Expected: FAIL: `Cannot stub non-existent property refusedByCaptcha` (and `Expected 1 arguments, but got 2` at compile time).

- [ ] **Step 3: Implement**

In `packages/authn-http/src/account/controllers/PasswordResetController.ts`, the imports (lines 1-8) become:

```ts
import '../../registrations.js';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Body, BadRequestResponse, Get, Ok, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { confirmPasswordReset, passwordChangeRequest, PasswordValidationProvider, RbacException } from '@spinajs/users';
import type { IPasswordPolicy } from '@spinajs/users';
import { InvalidArgument } from '@spinajs/exceptions';
import { AutoinjectService } from '@spinajs/configuration';
import { SkipModelPermission } from '../../decorators.js';
import { PasswordResetConfirmDto, PasswordResetRequestDto } from '../dto/password-reset-dto.js';
import { captchaRefusal } from '../../v3/captcha.js';
```

After `protected PasswordValidation: PasswordValidationProvider;` (line 38) add:

```ts

  @Autoinject(Container)
  protected Container!: IContainer;
```

Replace `requestReset` (lines 56-77, doc comment included) with:

```ts
  /**
   * Request a password reset
   * Issues a reset token for the account and emits `UserPasswordChangeRequest` so the
   * application can deliver it. Always succeeds, whether or not the address is known,
   * unless the `reset` flow is under CAPTCHA (authn.captcha.flows.reset) and the request
   * carries no solved token (X-Captcha-Token or body `captcha`): 400 with message 4003001 or 4003002.
   * @security []
   * @returns {IPasswordResetAck} Acknowledgement — never indicates whether the account exists
   */
  @Post('password/reset-request')
  @SkipModelPermission()
  public async requestReset(@Body() payload: PasswordResetRequestDto, @Req() req: Request): Promise<Ok<IPasswordResetAck> | BadRequestResponse> {
    // Before any lookup, so the answer cannot depend on the account (A02).
    const refusal = await this.refusedByCaptcha(req, payload.Email);
    if (refusal) return refusal;

    try {
      await this.issueToken(payload.Email);
    } catch (err) {
      // Swallowed on purpose. An unknown address, a deleted account or a
      // banned one must produce exactly the response a valid address does —
      // otherwise this route becomes an account enumeration oracle. Real
      // faults ( mail queue, database ) are logged for operators.
      this._log.warn(err as Error, `Password reset request could not be processed for ${payload.Email}`);
    }

    return new Ok({ Ok: true } as IPasswordResetAck);
  }
```

After `redeemToken` (end of the class, before the closing brace) add:

```ts

  /** The `reset` flow's CAPTCHA. Wrapped for the same reason as {@link issueToken}. */
  protected refusedByCaptcha(req: Request, login: string): Promise<BadRequestResponse | null> {
    return captchaRefusal(this.Container, req, 'reset', login);
  }
```

- [ ] **Step 4: Run the tests and the package suite**

1. `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/password-reset.test.ts` → PASS (3 new cases among the passing ones).
2. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` → no errors.
3. `npx ts-mocha -p tsconfig.json test/v3/inert.test.ts test/v3/route-table-n8c.test.ts` → PASS (`PasswordResetController` is still one of the two kept 2.x controllers).
4. `npm test` in `packages/authn-http` → 0 failing.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-http/src/account/controllers/PasswordResetController.ts packages/authn-http/test/password-reset.test.ts
git diff --cached --stat
git commit -m "feat(authn-http): CAPTCHA on the password reset request"
```

---

## Facts verified (2026-10-06, branch `authz-v3-refactor` at `ab38a0bd0`)

- README contract and ranges: `CaptchaGate` and `CaptchaFlow` (`docs/auth-feat/README.md:124-139`), ranges 1003000–1003999 / 4003000–4003999 (`:150`), `captcha.fail` (`:165`), conventions (`:172-184`).
- `AuthnContext` has no captcha field (`packages/authn/src/contracts/credentials.ts:26-34`); `AuthnFailure` is a closed union (`:74`); `PasswordResetRequestResult` is `accepted | throttled` (`packages/authn/src/contracts/password.ts:32`). Decision 1 leaves all three unchanged.
- `AuthnEventType` ends with `'throttle.block'` (`packages/authn/src/contracts/audit.ts:21`), pinned in order by `packages/authn/test/contracts/audit.test.ts:23,155`. `users/src/identity/queue-sink.ts` switches over some types without exhaustiveness, so a new member needs no change there.
- The contracts must import only `@spinajs/di` and register nothing (`packages/authn/test/contracts/boundary.test.ts:18-19,153-190`); `RUNTIME_EXPORTS` is checked with `include.members`.
- Throttle: key kinds and `free` (`packages/authn/src/contracts/throttle.ts:3-62`), keys built by `DefaultAuthnService.keysFor` (`packages/authn/src/service/default-authn-service.ts:533-555`), counted before verify (`:221-226`). `peek` only reports an active delay (`packages/authn/src/throttle/peek.ts:4-17`).
- `DefaultAuthnService` is `@PerChildInstance @Injectable(AuthnService) @Inject(Container)` and selects services by name with `nearestRegistration`/`instantiate` (`default-authn-service.ts:147-176,607-629`; helpers `packages/authn/src/registry/named.ts:9-35`, not in the registry barrel `registry/index.ts`).
- DI calls `resolve()` only on `AsyncService`/`SyncService` instances (`packages/di/src/container.ts:637-649`, `helpers.ts:49-51`); since `CaptchaGate` extends neither (README), the gate selects its provider lazily.
- `@Config` getters read the resolving container's Configuration on every access (`packages/configuration/src/decorators.ts:122-146`).
- `AuthnAudit` is per child, reads every `AuthnEventSink` in the lineage once at resolve, and `publish` never rejects because of a sink (`packages/authn/src/audit/authn-audit.ts:51-118`). `auditLog(name)` (`packages/authn/src/audit/log.ts`).
- Schema: `secretRef` (`packages/authn/src/schemas/authn.configuration.ts:38-45`), `stringList` (`:61`), the `mfa` `allOf`/`if`/`then` pattern (`:225-236`), `audit` block ends at `:361`, `http` starts at `:362`. A dotted `$configurationModule` is supported (`packages/users/src/authn/access-schema.ts:4-6`; `packages/configuration/src/configuration.ts:418-437`). `registerConfigurationSchema` (`packages/configuration/src/schemas.ts:11-19`); bootstrapper pattern (`packages/authn/src/service/boot/bootstrap.ts:7-12`).
- `config-defaults.test.ts:72-76` pins the defaults of the whole schema ("passes the schema unchanged"), so Task 2 edits line 75. The shipped `packages/authn/src/config/authn.ts` gets no `captcha` key (its key list is pinned at `config-defaults.test.ts:41-45`).
- Test harness: `configurationOf` (`packages/authn/test/behaviour/harness.ts:97`), `useAuthnSchema` (`:117`), `configuredChild(values, env, isolated)` (`:122`), `pinConfiguration` (`:136`), `violationPaths` (`:151`), `bind` (`:156`), `CORE_SUPPORTED` (`:13`), `buildCore`/`prepareCore` (`:195-253`), `coreHarnessOf` (`:316-353`), `useHarnessLog` (`:19`, `useTestLog` at `test/audit/test-log.ts:16`).
- Kit: `RULE_IDS` and `portNames` (`packages/authn-testing/src/behaviour/types.ts:8,16-55`), `ALL` (`behaviour/index.ts`), registry pins (`test/registry.test.ts:6,46-52,88-102`), `Harness` (`src/harness/ports.ts:9-54`), `ConfigOverrides` (`src/harness/config.ts`), `ALICE`, `NOBODY`, `IP_A`, `IP_B`, `seedUser` (`src/behaviour/steps.ts:17-47`), `FakeClock` fakes `Date` only (`src/fakes/clock.ts:6-40`), core lane facets (`packages/authn/test/behaviour/core.test.ts:11,15`), lane table (`packages/authn-testing/README.md:107-121`).
- 3.0 HTTP: `AuthnLoginController.login` (`packages/authn-http/src/v3/controllers/AuthnLoginController.ts:33-60`), `bodyField`, `boundedString`, `contextOf` (`src/v3/routes.ts:25-43`), `NO_STORE`, `authnFailureResponse` (`src/v3/responses.ts:17-27`), `notFound` (`src/policies/v3/errors.ts:19-21`), `publishAuthnEvent` loads the authn root dynamically (`src/policies/v3/audit.ts:9-15`), `ClientIp` storage (`src/api.ts:8-9`), controllers must not load the authn root at module load (`test/v3/inert.test.ts:36,131-141`).
- v3-app: `V3AppConfiguration` (`packages/authn-http/test/v3-app/app.ts:41-73`), `bind` (`:117-121`), `wire()` (`:128-145`), `config()`, `Client`, `seedUser`, `resetRecorders` (`:203-330`), runs under `.mocharc.v3-app.json`; suites registered in `test/v3-app/account.test.ts:13-31`; `ACCOUNT_ROUTES_V3` (`suites/route-table.ts:26-40`); `RecordingThrottle` always allows unless told (`packages/authn-testing/src/fakes/throttle.ts:5-25`).
- Reset: no 3.0 reset route (`packages/authn-http/src/v3/controllers/` holds five controllers); `PasswordResetController.requestReset` (`src/account/controllers/PasswordResetController.ts:63-77`) and its unit tests construct the controller directly and stub wrapped methods (`test/password-reset.test.ts:1-40`); N8c keeps it (`test/v3/route-table-n8c.test.ts:14,62-63`). It reaches `PasswordService.requestReset(user.Email, actionContext())` without an ip (`packages/users/src/actions.ts:886,920-929`).
- `NonceStore.claim(key ≤ 160 chars, expiresAt, now)`, `MemoryNonceStore`, `DbNonceStore` (`packages/authn-orm/src/nonces/nonce-store.ts:24-97`), exported from the package root (`packages/authn-orm/src/index.ts:7`); `authn-oidc` resolves it from its container (`packages/authn-oidc/src/providers.ts:5,50`) and uses global `fetch` with `AbortSignal.timeout` (`src/http/client.ts:65`).
- A DI child's own registration of a type wins over its parent's (`packages/di/src/registry.ts:82-98`), so Task 6's child `NonceStore` factory is the one resolved.
- Package scaffold: `packages/authn-keys/{package.json,.mocharc.json,tsconfig*.json}`; schema test helpers `packages/authn-totp/test/support/config-boot.ts`; root links `package.json:97-106`, `tsconfig.build.json:81-91`, `tsconfig.build.cjs.json:81-91`; `node_modules/@spinajs/authn-keys` is a link to the package; `scripts/generate-packages-for-modules.mjs` writes `lib/{cjs,mjs}/package.json`. Node is v24 (global `fetch`, `Response`, `AbortSignal.timeout`).

## Self-review

- **Spec coverage:** contract exactly as README (Task 1); `DefaultCaptchaGate` with off/always/adaptive and a cheap signal (Tasks 3–4; the throttle-state signal is rejected with reasons in Decision 2); `CaptchaProvider` with Turnstile and ALTCHA, secret refs, timeout, fail-closed with `failOpen` (Tasks 4–6; hCaptcha deferred in Decision 3); single use (Turnstile by Cloudflare, ALTCHA through `NonceStore`); new-package scaffolding and schema registration (Task 5); login wiring (Task 8, in the HTTP layer per Decision 1, so no `AuthnContext.captcha`); reset wiring (Task 9, Decision 5); answer shape with 4003xxx and 1003xxx and the widget data (Task 8); no account leak (gate never reads the account; A33 and v3-app cases test it); `captcha.fail` audit (Tasks 1, 4); `GET /auth/captcha` (Task 8); integration point for 06–08 (its own section); tests without network (fake `fetch`, stub providers).
- **Placeholder scan:** every code step holds the code. The only condition is Task 8's prerequisite on plan 03's `AuthnMessage` field names, which stops the task rather than guessing.
- **Type consistency:** `CaptchaGate.required/verify`, `CaptchaProvider.verify/client/challenge`, `CaptchaVerdict`, `CaptchaClientInfo` (Task 1) are used unchanged in Tasks 4–9; `CaptchaAdaptive` (Task 3) feeds `CaptchaSettings` (Task 4); `selectCaptchaProvider`/`configuredCaptchaProvider` (Task 4) are what Task 8 imports; `StubCaptchaProvider.solve/failNext` (Task 7) are what `CaptchaPort` and the v3-app suite call; `captchaRefusal(container, req, flow, account?, cookies?)` (Task 8) is what Task 9 and the integration section call; `KIT_CAPTCHA_PROVIDER` and `V3AppCaptchaProvider` match their `authn.captcha.provider` values.
