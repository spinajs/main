---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
"@spinajs/asyncapi": minor
---

The manifest gains an optional `workflows` section (`WorkflowEntry`: name, version, class, the signals `run()` waits for with their permissions), filled by the compiler from `@Workflow` classes; `manifest:diff` reports added, removed (breaking) and changed workflow versions (`class changed`; `signals changed`, breaking when a signal is removed or newly needs a permission). `spinajs doctor` adds `WF001` (two classes declare one name and version), `WF002` (a permissioned signal with no `SignalAuthorizer` besides `DenyAllSignalAuthorizer`) and `WF003` (more than three registered versions); the compiler warns with `WF004` about `Date.now()`, `new Date()` and `Math.random()` in `run()` outside a step, and with `WF005` about a literal event name containing `#` or `*`, which `waitForEvent` refuses (the signal is left out), and with `WF006` about a `@Workflow` whose name or version cannot be read (the class is left out). The AsyncAPI document lists each signal as a `workflow/<name>/<signal>` channel with `x-spinajs-permission`; characters other than letters, digits, `_`, `:` and `-` in those names are written as `$<hex>;`, and message `$ref`s are escaped as JSON pointers.
