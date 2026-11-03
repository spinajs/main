---
"@spinajs/configuration": patch
---

The boot warns, naming the class, about a `JsFileSource` or `JsonFileSource` subclass that overrides `Load()` but not `LoadLayers()`. The boot calls `LoadLayers()` of a file source, so such a `Load()` (a 3.x way to decrypt values, say) was skipped in silence.
