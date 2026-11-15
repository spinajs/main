---
"@spinajs/manifest": minor
---

`manifest:diff` reports a handler or controller class rename under an unchanged `METHOD fullPath` as a non-breaking `routes` change: `client method users.get renamed to users.read: generated hooks and query keys change`. The client name is the controller key (the class name without `Controller`, first letter lowered) and the handler name. `Change['section']` is unchanged. `controllerKey(controller)` is exported for the client generators.
