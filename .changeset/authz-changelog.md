---
"@spinajs/authz": minor
"@spinajs/authz-orm": minor
"@spinajs/authz-rebac": minor
---

Authz state gets a changelog. `@spinajs/authz` adds the `ChangeLog` port (`append`, `since(seq)`, `until(at)`, `covers(kind)`, `track(kind)`; kinds `tuple`, `assignment`, `membership`, `rule`, `policy`, `attribute`, `column`) and `changeLog()`, which answers the registered log or a `NoChangeLog` that records nothing and covers nothing. `@spinajs/authz-orm` registers `DbChangeLog` over the new table `authz_change_log` (migration `AuthzChangeLog_2026_11_04_00_00_00` on the `authz` connection, which also creates `authz_policy_version`); it appends only inside a transaction on that connection, so a change commits or rolls back with the write it records, and it stamps each row with the actor and the request's trace id. `DbTupleStore` of `@spinajs/authz-rebac` records every tuple it adds or removes. Run the authz-orm migrations after upgrading: a DB tuple write fails without the table.
