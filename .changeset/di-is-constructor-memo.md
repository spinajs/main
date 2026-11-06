---
"@spinajs/di": patch
---

`isConstructor` answers `false` for a value that is not a function without the throwing `Reflect.construct` probe, and probes each function once: the container asks about the same factories on every resolve. The answers do not change.
