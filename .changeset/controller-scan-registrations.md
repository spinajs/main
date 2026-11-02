---
"@spinajs/users-http": patch
"@spinajs/scheduler-http": patch
"@spinajs/configuration-http": patch
"@spinajs/authn-http": patch
"@spinajs/authn-oidc": patch
"@spinajs/telemetry": patch
---

The controllers a config fragment's scan imports also import what only the package entry registered: the users-http `AccountDisableHook` (self-lockout and last-holder rules), the scheduler-http 409 mapping and response schema, the configuration-http access resource, the authn-http webhook audit sink, the authn-oidc logout extension and bootstrapper, and the telemetry bootstrappers, middleware and perf sink. Brought from 3.0.26 (#484).
