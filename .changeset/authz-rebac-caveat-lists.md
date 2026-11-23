---
"@spinajs/authz-rebac": minor
---

Conditional tuples in lists, row level security and the admin API (Bet 6 Z5b). `.accessible()` plans evaluate each caveat once for the request and keep only the tuples whose caveat holds (`rebac.tuples` leaves gain `conditional` groups keyed by `caveat_key`). A plan that read env is not reused. Row level security cannot read the request, so a permission that reaches a relation with conditional subject types is AUTHZ020 under `rls: true`, and widened to TRUE (AUTHZ021) under `rls: 'partial'`. `tuple.write` takes `caveat`; giving a stored tuple another caveat fails with `caveat_conflict` (delete and write it in one batch instead); a context that does not fit the caveat's parameters fails with `invalid_caveat_context`. `TupleChanged` events carry the caveat.
