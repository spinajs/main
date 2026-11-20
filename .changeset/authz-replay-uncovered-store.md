---
"@spinajs/authz-ir": patch
---

`HistoricalTupleSource` reads a kind's coverage before its first store read as well, so a kind no boot covered is a gap without a query of its store: an app on a memory assignment or tuple store whose contributor is registered gets an `unreplayable` verdict naming the kind instead of an error about a missing table. The coverage read after the history still decides.
