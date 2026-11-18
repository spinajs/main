---
"@spinajs/http": minor
---

New port `IdempotencyScopePart`: every registered one reads a part from `req.storage` (or a socket connection's context) and adds it to the scope of an `@Idempotent` key, on the claim and on the replay before the policies. Without a registered part, or when none answers for a request, the key is unchanged.
