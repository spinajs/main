---
"@spinajs/orm": patch
---

`WhereBuilder.adopt(statements)` appends statements that were built on another builder. A clone of the builder copies them without rebinding them to the copy, so they keep reading the builder they were built on: its alias, the parents `outer()` walks, and the context of a `Lazy` callback.
