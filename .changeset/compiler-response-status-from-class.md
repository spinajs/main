---
"@spinajs/compiler": patch
---

The status recorded for a reply class that handles an exception (`@HandleException`) is the `_errorCode` of the class or of the nearest base that sets one, read from the source or, for a dependency, from its built JavaScript. The list of class names in the compiler is gone: a subclass that overrides `_errorCode` no longer gets its base's status, reply classes the list missed have one, and a class that only shares a name with an http reply has none. A `CodedHttpExceptionResponse` keeps no status: it answers with the status of its exception.
