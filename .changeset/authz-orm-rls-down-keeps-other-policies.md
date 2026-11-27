---
"@spinajs/authz-orm": patch
---

`spinajs authz:rls`: the `down` of a generated migration turns row level security off only when no policy is left on the table. Before, it turned it off unconditionally, so other policies of the same table, such as tenant isolation policies (the `tenant:rls` command, when installed), stayed in place but unenforced: every tenant could read every other tenant's rows of that table. Migration files written before this release keep the old `down`; regenerate them before you roll one back. If you have ever rolled back an `authz:rls` migration (`spinajs migrate-down`), run the query below on every database: it lists, in every schema, the tables that have policies while row level security or its FORCE is off. On each listed table whose policies come from `authz:rls` or tenant isolation, run `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY; ALTER TABLE <table> FORCE ROW LEVEL SECURITY;`.

```sql
SELECT format('%I.%I', n.nspname, c.relname) AS table_name, c.relrowsecurity, c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity) AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid);
```
