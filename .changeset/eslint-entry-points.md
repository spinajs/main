---
"@spinajs/eslint-plugin-authz": major
---

`require-accessible` exempts only queries inside `runAs(SYSTEM, reason)`: a `runAs` of any other principal reads only what that principal may, so its queries still need `.accessible()` or `.unscoped(reason)`. `legacyRunAsExemption: true` restores the exemption of every `runAs` callback until 5.0.

New rules, the one-file editor path to the compiler's doctor findings: `require-socket-access` (a `@Command` or `@OnEvent` with no `@SocketAccess`, `@SocketPolicy` or `@SocketPolicyGroup` on it or on its class; `error` in `configs.recommended`) and `require-handler-access` (a queue job with neither `@Job({ access })` nor `@SystemTask(reason)`; `warn` in `configs.recommended`).
