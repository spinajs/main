---
"@spinajs/compiler": patch
---

`@AutoinjectNamedService` and `@AutoinjectNamedServices` are recorded like `@AutoinjectService`: the injected type is a property injection of its service (doctor `DI001` when nothing registers a class for it, unless the injection is optional or a list), and the path is a configuration usage (doctor `CFG001` when no schema declares its module).
