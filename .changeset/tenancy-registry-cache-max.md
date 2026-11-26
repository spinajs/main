---
"@spinajs/tenancy": patch
---

`tenancy.registryCacheMs` above 60000 is refused when the configuration loads: it bounds how long a process that missed a tenant change keeps the old record.
