---
"@spinajs/authz-rebac": patch
---

`scope.forget` also removes the tuples whose subject is the forgotten node or one of its subject sets, wherever they are held (as RBAC removes grants held by sets at the node). Before, such tuples stayed, and an object that later reused the id inherited them. New: `MemoryTupleStore.withSubjectObject(ref)` and `DbTupleStore.withSubjectObject(ref)`. Behaviour change for 3.x users of `scope.forget`: it removes more.
