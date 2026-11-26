---
"@spinajs/authz-orm": patch
---

`spinajs authz:rls`: the `down` of a generated migration turns row level security off only when no policy is left on the table. Before, it turned it off unconditionally, which left the policies of `tenant:rls` on the same table unenforced. Migration files written before this release are unchanged; regenerate them to get the new `down`.
