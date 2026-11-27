---
"@spinajs/authz-rebac": patch
---

The request memo of tuple reads keeps a read only once it settled, and only while the model's version (tuple changes, `rebac`, `rebac:<namespace>`, `model:<name>`, `*`) has not moved. With the ORM's savepoint queue, a check inside a nested `transaction()` that awaited the read another check of the same request had started beside it, over `DbTupleStore`, never settled. One check still shares its own reads while they run. A failed read is no longer kept (before, every later check of the request failed with it), and a tuple read before an invalidate no longer answers the request's later checks. Cost: 10 concurrent checks of one request read each tuple 10 times instead of once; once a read settled, the rest of the request reads nothing.
