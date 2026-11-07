---
"@spinajs/di": patch
---

`Array.ofType(T)` returns its elements in registration order, the order of `getRegisteredTypes(T)`. Before, the collection was filled as each async element finished resolving, so a slow element registered first could come last, and the order changed from run to run. The cached collection keeps that order too.

A `resolve(X)` made while `Array.ofType(T)` is still creating `X` gets the `X` instance; before, it got the whole collection. An `Array.ofType(T)` made while a single resolve is creating one of its elements now includes that element; before, it was missing from the result.
