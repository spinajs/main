---
'@spinajs/compiler': minor
---

The compiler reads `@spinajs <role> [value]` JSDoc markers that framework packages put on their own declarations (`declarationMarker`, `symbolMarker`, `typeMarker`; `markedType` also returns the declaration that carries a type's marker and the type arguments the type gives it through its bases), and tells awaitable and async-iterable types (`isAwaitable`, `isAsyncIterable`).
