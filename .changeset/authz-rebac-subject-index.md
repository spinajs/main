---
"@spinajs/authz-rebac": minor
---

New migration `AuthzRebacSubjectIndex_2026_11_26_00_00_00` on the `authz` connection: the index `authz_rebac_tuple_subject_object` on `authz_rebac_tuple (subject_type, subject_id)`. It serves the subject side of `scope.forget` (`DbTupleStore.withSubjectObject`), which runs on every delete of an `@AccessResource` row; without it each forget scans the whole tuple table (about 100 ms at a million tuples on PostgreSQL, under 1 ms with the index). Run `npx spinajs migrate-up`. On a large PostgreSQL table, build the index by hand first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS authz_rebac_tuple_subject_object ON authz_rebac_tuple (subject_type, subject_id)` to keep writes going; the migration then finds it and leaves it alone.
