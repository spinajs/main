---
"@spinajs/authn-http": patch
---

Login, logout and whoami are marked `@Public`, so `spinajs doctor` no longer reports them as routes without a policy.
