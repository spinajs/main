---
"@spinajs/compiler": major
---

A class is a controller, a socket controller base, a CLI command, an async service, a bootstrapper or a queue job only when it extends the framework class of that name, matched by the package that declares it. An application class named `BaseController` (or `QueueJob`, `CliCommand`, `AsyncService`, `Bootstrapper`, `BaseSocketController`) no longer counts. Breaking for code that calls the compiler's `ExtractorContext.isSubclassOf`: it takes the declaring package as a required third argument.
