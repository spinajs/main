---
"@spinajs/tenancy": patch
---

`tenancy.registryCacheMs` above 60000 is refused when the configuration loads: it bounds how long a process that missed a tenant change keeps the old record. An application that sets a larger value now fails to boot with `InvalidConfiguration` (`tenancy.registryCacheMs must be <= 60000`). Set it to 60000 or less.
