---
"@spinajs/testing": minor
---

New package in 4.0: boots an isolated SpinaJS instance per test. `createTestApp()` (`root` or `child` scope, `bootTimeout`, `name`), `useTestApp()` (hooks that derive `bootTimeout` from the mocha timeout) and `disposeTestApps()` (disposes every live app, then rethrows the first error).
