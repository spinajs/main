# Test ledger: @spinajs/orm-api

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md`, kept in the header below).
Rewrite-class files go to `test/legacy-v2/` in their C/N lane; the T lane
replaces them and deletes the legacy file.

- **move**: the test's code and assertions stay as they are; only the file moves to another package because the code under test moves there.
- **adapt**: the test stays (in this package, or in the package the code moves to) with mechanical edits that keep its intent and its expected values.
- **rewrite**: the test asserts 2.x authorization API or behaviour that 3.0 replaces, or 2.x authentication behaviour that an N lane redesigns; the owning lane moves the file to `test/legacy-v2/` and a T (or N) lane writes the 3.0 replacement, named in the Target column with the rule ids.
- **drop**: no 3.0 counterpart; the reason is in the Target column.

| Class | Count |
|---|---|
| move | 0 |
| adapt | 0 |
| rewrite | 0 |
| drop | 39 |
| **total** | 39 |

## test/api.get.test.ts

35 tests; dominant class drop (drop 35).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 112 | crud tests > GET > GET basic args & validation > Should validate filter param | drop | L8 | orm-api removed by L8 (H5); filter hydration is covered by orm-http `test/orm-http.test.ts` line 143 (`Should validate filter schema`) |
| 2 | 138 | crud tests > GET > GET basic args & validation > Should validate proper model | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 3 | 139 | crud tests > GET > GET basic args & validation > Should validate query args | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 4 | 140 | crud tests > GET > GET basic args & validation > Should validate query includes | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 5 | 141 | crud tests > GET > GET basic args & validation > Should fill guest user if not logged | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 6 | 145 | crud tests > GET > GET methods as guest > GET /:model should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 7 | 146 | crud tests > GET > GET methods as guest > GET /:model/:id should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 8 | 147 | crud tests > GET > GET methods as guest > GET /:model/:id/:relation should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 9 | 148 | crud tests > GET > GET methods as guest > GET /:model/:id/:relation/:id should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 10 | 150 | crud tests > GET > GET methods as guest > GET /:model | drop | L8 | orm-api removed by L8 (H5); asserts that a guest lists any model (200), the unchecked exposure of findings #59-68, which 3.0 removes |
| 11 | 162 | crud tests > GET > GET methods as guest > GET /:model/:id | drop | L8 | orm-api removed by L8 (H5); a guest reads any row by id, the same exposure (#59-68) |
| 12 | 170 | crud tests > GET > GET methods as guest > GET /:model/:id/:relation | drop | L8 | orm-api removed by L8 (H5); guest read of a relation (relation IDOR, #59-68) |
| 13 | 182 | crud tests > GET > GET methods as guest > GET /:model/:id/:relation/:id | drop | L8 | orm-api removed by L8 (H5); guest read of a related row (relation IDOR, #59-68) |
| 14 | 191 | crud tests > GET > GET methods as guest > GET /:model/:id with & include | drop | L8 | orm-api removed by L8 (H5); guest read with `includes` (#59-68) |
| 15 | 211 | crud tests > GET > GET methods as logged user > Get any > GET /:model should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 16 | 212 | crud tests > GET > GET methods as logged user > Get any > GET /:model/:id should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 17 | 213 | crud tests > GET > GET methods as logged user > Get any > GET /:model/:id/:relation should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 18 | 214 | crud tests > GET > GET methods as logged user > Get any > GET /:model/:id/:relation/:id should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 19 | 215 | crud tests > GET > GET methods as logged user > Get any > GET /:model/:id with & include should return forbidden  | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 20 | 217 | crud tests > GET > GET methods as logged user > Get any > GET /:model | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 21 | 218 | crud tests > GET > GET methods as logged user > Get any > GET /:model/:id | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 22 | 219 | crud tests > GET > GET methods as logged user > Get any > GET /:model/:id/:relation | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 23 | 220 | crud tests > GET > GET methods as logged user > Get any > GET /:model/:id/:relation/:id | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 24 | 224 | crud tests > GET > GET methods as logged user > Get own > GET /:model should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 25 | 225 | crud tests > GET > GET methods as logged user > Get own > GET /:model/:id should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 26 | 226 | crud tests > GET > GET methods as logged user > Get own > GET /:model/:id/:relation should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 27 | 227 | crud tests > GET > GET methods as logged user > Get own > GET /:model/:id/:relation/:id should return forbidden | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 28 | 228 | crud tests > GET > GET methods as logged user > Get own > GET /:model/:id with & include should return forbidden  | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 29 | 230 | crud tests > GET > GET methods as logged user > Get own > GET /:model | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 30 | 231 | crud tests > GET > GET methods as logged user > Get own > GET /:model/:id | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 31 | 232 | crud tests > GET > GET methods as logged user > Get own > GET /:model/:id/:relation | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 32 | 233 | crud tests > GET > GET methods as logged user > Get own > GET /:model/:id/:relation/:id | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 33 | 234 | crud tests > GET > GET methods as logged user > Get own > GET /:model/:id with & include | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 34 | 236 | crud tests > GET > GET methods as logged user > Get own > GET /:model should be filtered | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |
| 35 | 237 | crud tests > GET > GET methods as logged user > Get own > GET /:model/:id/:relation should be filtered | drop | L8 | orm-api removed by L8 (H5); empty placeholder body, asserts nothing |

## test/compositeKey.test.ts

2 tests; dominant class drop (drop 2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 27 | orm-api composite key handling > rejects a composite-key model on a single-id route | drop | L8 | orm-api removed by L8 (H5); `_assertSingleColumnKey` guards the removed `/:model/:id` routes only |
| 2 | 31 | orm-api composite key handling > returns the key column for a single-key model | drop | L8 | orm-api removed by L8 (H5); `_assertSingleColumnKey` guards the removed `/:model/:id` routes only |

## test/orm-http.test.ts

2 tests; dominant class drop (drop 2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 45 | Http orm tests > query params > simple query | drop | L8 | orm-api removed by L8 (H5); the same two cases (`simple query`, `should hydrate data to model`) live in orm-http `orm-http.test.ts`, which keeps them |
| 2 | 54 | Http orm tests > query params > should hydrate data to model | drop | L8 | orm-api removed by L8 (H5); the same two cases (`simple query`, `should hydrate data to model`) live in orm-http `orm-http.test.ts`, which keeps them |
